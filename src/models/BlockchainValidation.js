const logger = require('../utils/logger');

/**
 * Blockchain Validation - Handles all blockchain validation methods
 */
class BlockchainValidation {
  constructor() {}

  /**
   * Validate block transactions including coinbase validation
   */
  validateBlockTransactions(block, config) {
    try {
      // Ensure first transaction is coinbase and no others are
      if (block.transactions.length > 0) {
        const firstTx = block.transactions[0];
        if (!firstTx.isCoinbase) {
          return { valid: false, reason: 'First transaction must be coinbase' };
        }
      }

      for (let i = 0; i < block.transactions.length; i++) {
        const transaction = block.transactions[i];
        
        if (i === 0 && !transaction.isCoinbase) {
          return { valid: false, reason: 'First transaction must be coinbase' };
        }
        if (i > 0 && transaction.isCoinbase) {
          return { valid: false, reason: 'Only first transaction can be coinbase' };
        }
      }

      // Calculate total fees from non-coinbase transactions
      let totalFees = 0;
      for (let i = 1; i < block.transactions.length; i++) {
        const transaction = block.transactions[i];
        if (transaction.fee && typeof transaction.fee === 'number') {
          totalFees += transaction.fee;
        }
      }

      // Validate coinbase amount (base reward + fees)
      if (block.transactions.length > 0) {
        const coinbaseTransaction = block.transactions[0];
        const actualCoinbaseAmount = coinbaseTransaction.outputs.reduce((sum, output) => sum + output.amount, 0);
        const expectedBaseReward = config?.blockchain?.coinbaseReward || 50;
        const expectedTotalAmount = expectedBaseReward + totalFees;

        // Allow small floating-point tolerance
        const tolerance = 0.00000001;
        if (Math.abs(actualCoinbaseAmount - expectedTotalAmount) > tolerance) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block ${block.index} coinbase manipulation detected!`);
          logger.error('BLOCKCHAIN_VALIDATION', `Expected: ${expectedBaseReward} (base) + ${totalFees} (fees) = ${expectedTotalAmount}`);
          logger.error('BLOCKCHAIN_VALIDATION', `Actual: ${actualCoinbaseAmount}`);
          return { 
            valid: false, 
            reason: `Coinbase amount manipulation: expected ${expectedTotalAmount}, got ${actualCoinbaseAmount}` 
          };
        }
      }

      // Validate all non-coinbase transactions
      for (let i = 1; i < block.transactions.length; i++) {
        const transaction = block.transactions[i];
        if (!transaction.isValid()) {
          return { valid: false, reason: `Transaction ${i} validation failed` };
        }
      }

      return { valid: true, reason: 'Block transactions validation passed' };

    } catch (error) {
      logger.error('BLOCKCHAIN_VALIDATION', `Block transactions validation error: ${error.message}`);
      return { valid: false, reason: `Validation error: ${error.message}` };
    }
  }

  /**
   * Check if block is valid
   */
  isValidBlock(block, config) {
    try {
      // Basic block validation
      if (!block || !block.index || !block.timestamp || !block.previousHash || !block.hash) {
        return false;
      }

      // Validate block structure
      if (!block.isValid || typeof block.isValid !== 'function') {
        return false;
      }

      if (!block.isValid()) {
        return false;
      }

      // Validate block transactions (except genesis)
      if (block.index > 0) {
        const validationResult = this.validateBlockTransactions(block, config);
        if (!validationResult.valid) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block ${block.index} REJECTED: ${validationResult.reason}`);
          return false;
        }
      }

