const CryptoUtils = require('../utils/crypto');
const { TRANSACTION_TAGS } = require('../utils/constants');

class TransactionInput {
  constructor(txId, outputIndex, signature, publicKey) {
    this.txId = txId;               // Hash of the transaction containing the UTXO
    this.outputIndex = outputIndex; // Index of the output in the previous transaction
    this.signature = signature;     // Signature proving ownership
    this.publicKey = publicKey;     // Public key of the owner
  }

  toJSON() {
    return {
      txId: this.txId,
      outputIndex: this.outputIndex,
      signature: this.signature,
      publicKey: this.publicKey
    };
  }

  static fromJSON(data) {
    try {
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid transaction input data: data is not an object');
      }
      
      if (typeof data.txId !== 'string') {
        throw new Error('Invalid transaction input data: txId is not a string');
      }
      
      if (typeof data.outputIndex !== 'number') {
        throw new Error('Invalid transaction input data: outputIndex is not a number');
      }
      
      if (typeof data.signature !== 'string') {
        throw new Error('Invalid transaction input data: signature is not a string');
      }
      
      if (typeof data.publicKey !== 'string') {
        throw new Error('Invalid transaction input data: publicKey is not a string');
      }
      
      return new TransactionInput(
        data.txId,
        data.outputIndex,
        data.signature,
        data.publicKey
      );
    } catch (error) {
      throw new Error(`Failed to create transaction input from JSON: ${error.message}`);
    }
  }
}

class TransactionOutput {
  constructor(address, amount, scriptPubKey = '') {
    this.address = address;     // Recipient address
    this.amount = amount;       // Amount in PAS
    this.scriptPubKey = scriptPubKey || `OP_DUP OP_HASH160 ${address} OP_EQUALVERIFY OP_CHECKSIG`;
  }

  toJSON() {
    return {
      address: this.address,
      amount: this.amount,
      scriptPubKey: this.scriptPubKey
    };
  }

  static fromJSON(data) {
    try {
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid transaction output data: data is not an object');
      }
      
      if (typeof data.address !== 'string') {
        throw new Error('Invalid transaction output data: address is not a string');
      }
      
      if (typeof data.amount !== 'number') {
        throw new Error('Invalid transaction output data: amount is not a number');
      }
      
      return new TransactionOutput(
        data.address,
        data.amount,
        data.scriptPubKey || ''
      );
    } catch (error) {
      throw new Error(`Failed to create transaction output from JSON: ${error.message}`);
    }
  }
}

class Transaction {
  constructor(inputs = [], outputs = [], fee = 0, tag = TRANSACTION_TAGS.TRANSACTION) {
    this.id = null;                    // Transaction hash
    this.inputs = inputs;              // Array of TransactionInput
    this.outputs = outputs;            // Array of TransactionOutput
    this.fee = fee;                    // Transaction fee
    this.timestamp = Date.now();       // Transaction timestamp
    this.isCoinbase = false;           // Whether this is a coinbase transaction
    this.tag = tag;                    // Transaction tag (STAKING, GOVERNANCE, COINBASE, TRANSACTION, PREMINE)
    
    // REPLAY ATTACK PROTECTION
    this.nonce = this.generateNonce(); // Unique nonce for replay protection
    this.expiresAt = this.timestamp + (24 * 60 * 60 * 1000); // 24 hour expiration
    this.sequence = 0;                 // Sequence number for input ordering
  }

