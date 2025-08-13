const { CryptoUtils } = require('../utils/crypto');
const { Transaction } = require('./Transaction');
const logger = require('../utils/logger');

class Block {
  constructor(index, timestamp, transactions, previousHash, nonce = 0, difficulty = 4, config = null) {
    this.index = index;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.nonce = nonce;
    this.difficulty = difficulty;
    this.hash = null;
    this.merkleRoot = null;
    this.config = config;
    
    // CRITICAL: Timestamp validation
    this.validateTimestamp();
    
    // Calculate Merkle root
    this.calculateMerkleRoot();
  }

  /**
   * CRITICAL: Validate timestamp to prevent manipulation attacks
   */
  validateTimestamp() {
    const currentTime = Date.now();
    const maxFutureTime = 2 * 60 * 1000; // 2 minutes in future
    const maxPastTime = 24 * 60 * 60 * 1000; // 24 hours in past
    const minBlockTime = 1000; // 1 second minimum between blocks
    
    // Check if timestamp is in the future
    if (this.timestamp > currentTime + maxFutureTime) {
      throw new Error(`Block timestamp ${this.timestamp} is too far in the future (max: ${currentTime + maxFutureTime})`);
    }
    
    // Check if timestamp is too far in the past
    if (this.timestamp < currentTime - maxPastTime) {
      throw new Error(`Block timestamp ${this.timestamp} is too far in the past (min: ${currentTime - maxPastTime})`);
    }
    
    // Check if timestamp is negative
    if (this.timestamp < 0) {
      throw new Error(`Block timestamp ${this.timestamp} cannot be negative`);
    }
    
    // Check if timestamp is a valid number
    if (isNaN(this.timestamp) || !isFinite(this.timestamp)) {
      throw new Error(`Block timestamp ${this.timestamp} is not a valid number`);
    }
    
    // Check if timestamp is an integer
    if (!Number.isInteger(this.timestamp)) {
      throw new Error(`Block timestamp ${this.timestamp} must be an integer`);
    }
    
    logger.debug('BLOCK', `Timestamp validation passed: ${this.timestamp} (current: ${currentTime})`);
  }

  /**
   * CRITICAL: Validate timestamp against previous block
   */
  validateTimestampAgainstPrevious(previousBlock) {
    if (!previousBlock) {
      return true; // Genesis block
    }
    
    const minBlockTime = 1000; // 1 second minimum
    const maxBlockTime = 60 * 60 * 1000; // 1 hour maximum
    
    const timeDifference = this.timestamp - previousBlock.timestamp;
    
    // Check minimum block time
    if (timeDifference < minBlockTime) {
      throw new Error(`Block time difference ${timeDifference}ms is too short (min: ${minBlockTime}ms)`);
    }
    
    // Check maximum block time
    if (timeDifference > maxBlockTime) {
      throw new Error(`Block time difference ${timeDifference}ms is too long (max: ${maxBlockTime}ms)`);
    }
    
    // Check if timestamp is before previous block
    if (this.timestamp <= previousBlock.timestamp) {
      throw new Error(`Block timestamp ${this.timestamp} must be after previous block timestamp ${previousBlock.timestamp}`);
    }
    
    logger.debug('BLOCK', `Timestamp validation against previous block passed: ${timeDifference}ms difference`);
    return true;
  }

  /**
   * CRITICAL: Get timestamp validation status
   */
  getTimestampValidationStatus() {
    const currentTime = Date.now();
    const timeDifference = currentTime - this.timestamp;
    
    return {
      timestamp: this.timestamp,
      currentTime: currentTime,
      timeDifference: timeDifference,
      timeDifferenceSeconds: Math.floor(timeDifference / 1000),
      isValid: this.timestamp > 0 && this.timestamp <= currentTime + (2 * 60 * 1000),
      warnings: this.getTimestampWarnings()
    };
  }

  /**
   * CRITICAL: Get timestamp warnings
   */
  getTimestampWarnings() {
    const warnings = [];
    const currentTime = Date.now();
    
    if (this.timestamp > currentTime) {
      warnings.push('Block timestamp is in the future');
    }
    
    if (this.timestamp < currentTime - (24 * 60 * 60 * 1000)) {
      warnings.push('Block timestamp is very old');
    }
    
    return warnings;
  }

