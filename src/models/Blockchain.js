const Block = require('./Block');
const { Transaction } = require('./Transaction');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { TRANSACTION_TAGS } = require('../utils/constants');

// Import modular components
const UTXOManager = require('./UTXOManager');
const SpamProtection = require('./SpamProtection');
const MemoryPoolManager = require('./MemoryPoolManager');
const TransactionManager = require('./TransactionManager');
const BlockchainValidation = require('./BlockchainValidation');

/**
 * MODULAR & SECURE BLOCKCHAIN CLASS
 * 
 * This class now orchestrates specialized modules:
 * - UTXOManager: Handles all UTXO operations
 * - SpamProtection: Manages rate limiting and spam prevention
 * - MemoryPoolManager: Handles transaction pool and batch processing
 * - TransactionManager: Manages transaction validation and creation
 * - BlockchainValidation: Handles blockchain validation methods
 * 
 * BENEFITS:
 * - Better code organization and maintainability
 * - Easier testing and debugging
 * - Clear separation of concerns
 * - Reduced file size and complexity
 */
class Blockchain {
  constructor(dataDir = './data') {
    this.chain = [];
    this.difficulty = 1000; // Default difficulty (will be overridden by config)
    this.miningReward = 50;
    this.blockTime = 60000; // 1 minute
    this.dataDir = dataDir;
    this.difficultyAlgorithm = 'lwma3'; // Default to LWMA-3 algorithm
    this.difficultyBlocks = 60; // Default number of blocks for LWMA calculation
    this.difficultyMinimum = 1; // Minimum difficulty floor
    this.config = null; // Configuration for validation
    
    // Initialize modular components
    this.utxoManager = new UTXOManager();
    this.spamProtection = new SpamProtection();
    this.memoryPool = new MemoryPoolManager();
    this.transactionManager = new TransactionManager(this.utxoManager, this.spamProtection, this.memoryPool);
    this.blockchainValidation = new BlockchainValidation();
  }

  /**
   * Initialize blockchain with genesis block
   */
  initialize(address, config = null, suppressLogging = false) {
    // Store config for validation
    this.config = config;

    // Load configuration values
    if (config && config.blockchain) {
      this.difficulty = config.blockchain.genesis?.difficulty || this.difficulty;
      this.blockTime = config.blockchain.blockTime || this.blockTime;
      this.miningReward = config.blockchain.coinbaseReward || this.miningReward;
      this.difficultyAlgorithm = config.blockchain.difficultyAlgorithm || 'lwma3';
      this.difficultyBlocks = config.blockchain.difficultyBlocks || 60;
      this.difficultyMinimum = config.blockchain.difficultyMinimum || 1;

      if (this.difficulty > 100000) {
        logger.warn('BLOCKCHAIN', `Initial difficulty too high (${this.difficulty}), resetting to 100`);
        this.difficulty = 100;
      }
    }

    if (this.chain.length === 0) {
      let genesisBlock;

      if (config && config.blockchain && config.blockchain.genesis) {
        const genesisConfig = config.blockchain.genesis;
        const genesisTimestamp = genesisConfig.timestamp;
        const premineAmount = genesisConfig.premineAmount;
        const premineAddress = genesisConfig.premineAddress;

        const premineTransaction = Transaction.createCoinbase(premineAddress, premineAmount);
        premineTransaction.tag = TRANSACTION_TAGS.PREMINE;
        premineTransaction.timestamp = genesisTimestamp;
        premineTransaction.calculateId();

        genesisBlock = Block.createGenesisBlock(premineAddress, genesisTimestamp, [premineTransaction], this.difficulty, genesisConfig);
        if (!suppressLogging) {
          logger.info('BLOCKCHAIN', `Genesis block created with premine: ${premineAmount} PAS to ${premineAddress}`);
        }
      } else {
        const defaultTimestamp = Date.now();
        genesisBlock = Block.createGenesisBlock(address, defaultTimestamp, [], this.difficulty);
        if (!suppressLogging) {
          logger.info('BLOCKCHAIN', 'Genesis block created with default settings');
        }
      }

      this.chain.push(genesisBlock);
      this.utxoManager.updateUTXOSet(genesisBlock);
      if (!suppressLogging) {
        logger.info('BLOCKCHAIN', `Genesis block added to chain. Hash: ${genesisBlock.hash}`);
      }
    }

    if (config && config.spamProtection) {
      this.spamProtection.updateConfig(config.spamProtection);
    }

    if (!suppressLogging) {
      logger.info('BLOCKCHAIN', `Blockchain initialized with ${this.chain.length} blocks`);
    }
  }

