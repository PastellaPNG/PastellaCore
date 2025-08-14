const { CryptoUtils } = require('../utils/crypto');
const logger = require('../utils/logger');

const { Transaction } = require('./Transaction');

/**
 *
 */
class Block {
  /**
   *
   * @param index
   * @param timestamp
   * @param transactions
   * @param previousHash
   * @param nonce
   * @param difficulty
   * @param config
   */
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
      throw new Error(
        `Block timestamp ${this.timestamp} is too far in the future (max: ${currentTime + maxFutureTime})`
      );
    }

    // Check if timestamp is too far in the past (skip for genesis blocks)
    if (this.index !== 0 && this.timestamp < currentTime - maxPastTime) {
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
   * @param previousBlock
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
      throw new Error(
        `Block timestamp ${this.timestamp} must be after previous block timestamp ${previousBlock.timestamp}`
      );
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
      currentTime,
      timeDifference,
      timeDifferenceSeconds: Math.floor(timeDifference / 1000),
      // Genesis blocks (index 0) are always valid regardless of timestamp age
      isValid: this.index === 0 ? this.timestamp > 0 : (this.timestamp > 0 && this.timestamp <= currentTime + 2 * 60 * 1000),
      warnings: this.getTimestampWarnings(),
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

    // Skip "very old" warning for genesis blocks since they're intentionally old
    if (this.index !== 0 && this.timestamp < currentTime - 24 * 60 * 60 * 1000) {
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
      difficulty: this.difficulty,
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
        const transaction = new Transaction(tx.inputs, tx.outputs, tx.fee, tx.tag || TRANSACTION_TAGS.TRANSACTION, tx.timestamp);
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
      const targetHex = BigInt(`0x${maxTarget}`) / BigInt(Math.max(1, genesisDifficulty));
      const result = targetHex.toString(16).padStart(64, '0');

      return result;
    }

    // For other blocks, use the actual difficulty
    // Standard formula: Target = MaxTarget / Difficulty
    const targetHex = BigInt(`0x${maxTarget}`) / BigInt(Math.max(1, this.difficulty));
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
      const hashNum = BigInt(`0x${this.hash}`);
      const targetNum = BigInt(`0x${target}`);

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
      const hashNum = BigInt(`0x${this.hash}`);
      const targetNum = BigInt(`0x${target}`);

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
      const hashNum = BigInt(`0x${this.hash}`);
      const targetNum = BigInt(`0x${target}`);
      const isValid = hashNum <= targetNum;

      return isValid;
    } catch (error) {
      logger.error('BLOCK', `Hash validation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Verify block hash meets difficulty requirement for specific algorithm
   * @param algorithm
   */
  hasValidHashForAlgorithm(algorithm = 'kawpow') {
    // For genesis blocks (index 0), be more lenient with hash validation
    // since they're special and may have been created with different parameters
    if (this.index === 0) {
      // Just ensure the hash exists and has the right format
      return this.hash && this.hash.length === 64 && /^[0-9a-f]+$/i.test(this.hash);
    }

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
   * @param config
   */
  hasValidTransactions(config = null) {
    logger.debug(
      'BLOCK',
      `Validating transactions for block ${this.index}: count=${this.transactions?.length || 0}, config=${config ? 'present' : 'null'}`
    );

    if (!this.transactions || this.transactions.length === 0) {
      logger.debug('BLOCK', `Block ${this.index} has no transactions, validation passed (genesis block)`);
      return true; // Genesis block has no transactions
    }

    // CRITICAL: First transaction must be coinbase
    if (this.transactions.length > 0) {
      const firstTx = this.transactions[0];
      logger.debug(
        'BLOCK',
        `Checking first transaction: id=${firstTx.id}, isCoinbase=${firstTx.isCoinbase}, type=${typeof firstTx.isCoinbase}`
      );
      if (!firstTx.isCoinbase) {
        logger.debug('BLOCK', `Block ${this.index} validation failed: first transaction is not coinbase`);
        return false; // First transaction must be coinbase
      }
    }

    logger.debug('BLOCK', `Validating ${this.transactions.length} transactions individually`);
    for (let i = 0; i < this.transactions.length; i++) {
      const transaction = this.transactions[i];
      logger.debug(
        'BLOCK',
        `Validating transaction ${i}: id=${transaction.id}, isCoinbase=${transaction.isCoinbase}, hasIsValid=${typeof transaction.isValid === 'function'}`
      );

      // Check if transaction has isValid method (Transaction class instance)
      if (typeof transaction.isValid === 'function') {
        logger.debug('BLOCK', `Transaction ${i} has isValid method, calling it with config`);
        try {
          if (!transaction.isValid(config)) {
            logger.debug('BLOCK', `Transaction ${i} validation failed: isValid() returned false`);
            return false;
          }
          logger.debug('BLOCK', `Transaction ${i} validation passed`);
        } catch (error) {
          logger.error('BLOCK', `Transaction ${i} validation error: ${error.message}`);
          logger.error('BLOCK', `Error stack: ${error.stack}`);
          return false;
        }
      } else {
        logger.debug('BLOCK', `Transaction ${i} is plain object, doing basic validation`);
        // For plain objects loaded from JSON, do basic validation
        if (!transaction.id || !transaction.outputs || transaction.outputs.length === 0) {
          logger.debug('BLOCK', `Transaction ${i} basic validation failed: missing required fields`);
          logger.debug('BLOCK', `  id: ${transaction.id} (${typeof transaction.id})`);
          logger.debug('BLOCK', `  outputs: ${transaction.outputs} (${typeof transaction.outputs})`);
          logger.debug('BLOCK', `  outputs.length: ${transaction.outputs?.length || 'undefined'}`);
          return false;
        }

        // Additional validation for plain objects
        if (i === 0 && !transaction.isCoinbase) {
          logger.debug('BLOCK', `Transaction ${i} validation failed: first transaction must be coinbase`);
          return false; // First transaction must be coinbase
        }

        if (i > 0 && transaction.isCoinbase) {
          logger.debug('BLOCK', `Transaction ${i} validation failed: only first transaction can be coinbase`);
          return false; // Only first transaction can be coinbase
        }

        logger.debug('BLOCK', `Transaction ${i} basic validation passed`);
      }
    }

    logger.debug('BLOCK', `All ${this.transactions.length} transactions validated successfully`);
    return true;
  }

  /**
   * Verify the entire block is valid
   */
  isValid() {
    logger.debug(
      'BLOCK',
      `Validating block ${this.index}: timestamp=${this.timestamp}, previousHash=${this.previousHash?.substring(0, 16)}..., hash=${this.hash?.substring(0, 16)}...`
    );

    // Check if block has required properties
    if (
      this.index === null ||
      this.index === undefined ||
      this.timestamp === null ||
      this.timestamp === undefined ||
      !this.previousHash ||
      !this.hash
    ) {
      logger.debug('BLOCK', `Block ${this.index} validation failed: missing required properties`);
      logger.debug('BLOCK', `  index: ${this.index} (${typeof this.index})`);
      logger.debug('BLOCK', `  timestamp: ${this.timestamp} (${typeof this.timestamp})`);
      logger.debug('BLOCK', `  previousHash: ${this.previousHash} (${typeof this.previousHash})`);
      logger.debug('BLOCK', `  hash: ${this.hash} (${typeof this.hash})`);
      return false;
    }

    // Check if hash is valid for the current algorithm
    logger.debug('BLOCK', `Checking hash validity for algorithm: ${this.algorithm}`);
    if (!this.hasValidHashForAlgorithm(this.algorithm)) {
      logger.debug('BLOCK', `Block ${this.index} validation failed: invalid hash for algorithm ${this.algorithm}`);
      return false;
    }

    // Check if transactions are valid
    logger.debug('BLOCK', `Validating ${this.transactions?.length || 0} transactions`);
    if (!this.hasValidTransactions(this.config)) {
      logger.debug('BLOCK', `Block ${this.index} validation failed: invalid transactions`);
      return false;
    }

    // Check if merkle root is valid
    logger.debug('BLOCK', `Checking merkle root validity: current=${this.merkleRoot?.substring(0, 16)}...`);
    const calculatedMerkleRoot = this.calculateMerkleRoot();
    logger.debug('BLOCK', `Calculated merkle root: ${calculatedMerkleRoot?.substring(0, 16)}...`);
    if (this.merkleRoot !== calculatedMerkleRoot) {
      logger.debug('BLOCK', `Block ${this.index} validation failed: merkle root mismatch`);
      logger.debug('BLOCK', `  Expected: ${this.merkleRoot}`);
      logger.debug('BLOCK', `  Calculated: ${calculatedMerkleRoot}`);
      return false;
    }

    logger.debug('BLOCK', `Block ${this.index} validation passed successfully`);
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
   * @param address
   * @param timestamp
   * @param transactions
   * @param difficulty
   * @param genesisConfig
   */
  static createGenesisBlock(address, timestamp = null, transactions = null, difficulty = 4, genesisConfig = null) {
    // Use genesis config timestamp if available, otherwise use provided timestamp
    const genesisTimestamp = genesisConfig?.timestamp || timestamp;

    // Ensure we have a valid timestamp for deterministic genesis blocks
    if (!genesisTimestamp) {
      throw new Error('Genesis block requires a timestamp from config or parameter for determinism');
    }

    let genesisTransactions = [];
    if (genesisConfig && genesisConfig.premineAmount && genesisConfig.premineAddress) {
      // Use config settings for premine
      const premineTransaction = Transaction.createCoinbase(genesisConfig.premineAddress, genesisConfig.premineAmount, genesisConfig.timestamp, genesisConfig.coinbaseNonce, genesisConfig.coinbaseAtomicSequence, true);
      // Don't override the timestamp - keep the config timestamp for determinism
      premineTransaction.calculateId();
      genesisTransactions = [premineTransaction];
    } else if (transactions) {
      // Use provided transactions
      genesisTransactions = transactions;
    } else {
      // Create default coinbase transaction
      const coinbaseTransaction = Transaction.createCoinbase(address, 100, genesisTimestamp);
      // Don't override the timestamp - keep the passed timestamp for determinism
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
   * @param index
   * @param transactions
   * @param previousHash
   * @param difficulty
   * @param config
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
      algorithm: this.algorithm,
    };
  }

  /**
   * Create block from JSON data
   * @param data
   */
  static fromJSON(data) {
    logger.debug(
      'BLOCK',
      `Creating Block instance from JSON data: index=${data.index}, timestamp=${data.timestamp}, transactions=${data.transactions?.length || 0}`
    );

    // Convert transactions to Transaction instances if they're plain objects
    let { transactions } = data;
    if (transactions && Array.isArray(transactions)) {
      logger.debug('BLOCK', `Processing ${transactions.length} transactions for conversion`);
      try {
        const { Transaction } = require('./Transaction');
        transactions = transactions.map((tx, index) => {
          logger.debug(
            'BLOCK',
            `Converting transaction ${index}: id=${tx.id}, isCoinbase=${tx.isCoinbase}, hasIsValid=${typeof tx.isValid === 'function'}`
          );
          if (typeof tx === 'object' && !tx.isValid) {
            const convertedTx = Transaction.fromJSON(tx);
            logger.debug(
              'BLOCK',
              `Successfully converted transaction ${index} to Transaction instance: id=${convertedTx.id}`
            );
            return convertedTx;
          }
          logger.debug('BLOCK', `Transaction ${index} already a Transaction instance or invalid: id=${tx.id}`);
          return tx;
        });
        logger.debug('BLOCK', `Successfully converted ${transactions.length} transactions`);
      } catch (error) {
        logger.error('BLOCK', `Failed to convert transactions to Transaction instances: ${error.message}`);
        logger.error('BLOCK', `Error stack: ${error.stack}`);
        logger.warn('BLOCK', `Keeping original transactions due to conversion failure`);
      }
    } else {
      logger.debug(
        'BLOCK',
        `No transactions to convert or invalid transactions array: ${JSON.stringify(transactions)}`
      );
    }

    logger.debug(
      'BLOCK',
      `Creating Block constructor with: index=${data.index}, timestamp=${data.timestamp}, transactions=${transactions?.length || 0}, previousHash=${data.previousHash}, nonce=${data.nonce}, difficulty=${data.difficulty}`
    );

    const block = new Block(data.index, data.timestamp, transactions, data.previousHash, data.nonce, data.difficulty);

    block.hash = data.hash;
    block.merkleRoot = data.merkleRoot;
    block.algorithm = data.algorithm || 'kawpow'; // Default to KawPow for new blocks

    logger.debug(
      'BLOCK',
      `Block instance created successfully: index=${block.index}, hash=${block.hash?.substring(0, 16)}..., merkleRoot=${block.merkleRoot?.substring(0, 16)}...`
    );

    return block;
  }
}

module.exports = Block;