  /**
   * Calculate block hash using SHA256 (for CPU mining)
   */
  calculateId() {
    const data = JSON.stringify({
      index: this.index,
      timestamp: this.timestamp,
      previousHash: this.previousHash,
      merkleRoot: this.merkleRoot,
      nonce: this.nonce,
      difficulty: this.difficulty
    });
    
    this.hash = CryptoUtils.doubleHash(data);
    this.algorithm = 'sha256';
    return this.hash;
  }

  /**
   * Calculate block hash using KawPow (for GPU mining)
   */
  calculateKawPowId() {
    try {
      // Import KawPow utils dynamically to avoid circular dependencies
      const KawPowUtils = require('../utils/kawpow');
      const kawPowUtils = new KawPowUtils();
      
      // Generate cache for this block - use consistent cache size
      const seed = kawPowUtils.generateSeedHash(this.index);
      const cache = kawPowUtils.generateCache(seed, 1000);
      
      // Calculate KawPow hash
      this.hash = kawPowUtils.kawPowHash(this.index, this.previousHash, this.nonce, cache);
      this.algorithm = 'kawpow';
      
      return this.hash;
    } catch (error) {
      console.log(`❌ ERROR: calculateKawPowId failed: ${error.message}`);
      logger.error('BLOCK', `Failed to calculate KawPow hash: ${error.message}`);
      // Fallback to SHA256
      return this.calculateId();
    }
  }

  /**
   * Alias for calculateId() for compatibility
   */
  calculateHash() {
    return this.calculateId();
  }

  /**
   * Calculate Merkle root from transactions
   */
  calculateMerkleRoot() {
    const transactionHashes = this.transactions.map((tx, index) => {
      if (tx.id) {
        return tx.id;
      }
      
      if (typeof tx.calculateId === 'function') {
        return tx.calculateId();
      }
      
      // If it's a plain object, try to create a transaction from it
      if (tx.inputs && tx.outputs) {
        const transaction = new Transaction(tx.inputs, tx.outputs, tx.fee);
        transaction.isCoinbase = tx.isCoinbase;
        transaction.timestamp = tx.timestamp;
        return transaction.calculateId();
      }
      
      return CryptoUtils.hash(JSON.stringify(tx));
    });
    
    this.merkleRoot = CryptoUtils.calculateMerkleRoot(transactionHashes);
    return this.merkleRoot;
  }

  /**
   * Calculate target hash from difficulty
   */
  calculateTarget() {
    // Convert difficulty to a target hash
    // Higher difficulty = smaller target (harder to find)
    const maxTarget = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    
    // For genesis block, respect the user's difficulty setting
    // But ensure it's not impossibly hard (cap at reasonable difficulty)
    if (this.index === 0) {
      // Use the actual difficulty, but cap it to prevent impossible mining
      const genesisDifficulty = Math.min(this.difficulty, 1000); // Cap at 1000
      const targetHex = BigInt('0x' + maxTarget) / BigInt(Math.max(1, genesisDifficulty));
      const result = targetHex.toString(16).padStart(64, '0');
      
      return result;
    }
    
    // For other blocks, use the actual difficulty
    // Standard formula: Target = MaxTarget / Difficulty
    const targetHex = BigInt('0x' + maxTarget) / BigInt(Math.max(1, this.difficulty));
    const result = targetHex.toString(16).padStart(64, '0');
    
    return result;
  }

  /**
   * Get mining data string for GPU mining
   */
  getMiningData() {
    this.calculateMerkleRoot();
    return `${this.index}${this.previousHash}${this.timestamp}${JSON.stringify(this.transactions)}${this.difficulty}`;
  }