  /**
   * Get blockchain status
   */
  getStatus() {
    return {
      chainLength: this.chain.length,
      difficulty: this.difficulty,
      miningReward: this.miningReward,
      blockTime: this.blockTime,
      pendingTransactions: this.memoryPool.getPendingTransactionCount(),
      utxoCount: this.utxoManager.getUTXOCount(),
      spamProtection: this.spamProtection.getStatus()
    };
  }

  /**
   * Get latest block
   */
  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  /**
   * Get blockchain height
   */
  getHeight() {
    return this.chain.length;
  }

  /**
   * Add new block to the chain
   */
  addBlock(block, skipValidation = false) {
    try {
      if (!skipValidation && !this.blockchainValidation.isValidBlock(block, this.config)) {
        logger.error('BLOCKCHAIN', `Block ${block.index} validation failed`);
        return false;
      }

      // Check if block is already in chain
      if (this.chain.some(existingBlock => existingBlock.hash === block.hash)) {
        logger.warn('BLOCKCHAIN', `Block ${block.index} already exists in chain`);
        return false;
      }

      // Check if block links properly
      const latestBlock = this.getLatestBlock();
      if (block.previousHash !== latestBlock.hash) {
        logger.error('BLOCKCHAIN', `Block ${block.index} does not link to latest block`);
        return false;
      }

      // Add block to chain
      this.chain.push(block);
      
      // Update UTXO set
      this.utxoManager.updateUTXOSet(block);
      
      // Remove transactions from pending pool
      this.memoryPool.removeTransactions(block.transactions);
      
      // Adjust difficulty
      this.adjustDifficulty();
      
      logger.info('BLOCKCHAIN', `Block ${block.index} added to chain. Hash: ${block.hash}`);
      return true;

    } catch (error) {
      logger.error('BLOCKCHAIN', `Error adding block: ${error.message}`);
      return false;
    }
  }

  /**
   * Adjust difficulty using LWMA-3 algorithm
   */
  adjustDifficulty() {
    if (this.chain.length < this.difficultyBlocks + 1) {
      return; // Not enough blocks to adjust difficulty
    }

    const oldDifficulty = this.difficulty;
    const targetBlockTime = this.blockTime;
    
    // Get recent blocks for difficulty calculation
    const recentBlocks = this.chain.slice(-this.difficultyBlocks);
    
    // Calculate average block time
    let totalTime = 0;
    for (let i = 1; i < recentBlocks.length; i++) {
      totalTime += recentBlocks[i].timestamp - recentBlocks[i - 1].timestamp;
    }
    const averageBlockTime = totalTime / (recentBlocks.length - 1);
    
    // Adjust difficulty based on block time
    if (averageBlockTime < targetBlockTime * 0.5) {
      this.difficulty = Math.floor(this.difficulty * 1.5);
    } else if (averageBlockTime > targetBlockTime * 1.5) {
      this.difficulty = Math.max(this.difficultyMinimum, Math.floor(this.difficulty * 0.75));
    }
    
    // Ensure difficulty doesn't go below minimum
    this.difficulty = Math.max(this.difficulty, this.difficultyMinimum);
    
    if (this.difficulty !== oldDifficulty) {
      logger.info('BLOCKCHAIN', `Difficulty adjusted from ${oldDifficulty} to ${this.difficulty}`);
    }
  }

  /**
   * Get pending transactions for mining
   */
  getPendingTransactions() {
    return this.memoryPool.getPendingTransactions();
  }

