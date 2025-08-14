const { TRANSACTION_TAGS } = require('../utils/constants');
const logger = require('../utils/logger');

const { Transaction, TransactionInput, TransactionOutput } = require('./Transaction');

/**
 * Transaction Manager - Handles transaction validation and management
 */
class TransactionManager {
  /**
   *
   * @param utxoManager
   * @param spamProtection
   * @param memoryPool
   */
  constructor(utxoManager, spamProtection, memoryPool) {
    this.utxoManager = utxoManager;
    this.spamProtection = spamProtection;
    this.memoryPool = memoryPool;
  }

  /**
   * Add transaction to pending pool with MANDATORY replay attack protection and SPAM PROTECTION
   * @param transaction
   */
  addPendingTransaction(transaction) {
    // Convert JSON transaction to Transaction instance if needed
    let transactionInstance = transaction;
    if (typeof transaction === 'object' && !transaction.isValid) {
      try {
        transactionInstance = Transaction.fromJSON(transaction);
      } catch (error) {
        logger.error('TRANSACTION_MANAGER', `Failed to convert transaction to Transaction instance: ${error.message}`);
        return false;
      }
    }

    // MANDATORY PROTECTION: Reject ALL transactions without replay protection (except coinbase)
    if (!transactionInstance.isCoinbase && (!transactionInstance.nonce || !transactionInstance.expiresAt)) {
      logger.error(
        'TRANSACTION_MANAGER',
        `Transaction ${transactionInstance.id} REJECTED: Missing mandatory replay protection`
      );
      logger.error('TRANSACTION_MANAGER', 'ALL transactions must include nonce and expiration fields');
      logger.error('TRANSACTION_MANAGER', 'Use Transaction.createTransaction() to create protected transactions');
      return false;
    }

    // SPAM PROTECTION: Check global rate limit
    if (this.spamProtection.isGlobalRateLimitExceeded(this.memoryPool.getPendingTransactions())) {
      logger.warn('TRANSACTION_MANAGER', `Transaction ${transactionInstance.id} REJECTED: Global rate limit exceeded`);
      return false;
    }

    // SPAM PROTECTION: Check address-specific rate limit
    if (!transactionInstance.isCoinbase) {
      // Extract sender address from inputs
      const senderAddresses = transactionInstance.inputs
        .map(input => {
          // Find the UTXO to get the address
          const utxo = this.utxoManager.findUTXO(input.txHash, input.outputIndex);
          return utxo ? utxo.address : null;
        })
        .filter(addr => addr !== null);

      // Check if any sender address is rate limited
      for (const senderAddress of senderAddresses) {
        if (!this.spamProtection.isAddressAllowedToSubmit(senderAddress)) {
          logger.warn(
            'TRANSACTION_MANAGER',
            `Transaction ${transactionInstance.id} REJECTED: Address ${senderAddress} rate limited for spam`
          );
          return false;
        }
      }
    }

    // Check if transaction already exists
    if (this.memoryPool.hasTransaction(transactionInstance.id)) {
      logger.warn('TRANSACTION_MANAGER', 'Transaction already exists in pending pool');
      return false;
    }

    // REPLAY ATTACK PROTECTION: Check if transaction has expired
    if (transactionInstance.isExpired && typeof transactionInstance.isExpired === 'function') {
      if (transactionInstance.isExpired()) {
        logger.warn('TRANSACTION_MANAGER', `Transaction ${transactionInstance.id} has expired and cannot be added`);
        return false;
      }
    }

    // REPLAY ATTACK PROTECTION: Check for duplicate nonces from same sender in pending pool
    if (transactionInstance.isReplayAttack && typeof transactionInstance.isReplayAttack === 'function') {
      if (transactionInstance.isReplayAttack(this.memoryPool.getPendingTransactions())) {
        logger.warn(
          'TRANSACTION_MANAGER',
          `Transaction ${transactionInstance.id} detected as replay attack in pending pool`
        );
        return false;
      }
    }

    // CRITICAL: REPLAY ATTACK PROTECTION against historical blockchain
    // This requires access to the blockchain instance, so we'll need to pass it
    // For now, we'll handle this at the blockchain level when adding transactions

    if (transactionInstance.isValid()) {
      this.memoryPool.addTransaction(transactionInstance);
      logger.info(
        'TRANSACTION_MANAGER',
        `Transaction ${transactionInstance.id} added to pending pool with mandatory replay protection and spam protection`
      );
      return true;
    }

    logger.warn('TRANSACTION_MANAGER', 'Invalid transaction, not added to pending pool');
    return false;
  }