  /**
   * Mine the block (Proof of Work) using SHA256
   */
  mine() {
    this.calculateMerkleRoot();
    
    const target = this.calculateTarget();
    let attempts = 0;
    const maxAttempts = 1000000; // Prevent infinite loops
    
    while (attempts < maxAttempts) {
      this.nonce++;
      this.calculateId(); // Use SHA256 for CPU mining
      
      // Compare hash as hex number with target
      const hashNum = BigInt('0x' + this.hash);
      const targetNum = BigInt('0x' + target);
      
      if (hashNum <= targetNum) {
        return true;
      }
      
      attempts++;
    }
    
    return false;
  }

  /**
   * Mine the block using KawPow (for GPU mining)
   */
  mineKawPow() {
    this.calculateMerkleRoot();
    
    const target = this.calculateTarget();
    let attempts = 0;
    const maxAttempts = 1000000; // Prevent infinite loops
    
    while (attempts < maxAttempts) {
      this.nonce++;
      this.calculateKawPowId(); // Use KawPow for GPU mining
      
      // Compare hash as hex number with target
      const hashNum = BigInt('0x' + this.hash);
      const targetNum = BigInt('0x' + target);
      
      if (hashNum <= targetNum) {
        return true;
      }
      
      attempts++;
    }
    
    return false;
  }