  /**
   * Add transaction to pending pool
   */
  addPendingTransaction(transaction) {
    return this.transactionManager.addPendingTransaction(transaction);
  }

  /**
   * Add multiple transactions in batch
   */
  addTransactionBatch(transactions) {
    return this.transactionManager.addTransactionBatch(transactions);
  }

  /**
   * Validate entire blockchain
   */
  isValidChain() {
    return this.blockchainValidation.isValidChain(this.chain, this.config);
  }

  /**
   * Fast validation (skips expensive operations)
   */
  isValidChainFast() {
    return this.blockchainValidation.isValidChainFast(this.chain);
  }

  /**
   * Ultra-fast validation (minimal checks)
   */
  isValidChainUltraFast() {
    return this.blockchainValidation.isValidChainUltraFast(this.chain);
  }

  /**
   * Clean up expired transactions
   */
  cleanupExpiredTransactions() {
    return this.memoryPool.cleanupExpiredTransactions();
  }

  /**
   * Clean up orphaned UTXOs
   */
  cleanupOrphanedUTXOs() {
    return this.utxoManager.cleanupOrphanedUTXOs(this.chain);
  }

  /**
   * Manage memory pool
   */
  manageMemoryPool() {
    return this.memoryPool.manageMemoryPool();
  }

  /**
   * Clean up spam protection data
   */
  cleanupSpamProtection() {
    this.spamProtection.cleanupSpamProtection();
  }

  /**
   * Get balance for an address
   */
  getBalance(address) {
    return this.utxoManager.getBalance(address);
  }

  /**
   * Get UTXOs for an address
   */
  getUTXOsForAddress(address) {
    return this.utxoManager.getUTXOsForAddress(address);
  }

  /**
   * Create transaction
   */
  createTransaction(fromAddress, toAddress, amount, fee = 0.001, tag = TRANSACTION_TAGS.TRANSACTION) {
    return this.transactionManager.createTransaction(fromAddress, toAddress, amount, fee, tag);
  }

  /**
   * Save blockchain to file
   */
  saveToFile(filePath) {
    try {
      const data = {
        chain: this.chain,
        difficulty: this.difficulty,
        miningReward: this.miningReward,
        blockTime: this.blockTime,
        pendingTransactions: this.memoryPool.getPendingTransactions(),
        utxos: this.utxoManager.utxos
      };
      
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      logger.info('BLOCKCHAIN', `Blockchain saved to ${filePath}`);
      return true;
    } catch (error) {
      logger.error('BLOCKCHAIN', `Failed to save blockchain: ${error.message}`);
      return false;
    }
  }

  /**
   * Load blockchain from file
   */
  loadFromFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        logger.warn('BLOCKCHAIN', `Blockchain file not found: ${filePath}`);
        return false;
      }

      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      this.chain = data.chain || [];
      this.difficulty = data.difficulty || this.difficulty;
      this.miningReward = data.miningReward || this.miningReward;
      this.blockTime = data.blockTime || this.blockTime;
      
      // Load pending transactions
      if (data.pendingTransactions) {
        this.memoryPool.clear();
        data.pendingTransactions.forEach(tx => {
          this.memoryPool.addTransaction(tx);
        });
      }
      
      // Load UTXOs
      if (data.utxos) {
        this.utxoManager.utxos = data.utxos;
      }
      
      logger.info('BLOCKCHAIN', `Blockchain loaded from ${filePath} with ${this.chain.length} blocks`);
      return true;
    } catch (error) {
      logger.error('BLOCKCHAIN', `Failed to load blockchain: ${error.message}`);
      return false;
    }
  }

  /**
   * Get security report
   */
  getSecurityReport() {
    return {
      chainLength: this.chain.length,
      lastBlockHash: this.getLatestBlock()?.hash || 'none',
      difficulty: this.difficulty,
      pendingTransactions: this.memoryPool.getPendingTransactionCount(),
      utxoCount: this.utxoManager.getUTXOCount(),
      spamProtection: this.spamProtection.getStatus(),
      validationStatus: this.isValidChain()
    };
  }
}

module.exports = Blockchain; 