  /**
   * Validate individual transaction including UTXO checks
   * @param transaction
   */
  validateTransaction(transaction) {
    try {
      // Basic transaction validation
      if (!transaction || !transaction.id) {
        return { valid: false, reason: 'Invalid transaction structure' };
      }

      // Check if transaction is expired
      if (transaction.isExpired && transaction.isExpired()) {
        return { valid: false, reason: 'Transaction has expired' };
      }

      // Validate outputs
      if (!transaction.outputs || transaction.outputs.length === 0) {
        return { valid: false, reason: 'Transaction has no outputs' };
      }

      // Calculate total output amount
      const totalOutputAmount = transaction.outputs.reduce((sum, output) => sum + (output.amount || 0), 0);
      if (totalOutputAmount <= 0) {
        return { valid: false, reason: 'Transaction output amount must be positive' };
      }

      // For non-coinbase transactions, validate inputs and UTXOs
      if (!transaction.isCoinbase) {
        if (!transaction.inputs || transaction.inputs.length === 0) {
          return { valid: false, reason: 'Non-coinbase transaction must have inputs' };
        }

        // Calculate total input amount from UTXOs
        let totalInputAmount = 0;
        for (const input of transaction.inputs) {
          const utxo = this.utxoManager.findUTXO(input.txHash, input.outputIndex);
          if (!utxo) {
            return { valid: false, reason: `Input UTXO not found: ${input.txHash}:${input.outputIndex}` };
          }

          // Check if UTXO is already spent
          if (this.utxoManager.isUTXOSpent(input.txHash, input.outputIndex)) {
            return { valid: false, reason: `UTXO already spent: ${input.txHash}:${input.outputIndex}` };
          }

          totalInputAmount += utxo.amount;
        }

        // Validate input/output balance (input must cover output + fee)
        if (totalInputAmount < totalOutputAmount + transaction.fee) {
          return {
            valid: false,
            reason: `Insufficient input amount. Input: ${totalInputAmount}, Output: ${totalOutputAmount}, Fee: ${transaction.fee}`,
          };
        }
      }

      return { valid: true, reason: 'Transaction validation passed' };
    } catch (error) {
      logger.error('TRANSACTION_MANAGER', `Transaction validation error: ${error.message}`);
      return { valid: false, reason: `Validation error: ${error.message}` };
    }
  }

  /**
   * Create transaction
   * @param fromAddress
   * @param toAddress
   * @param amount
   * @param fee
   * @param tag
   */
  createTransaction(fromAddress, toAddress, amount, fee = 0.001, tag = TRANSACTION_TAGS.TRANSACTION) {
    // Users can only create TRANSACTION tagged transactions
    if (tag !== TRANSACTION_TAGS.TRANSACTION) {
      throw new Error('Users can only create TRANSACTION tagged transactions. Other tags are reserved for system use.');
    }

    const utxos = this.utxoManager.getUTXOsForAddress(fromAddress);
    const totalAvailable = utxos.reduce((sum, utxo) => sum + utxo.amount, 0);

    if (totalAvailable < amount + fee) {
      throw new Error('Insufficient balance');
    }

    // Select UTXOs to spend
    let selectedAmount = 0;
    const selectedUtxos = [];

    for (const utxo of utxos) {
      selectedUtxos.push(utxo);
      selectedAmount += utxo.amount;
      if (selectedAmount >= amount + fee) break;
    }

    // Create inputs
    const inputs = selectedUtxos.map(
      utxo => new TransactionInput(utxo.txHash, utxo.outputIndex, '', '') // Signature will be added later
    );

    // Create outputs
    const outputs = [new TransactionOutput(toAddress, amount)];

    // Add change output if needed
    const change = selectedAmount - amount - fee;
    if (change > 0) {
      outputs.push(new TransactionOutput(fromAddress, change));
    }

    // Create transaction with tag (automatically includes replay protection)
    const transaction = new Transaction(inputs, outputs, fee, tag, Date.now());

    // Verify replay protection fields are present
    if (!transaction.nonce || !transaction.expiresAt) {
      throw new Error('Transaction creation failed: Missing replay protection fields');
    }

    transaction.calculateId();
    return transaction;
  }

  /**
   * Batch transaction addition
   * @param transactions
   */
  addTransactionBatch(transactions) {
    const validationResults = this.memoryPool.validateTransactionBatch(transactions);
    let addedCount = 0;

    // Add all valid transactions
    for (const tx of validationResults.valid) {
      if (this.addPendingTransaction(tx)) {
        addedCount++;
      }
    }

    // Log results
    if (validationResults.valid.length > 0 || validationResults.invalid.length > 0) {
      logger.info(
        'TRANSACTION_MANAGER',
        `Batch transaction processing: ${validationResults.valid.length} valid, ${validationResults.invalid.length} invalid`
      );

      if (validationResults.errors.length > 0) {
        logger.warn(
          'TRANSACTION_MANAGER',
          `Batch validation errors: ${validationResults.errors.slice(0, 5).join(', ')}${validationResults.errors.length > 5 ? '...' : ''}`
        );
      }
    }

    return {
      added: addedCount,
      valid: validationResults.valid.length,
      invalid: validationResults.invalid.length,
      errors: validationResults.errors,
    };
  }
}

module.exports = TransactionManager;