      return true;

    } catch (error) {
      logger.error('BLOCKCHAIN_VALIDATION', `Block validation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Validate entire blockchain
   */
  isValidChain(chain, config) {
    try {
      if (!chain || !Array.isArray(chain) || chain.length === 0) {
        return false;
      }

      logger.info('BLOCKCHAIN_VALIDATION', `Validating blockchain with ${chain.length} blocks...`);

      // Validate genesis block
      const genesisBlock = chain[0];
      if (genesisBlock.index !== 0 || genesisBlock.previousHash !== '0') {
        logger.error('BLOCKCHAIN_VALIDATION', 'Genesis block validation failed');
        return false;
      }

      if (!this.isValidBlock(genesisBlock, config)) {
        logger.error('BLOCKCHAIN_VALIDATION', 'Genesis block structure validation failed');
        return false;
      }

      // Validate all other blocks
      for (let i = 1; i < chain.length; i++) {
        const currentBlock = chain[i];
        const previousBlock = chain[i - 1];

        // Check block linking
        if (currentBlock.previousHash !== previousBlock.hash) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block ${i} is not properly linked to previous block`);
          return false;
        }

        // Check block index sequence
        if (currentBlock.index !== previousBlock.index + 1) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block index sequence broken at index ${i}`);
          return false;
        }

        // Validate block structure and transactions
        if (!this.isValidBlock(currentBlock, config)) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block ${i} validation failed`);
          return false;
        }

        // Show progress for large chains
        if (chain.length > 100 && i % Math.floor(chain.length / 10) === 0) {
          const progress = ((i / chain.length) * 100).toFixed(1);
          logger.info('BLOCKCHAIN_VALIDATION', `Validation progress: ${i}/${chain.length} blocks (${progress}%)`);
        }
      }

      logger.info('BLOCKCHAIN_VALIDATION', 'Blockchain validation completed successfully');
      return true;

    } catch (error) {
      logger.error('BLOCKCHAIN_VALIDATION', `Blockchain validation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Fast validation that skips expensive operations
   */
  isValidChainFast(chain) {
    try {
      if (!chain || !Array.isArray(chain) || chain.length === 0) {
        return false;
      }

      logger.info('BLOCKCHAIN_VALIDATION', `Fast validation for ${chain.length} blocks (skipping expensive checks)...`);

      // Validate genesis block (basic checks only)
      const genesisBlock = chain[0];
      if (!genesisBlock || genesisBlock.index !== 0 || genesisBlock.previousHash !== '0') {
        logger.error('BLOCKCHAIN_VALIDATION', 'Genesis block basic validation failed');
        return false;
      }

      // Use Set for O(1) duplicate detection
      const seenHashes = new Set([genesisBlock.hash]);

      // Fast validation: only check chain integrity, not block proofs
      for (let i = 1; i < chain.length; i++) {
        const currentBlock = chain[i];
        const previousBlock = chain[i - 1];

        // Basic block existence check
        if (!currentBlock || !previousBlock) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block missing at index ${i}`);
          return false;
        }

        // Check index sequence
        if (currentBlock.index !== previousBlock.index + 1) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block index sequence broken at index ${i}`);
          return false;
        }

        // Check for duplicates (O(1) operation)
        if (seenHashes.has(currentBlock.hash)) {
          logger.error('BLOCKCHAIN_VALIDATION', `Duplicate block hash found at index ${i}`);
          return false;
        }
        seenHashes.add(currentBlock.hash);

        // Check chain linking (most important)
        if (currentBlock.previousHash !== previousBlock.hash) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block at index ${i} is not properly linked`);
          return false;
        }

        // SKIP expensive operations:
        // - block.isValid() (KawPow verification)
        // - Transaction validation
        // - Merkle root verification
        // - Hash difficulty verification
      }

      logger.info('BLOCKCHAIN_VALIDATION', 'Fast validation completed successfully');
      return true;

    } catch (error) {
      logger.error('BLOCKCHAIN_VALIDATION', `Fast validation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Ultra-fast validation for very large chains
   */
  isValidChainUltraFast(chain) {
    try {
      if (!chain || !Array.isArray(chain) || chain.length === 0) {
        return false;
      }

      logger.info('BLOCKCHAIN_VALIDATION', `Ultra-fast validation for ${chain.length} blocks (minimal checks)...`);

      // Only validate chain integrity, nothing else
      for (let i = 1; i < chain.length; i++) {
        const currentBlock = chain[i];
        const previousBlock = chain[i - 1];

        // Minimal linking check only
        if (currentBlock.previousHash !== previousBlock.hash) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block at index ${i} is not properly linked`);
          return false;
        }
      }

      logger.info('BLOCKCHAIN_VALIDATION', 'Ultra-fast validation completed successfully');
      return true;

    } catch (error) {
      logger.error('BLOCKCHAIN_VALIDATION', `Ultra-fast validation error: ${error.message}`);
      return false;
    }
  }
}

module.exports = BlockchainValidation;