  /**
   * Verify block hash meets difficulty requirement
   */
  hasValidHash() {
    const target = this.calculateTarget();
    
    if (!this.hash) {
      return false;
    }
    
    try {
      const hashNum = BigInt('0x' + this.hash);
      const targetNum = BigInt('0x' + target);
      const isValid = hashNum <= targetNum;
      
      return isValid;
    } catch (error) {
      logger.error('BLOCK', `Hash validation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Verify block hash meets difficulty requirement for specific algorithm
   */
  hasValidHashForAlgorithm(algorithm = 'kawpow') {
    if (algorithm === 'kawpow') {
      // For KawPow, recalculate the hash to verify it's correct
      try {
        const KawPowUtils = require('../utils/kawpow');
        const kawPowUtils = new KawPowUtils();
        
        const seed = kawPowUtils.generateSeedHash(this.index);
        const cache = kawPowUtils.generateCache(seed, 1000);
        const expectedHash = kawPowUtils.kawPowHash(this.index, this.previousHash, this.nonce, cache);
        
        // If hash matches, also check if it meets difficulty requirement
        if (expectedHash === this.hash) {
          const difficultyValid = this.hasValidHash();
          return difficultyValid;
        }
        
        return false;
      } catch (error) {
        logger.error('BLOCK', `KawPow hash verification error: ${error.message}`);
        return false;
      }
    } else {
      // For SHA256, use the standard method
      return this.hasValidHash();
    }
  }

  /**
   * Verify block transactions are valid
   */
  hasValidTransactions(config = null) {
    if (!this.transactions || this.transactions.length === 0) {
      return true; // Genesis block has no transactions
    }

    // CRITICAL: First transaction must be coinbase
    if (this.transactions.length > 0) {
      const firstTx = this.transactions[0];
      if (!firstTx.isCoinbase) {
        return false; // First transaction must be coinbase
      }
    }

    for (let i = 0; i < this.transactions.length; i++) {
      const transaction = this.transactions[i];
      
      // Check if transaction has isValid method (Transaction class instance)
      if (typeof transaction.isValid === 'function') {
        if (!transaction.isValid(config)) {
          return false;
        }
      } else {
        // For plain objects loaded from JSON, do basic validation
        if (!transaction.id || !transaction.outputs || transaction.outputs.length === 0) {
          return false;
        }
        
        // Additional validation for plain objects
        if (i === 0 && !transaction.isCoinbase) {
          return false; // First transaction must be coinbase
        }
        
        if (i > 0 && transaction.isCoinbase) {
          return false; // Only first transaction can be coinbase
        }
      }
    }

    return true;
  }

  /**
   * Verify the entire block is valid
   */
  isValid() {
    // Check if block has required properties
    if (this.index === null || this.index === undefined || this.timestamp === null || this.timestamp === undefined || !this.previousHash || !this.hash) {
      return false;
    }

    // Check if hash is valid for the current algorithm
    if (!this.hasValidHashForAlgorithm(this.algorithm)) {
      return false;
    }

    // Check if transactions are valid
    if (!this.hasValidTransactions(this.config)) {
      return false;
    }

    // Check if merkle root is valid
    const calculatedMerkleRoot = this.calculateMerkleRoot();
    if (this.merkleRoot !== calculatedMerkleRoot) {
      return false;
    }

    return true;
  }

  /**
   * Get block size in bytes
   */
  getSize() {
    const blockData = JSON.stringify(this);
    return Buffer.byteLength(blockData, 'utf8');
  }

  /**
   * Create genesis block
   */
  static createGenesisBlock(address, timestamp = null, transactions = null, difficulty = 4, genesisConfig = null) {
    const genesisTimestamp = timestamp || Date.now();
    
    let genesisTransactions = [];
    if (genesisConfig && genesisConfig.premineAmount && genesisConfig.premineAddress) {
      // Use config settings for premine
      const premineTransaction = Transaction.createCoinbase(genesisConfig.premineAddress, genesisConfig.premineAmount);
      premineTransaction.timestamp = genesisTimestamp;
      premineTransaction.calculateId();
      genesisTransactions = [premineTransaction];
    } else if (transactions) {
      // Use provided transactions
      genesisTransactions = transactions;
    } else {
      // Create default coinbase transaction
      const coinbaseTransaction = Transaction.createCoinbase(address, 100);
      coinbaseTransaction.timestamp = genesisTimestamp;
      coinbaseTransaction.calculateId();
      genesisTransactions = [coinbaseTransaction];
    }

    const genesisBlock = new Block(0, genesisTimestamp, genesisTransactions, '0', 0, difficulty, genesisConfig);
    
    // Use genesis config if available
    if (genesisConfig && genesisConfig.nonce !== undefined && genesisConfig.hash) {
      genesisBlock.nonce = genesisConfig.nonce;
      genesisBlock.hash = genesisConfig.hash;
      genesisBlock.algorithm = genesisConfig.algorithm || 'kawpow';
    } else {
      // Create a simple, valid genesis block without complex mining
      genesisBlock.calculateMerkleRoot();
      
      // Use a simple approach: just calculate the hash once
      genesisBlock.calculateKawPowId();
    }

    return genesisBlock;
  }

  /**
   * Create a new block
   */
  static createBlock(index, transactions, previousHash, difficulty = 4, config = null) {
    const block = new Block(index, Date.now(), transactions, previousHash, 0, difficulty, config);
    block.calculateMerkleRoot();
    
    // For KawPow mining, we need to set a temporary hash and ensure algorithm is set
    // The actual hash will be calculated during mining
    block.algorithm = 'kawpow';
    block.hash = '0000000000000000000000000000000000000000000000000000000000000000'; // Temporary hash
    
    return block;
  }

  /**
   * Convert block to JSON
   */
  toJSON() {
    return {
      index: this.index,
      timestamp: this.timestamp,
      transactions: this.transactions,
      previousHash: this.previousHash,
      nonce: this.nonce,
      difficulty: this.difficulty,
      hash: this.hash,
      merkleRoot: this.merkleRoot,
      algorithm: this.algorithm
    };
  }

  /**
   * Create block from JSON data
   */
  static fromJSON(data) {
    // Convert transactions to Transaction instances if they're plain objects
    let transactions = data.transactions;
    if (transactions && Array.isArray(transactions)) {
      try {
        const { Transaction } = require('./Transaction');
        transactions = transactions.map(tx => {
          if (typeof tx === 'object' && !tx.isValid) {
            return Transaction.fromJSON(tx);
          }
          return tx;
        });
      } catch (error) {
        // If Transaction class can't be loaded, keep original transactions
        console.warn('BLOCK', `Failed to convert transactions to Transaction instances: ${error.message}`);
      }
    }
    
    const block = new Block(
      data.index,
      data.timestamp,
      transactions,
      data.previousHash,
      data.nonce,
      data.difficulty
    );
    
    block.hash = data.hash;
    block.merkleRoot = data.merkleRoot;
    block.algorithm = data.algorithm || 'kawpow'; // Default to KawPow for new blocks
    
    return block;
  }
}

module.exports = Block; 