  /**
   * Generate unique nonce for replay attack protection
   */
  generateNonce() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + Math.random().toString(36).substr(2);
  }

  /**
   * Calculate transaction hash with replay attack protection
   */
  calculateId() {
    const data = JSON.stringify({
      inputs: this.inputs.map(input => ({
        txId: input.txId,
        outputIndex: input.outputIndex,
        publicKey: input.publicKey
      })),
      outputs: this.outputs.map(output => ({
        address: output.address,
        amount: output.amount
      })),
      fee: this.fee,
      timestamp: this.timestamp,
      isCoinbase: this.isCoinbase,
      tag: this.tag,
      nonce: this.nonce,           // Include nonce for replay protection
      expiresAt: this.expiresAt,   // Include expiration for replay protection
      sequence: this.sequence      // Include sequence for input ordering
    });
    
    this.id = CryptoUtils.doubleHash(data);
    return this.id;
  }

  /**
   * Get data to sign for transaction with replay attack protection
   */
  getDataToSign() {
    return JSON.stringify({
      inputs: this.inputs.map(input => ({
        txId: input.txId,
        outputIndex: input.outputIndex
      })),
      outputs: this.outputs.map(output => ({
        address: output.address,
        amount: output.amount
      })),
      fee: this.fee,
      tag: this.tag,
      timestamp: this.timestamp,
      isCoinbase: this.isCoinbase,
      nonce: this.nonce,           // Include nonce in signature
      expiresAt: this.expiresAt,   // Include expiration in signature
      sequence: this.sequence      // Include sequence in signature
    });
  }

  /**
   * Sign transaction inputs
   */
  sign(privateKey) {
    const dataToSign = this.getDataToSign();
    this.inputs.forEach(input => {
      input.signature = CryptoUtils.sign(dataToSign, privateKey);
    });
  }

  /**
   * Verify transaction signatures
   */
  verify() {
    if (this.isCoinbase) return true;

    return this.inputs.every(input => {
      const dataToSign = this.getDataToSign();
      return CryptoUtils.verify(dataToSign, input.signature, input.publicKey);
    });
  }

  /**
   * Check if transaction has expired (replay attack protection)
   */
  isExpired() {
    return Date.now() > this.expiresAt;
  }

  /**
   * Check if transaction is valid and not expired
   */
  isValidAndNotExpired() {
    if (this.isExpired()) {
      return false;
    }
    return this.verify();
  }

  /**
   * Get replay attack protection info
   */
  getReplayProtectionInfo() {
    return {
      nonce: this.nonce,
      expiresAt: this.expiresAt,
      sequence: this.sequence,
      isExpired: this.isExpired(),
      timeUntilExpiry: Math.max(0, this.expiresAt - Date.now())
    };
  }

  /**
   * Check if this transaction is a replay of another transaction
   * @param {Array} existingTransactions - Array of existing transactions to check against
   * @returns {boolean} - True if this is a replay attack
   */
  isReplayAttack(existingTransactions) {
    if (!existingTransactions || !Array.isArray(existingTransactions)) {
      return false;
    }
    
    // Check for duplicate nonce (same sender, same nonce = replay attack)
    const duplicateNonce = existingTransactions.find(tx => 
      tx.id !== this.id && 
      tx.nonce === this.nonce &&
      this.hasSameSender(tx)
    );
    
    if (duplicateNonce) {
      return true;
    }
    
    // Check for duplicate transaction ID (exact same transaction)
    const duplicateId = existingTransactions.find(tx => tx.id === this.id);
    if (duplicateId) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if this transaction has the same sender as another transaction
   * @param {Transaction} otherTx - Transaction to compare with
   * @returns {boolean} - True if same sender
   */
  hasSameSender(otherTx) {
    if (!otherTx || !otherTx.inputs || !this.inputs) {
      return false;
    }
    
    // Compare public keys from inputs to determine if same sender
    const thisPublicKeys = this.inputs.map(input => input.publicKey).sort();
    const otherPublicKeys = otherTx.inputs.map(input => input.publicKey).sort();
    
    if (thisPublicKeys.length !== otherPublicKeys.length) {
      return false;
    }
    
    return thisPublicKeys.every((pk, index) => pk === otherPublicKeys[index]);
  }

  /**
   * Calculate total input amount
   */
  getInputAmount() {
    if (this.isCoinbase) return 0;
    
    return this.inputs.reduce((total, input) => {
      // This would normally look up the actual UTXO amount
      // For now, we'll assume a default value for non-coinbase transactions
      return total + 50; // Assume each input is worth 50 PAS (mining reward)
    }, 0);
  }

  /**
   * Calculate total output amount
   */
  getOutputAmount() {
    return this.outputs.reduce((total, output) => total + output.amount, 0);
  }

  /**
   * Check if transaction is valid with MANDATORY replay attack protection
   */
  isValid(config = null) {
    if (this.outputs.length === 0) return false;
    
    // MANDATORY PROTECTION: ALL non-coinbase transactions must have replay protection
    if (!this.isCoinbase && (!this.nonce || !this.expiresAt)) {
      return false; // Reject unprotected transactions
    }
    
    // REPLAY ATTACK PROTECTION: Check if transaction has expired
    if (this.isExpired()) {
      return false;
    }
    
    if (!this.verify()) return false;
    
    const outputAmount = this.getOutputAmount();
    
    if (this.isCoinbase) {
      // CRITICAL: Validate coinbase transaction amount
      if (outputAmount <= 0) {
        return false;
      }
      
      // Additional coinbase validation can be done at blockchain level
      return true;
    }
    
    // Validate minimum fee if config is provided
    if (config && config.wallet && config.wallet.minFee !== undefined) {
      if (this.fee < config.wallet.minFee) {
        return false;
      }
    }
    
    // Validate fee is a positive number
    if (typeof this.fee !== 'number' || this.fee < 0) {
      return false;
    }
    
    // For non-coinbase transactions, validate inputs and outputs
    if (this.inputs.length === 0) {
      return false; // Must have inputs
    }
    
    // Validate output amount is positive
    if (outputAmount <= 0) {
      return false;
    }
    
    return true;
  }

  /**
   * Create coinbase transaction
   */
  static createCoinbase(address, amount) {
    const transaction = new Transaction([], [new TransactionOutput(address, amount)], 0, TRANSACTION_TAGS.COINBASE);
    transaction.isCoinbase = true;
    transaction.calculateId();
    return transaction;
  }

  /**
   * Create regular transaction
   */
  static createTransaction(inputs, outputs, fee = 0) {
    const transaction = new Transaction(inputs, outputs, fee);
    transaction.calculateId();
    return transaction;
  }

  toJSON() {
    return {
      id: this.id,
      inputs: this.inputs.map(input => input.toJSON()),
      outputs: this.outputs.map(output => output.toJSON()),
      fee: this.fee,
      timestamp: this.timestamp,
      isCoinbase: this.isCoinbase,
      tag: this.tag,
      nonce: this.nonce,           // Include replay protection fields
      expiresAt: this.expiresAt,
      sequence: this.sequence
    };
  }

  static fromJSON(data) {
    try {
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid transaction data: data is not an object');
      }
      
      if (!data.inputs || !Array.isArray(data.inputs)) {
        throw new Error('Invalid transaction data: inputs property is missing or not an array');
      }
      
      if (!data.outputs || !Array.isArray(data.outputs)) {
        throw new Error('Invalid transaction data: outputs property is missing or not an array');
      }
      
      const transaction = new Transaction(
        data.inputs.length > 0 ? data.inputs.map(input => TransactionInput.fromJSON(input)) : [],
        data.outputs.map(output => TransactionOutput.fromJSON(output)),
        data.fee || 0,
        data.tag || TRANSACTION_TAGS.TRANSACTION
      );
      transaction.id = data.id;
      transaction.timestamp = data.timestamp || Date.now();
      transaction.isCoinbase = data.isCoinbase || false;
      
      // Load replay protection fields if they exist
      if (data.nonce) {
        transaction.nonce = data.nonce;
      }
      if (data.expiresAt) {
        transaction.expiresAt = data.expiresAt;
      }
      if (data.sequence !== undefined) {
        transaction.sequence = data.sequence;
      }
      
      return transaction;
    } catch (error) {
      throw new Error(`Failed to create transaction from JSON: ${error.message}`);
    }
  }
}

module.exports = { Transaction, TransactionInput, TransactionOutput }; 