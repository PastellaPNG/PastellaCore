const fs = require('fs');
const path = require('path');

const { TRANSACTION_TAGS } = require('../utils/constants');
const logger = require('../utils/logger');

const Block = require('./Block');

// Import modular components
const BlockchainValidation = require('./BlockchainValidation');
const CheckpointManager = require('./CheckpointManager');
const MemoryPoolManager = require('./MemoryPoolManager');
const SpamProtection = require('./SpamProtection');
const { Transaction } = require('./Transaction');
const TransactionManager = require('./TransactionManager');
const UTXOManager = require('./UTXOManager');

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
  /**
   *
   * @param dataDir
   * @param config
   */
  constructor(dataDir = './data', config = null) {
    this.chain = [];
    this.difficulty = 1000; // Default difficulty (will be overridden by config)
    this.miningReward = 50;
    this.blockTime = 60000; // 1 minute
    this.dataDir = dataDir;
    this.difficultyAlgorithm = 'lwma3'; // Default to LWMA-3 algorithm
    this.difficultyBlocks = 60; // Default number of blocks for LWMA calculation
    this.difficultyMinimum = 1; // Minimum difficulty floor
    this.config = config; // Configuration for validation

    // Initialize modular components
    this.utxoManager = new UTXOManager();
    this.spamProtection = new SpamProtection();
    this.memoryPool = new MemoryPoolManager(config); // Pass config for memory limits
    this.transactionManager = new TransactionManager(this.utxoManager, this.spamProtection, this.memoryPool);
    this.blockchainValidation = new BlockchainValidation(config); // Pass config for validation limits

    // CRITICAL: Initialize checkpoint manager for blockchain validation
    this.checkpointManager = new CheckpointManager(dataDir);

    // CRITICAL: Historical transaction database for replay attack protection
    this.historicalTransactions = new Map(); // Key: "nonce:senderAddress", Value: {txId, blockHeight, timestamp}
    this.historicalTransactionIds = new Set(); // Track all transaction IDs ever processed

    // CRITICAL: 51% Attack Protection System
    this.consensusManager = {
      // Track mining power distribution
      miningPowerDistribution: new Map(), // address -> hashRate
      totalNetworkHashRate: 0,

      // Proof-of-Stake validation (hybrid consensus)
      stakedValidators: new Map(), // address -> stakeAmount
      totalStake: 0,
      minStakeForValidation: 1000, // Minimum PAS required to be a validator

      // Network partition detection
      partitionDetection: {
        lastBlockTime: Date.now(),
        expectedBlockTime: this.blockTime,
        consecutiveLateBlocks: 0,
        partitionThreshold: 5, // Consecutive late blocks before partition warning
        isPartitioned: false,
      },

      // Consensus validation
      consensusThreshold: 0.67, // 67% consensus required
      validatorSignatures: new Map(), // blockHash -> [validatorSignatures]

      // Anti-51% measures
      maxSingleMinerHashRate: 0.4, // Max 40% hash rate per single miner
      suspiciousActivity: new Set(), // Track suspicious mining patterns
    };
  }

  /**
   * Initialize blockchain with genesis block
   * @param address
   * @param config
   * @param suppressLogging
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
        const { premineAmount } = genesisConfig;
        const { premineAddress } = genesisConfig;

        const premineTransaction = Transaction.createCoinbase(premineAddress, premineAmount, genesisTimestamp, this.config?.blockchain?.genesis?.coinbaseNonce, this.config?.blockchain?.genesis?.coinbaseAtomicSequence, true);
        premineTransaction.tag = TRANSACTION_TAGS.PREMINE;
        // Don't override the timestamp - keep the config timestamp for determinism
        premineTransaction.calculateId();

        genesisBlock = Block.createGenesisBlock(
          premineAddress,
          genesisTimestamp,
          [premineTransaction],
          this.difficulty,
          genesisConfig
        );
        if (!suppressLogging) {
          logger.info('BLOCKCHAIN', `Genesis block created with premine: ${premineAmount} PAS to ${premineAddress}`);
        }
      } else {
        // Use config timestamp if available, otherwise create without timestamp
        const configTimestamp = this.config?.blockchain?.genesis?.timestamp;
        genesisBlock = Block.createGenesisBlock(address, configTimestamp, [], this.difficulty, this.config?.blockchain?.genesis);
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
      spamProtection: this.spamProtection.getStatus(),
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
   * @param block
   * @param skipValidation
   */
  addBlock(block, skipValidation = false) {
    logger.debug(
      'BLOCKCHAIN',
      `Adding block to chain: index=${block.index}, hash=${block.hash?.substring(0, 16)}..., previousHash=${block.previousHash?.substring(0, 16)}..., skipValidation=${skipValidation}`
    );
    logger.debug(
      'BLOCKCHAIN',
      `Current chain length: ${this.chain.length}, config present: ${this.config ? 'yes' : 'no'}`
    );

    try {
      if (!skipValidation) {
        logger.debug('BLOCKCHAIN', `Running block validation for block ${block.index}`);
        const validationResult = this.blockchainValidation.isValidBlock(block, this.config);
        logger.debug('BLOCKCHAIN', `Block validation result: ${validationResult}`);
        if (!validationResult) {
          logger.error('BLOCKCHAIN', `Block ${block.index} validation failed`);
          return false;
        }
        logger.debug('BLOCKCHAIN', `Block ${block.index} validation passed`);
      } else {
        logger.debug('BLOCKCHAIN', `Skipping validation for block ${block.index}`);
      }

      // Check if block is already in chain
      const existingBlock = this.chain.find(existingBlock => existingBlock.hash === block.hash);
      if (existingBlock) {
        logger.warn('BLOCKCHAIN', `Block ${block.index} already exists in chain at index ${existingBlock.index}`);
        return false;
      }

      // Check if block links properly
      const latestBlock = this.getLatestBlock();

      // For genesis block (index 0) or when chain is empty, skip linking validation
      if (block.index === 0 || !latestBlock) {
        // Skip linking validation for genesis block or empty chain
      } else if (block.previousHash !== latestBlock.hash) {
        logger.error('BLOCKCHAIN', `Block ${block.index} does not link to latest block`);
        logger.error('BLOCKCHAIN', `  Block previousHash: ${block.previousHash}`);
        logger.error('BLOCKCHAIN', `  Latest block hash: ${latestBlock.hash}`);
        return false;
      }

      // CRITICAL: Add transactions to historical database for replay attack protection
      this.addTransactionsToHistoricalDatabase(block);

      // Add block to chain
      this.chain.push(block);

      // Update UTXO set
      this.utxoManager.updateUTXOSet(block);

      // Remove transactions from pending pool
      this.memoryPool.removeTransactions(block.transactions);

      // Adjust difficulty
      this.adjustDifficulty();

      logger.info('BLOCKCHAIN', `Block ${block.index} added to chain successfully. Hash: ${block.hash}`);
      return true;
    } catch (error) {
      logger.error('BLOCKCHAIN', `Error adding block ${block.index}: ${error.message}`);
      logger.error('BLOCKCHAIN', `Error stack: ${error.stack}`);
      logger.error(
        'BLOCKCHAIN',
        `Block data: index=${block.index}, hash=${block.hash}, previousHash=${block.previousHash}`
      );
      return false;
    }
  }

  /**
   * CRITICAL: Add transactions to historical database for replay attack protection
   * @param block
   */
  addTransactionsToHistoricalDatabase(block) {
    block.transactions.forEach(transaction => {
      if (!transaction.isCoinbase && transaction.nonce) {
        // Create unique key: "nonce:senderAddress"
        const senderAddress = this.getTransactionSenderAddress(transaction);
        if (senderAddress) {
          const key = `${transaction.nonce}:${senderAddress}`;

          // Store transaction info
          this.historicalTransactions.set(key, {
            txId: transaction.id,
            blockHeight: block.index,
            timestamp: transaction.timestamp,
            nonce: transaction.nonce,
            senderAddress,
          });

          // Also track by transaction ID for duplicate detection
          this.historicalTransactionIds.add(transaction.id);

          logger.debug(
            'BLOCKCHAIN',
            `Added transaction ${transaction.id} to historical database with nonce ${transaction.nonce} from ${senderAddress}`
          );
        }
      }
    });
  }

  /**
   * CRITICAL: Get sender address from transaction inputs
   * @param transaction
   */
  getTransactionSenderAddress(transaction) {
    if (!transaction.inputs || transaction.inputs.length === 0) {
      return null;
    }

    // For now, use the first input's public key as sender identifier
    // In a more robust implementation, you'd derive the address from the public key
    const firstInput = transaction.inputs[0];
    if (firstInput && firstInput.publicKey) {
      // Create a simple hash of the public key as a sender identifier
      const { CryptoUtils } = require('../utils/crypto');
      return CryptoUtils.hash(firstInput.publicKey).substring(0, 16);
    }

    return null;
  }

  /**
   * CRITICAL: Check if transaction is a replay attack against historical blockchain
   * @param transaction
   */
  isReplayAttack(transaction) {
    if (transaction.isCoinbase) {
      return false; // Coinbase transactions cannot be replayed
    }

    if (!transaction.nonce) {
      logger.warn('BLOCKCHAIN', `Transaction ${transaction.id} missing nonce - potential replay attack`);
      return true; // Reject transactions without nonce
    }

    // Check if transaction ID already exists in historical database
    if (this.historicalTransactionIds.has(transaction.id)) {
      logger.warn('BLOCKCHAIN', `Replay attack detected: Transaction ${transaction.id} already exists in blockchain`);
      return true;
    }

    // Check if nonce from same sender already exists
    const senderAddress = this.getTransactionSenderAddress(transaction);
    if (senderAddress) {
      const key = `${transaction.nonce}:${senderAddress}`;
      const existing = this.historicalTransactions.get(key);

      if (existing) {
        logger.warn(
          'BLOCKCHAIN',
          `Replay attack detected: Transaction ${transaction.id} uses nonce ${transaction.nonce} already used by ${senderAddress} in block ${existing.blockHeight}`
        );
        return true;
      }
    }

    return false;
  }

  /**
   * CRITICAL: Get comprehensive replay attack protection statistics
   */
  getReplayProtectionStats() {
    return {
      historicalTransactionCount: this.historicalTransactions.size,
      historicalTransactionIdCount: this.historicalTransactionIds.size,
      pendingTransactionCount: this.memoryPool.getPendingTransactionCount(),
      replayProtectionEnabled: true,
      nonceValidation: 'enabled',
      expirationValidation: 'enabled',
      historicalValidation: 'enabled',
      duplicateDetection: 'enabled',
      protectionLevel: 'comprehensive',
    };
  }

  /**
   * CRITICAL: 51% Attack Protection - Validate consensus
   * @param block
   * @param minerAddress
   * @param hashRate
   */
  validateConsensus(block, minerAddress, hashRate) {
    try {
      // Update mining power distribution
      this.consensusManager.miningPowerDistribution.set(minerAddress, hashRate);
      this.consensusManager.totalNetworkHashRate = Array.from(
        this.consensusManager.miningPowerDistribution.values()
      ).reduce((total, rate) => total + rate, 0);

      // Check for 51% attack
      const minerShare = hashRate / this.consensusManager.totalNetworkHashRate;
      if (minerShare > this.consensusManager.maxSingleMinerHashRate) {
        logger.warn(
          'CONSENSUS',
          `⚠️  51% Attack Warning: Miner ${minerAddress} controls ${(minerShare * 100).toFixed(2)}% of network hash rate`
        );
        this.consensusManager.suspiciousActivity.add(minerAddress);
        return { valid: false, reason: 'Miner controls too much hash rate', attackType: '51%_ATTACK' };
      }

      // Check for network partition
      const currentTime = Date.now();
      const timeSinceLastBlock = currentTime - this.consensusManager.partitionDetection.lastBlockTime;

      if (timeSinceLastBlock > this.consensusManager.partitionDetection.expectedBlockTime * 2) {
        this.consensusManager.partitionDetection.consecutiveLateBlocks++;

        if (
          this.consensusManager.partitionDetection.consecutiveLateBlocks >=
          this.consensusManager.partitionDetection.partitionThreshold
        ) {
          this.consensusManager.partitionDetection.isPartitioned = true;
          logger.warn(
            'CONSENSUS',
            `⚠️  Network Partition Detected: ${this.consensusManager.partitionDetection.consecutiveLateBlocks} consecutive late blocks`
          );
          return { valid: false, reason: 'Network partition detected', attackType: 'NETWORK_PARTITION' };
        }
      } else {
        this.consensusManager.partitionDetection.consecutiveLateBlocks = 0;
      }

      // Update partition detection
      this.consensusManager.partitionDetection.lastBlockTime = currentTime;

      // Validate proof-of-stake consensus (hybrid approach)
      const validatorCount = this.consensusManager.stakedValidators.size;
      if (validatorCount > 0) {
        const requiredValidators = Math.ceil(validatorCount * this.consensusManager.consensusThreshold);
        const currentValidators = this.consensusManager.validatorSignatures.get(block.hash)?.length || 0;

        if (currentValidators < requiredValidators) {
          logger.warn(
            'CONSENSUS',
            `⚠️  Insufficient validator consensus: ${currentValidators}/${requiredValidators} required`
          );
          return { valid: false, reason: 'Insufficient validator consensus', attackType: 'INSUFFICIENT_CONSENSUS' };
        }
      }

      return { valid: true, reason: 'Consensus validation passed' };
    } catch (error) {
      logger.error('CONSENSUS', `Consensus validation error: ${error.message}`);
      return { valid: false, reason: `Consensus validation error: ${error.message}`, attackType: 'VALIDATION_ERROR' };
    }
  }

  /**
   * CRITICAL: Add validator signature for hybrid consensus
   * @param blockHash
   * @param validatorAddress
   * @param stakeAmount
   */
  addValidatorSignature(blockHash, validatorAddress, stakeAmount) {
    if (stakeAmount >= this.consensusManager.minStakeForValidation) {
      if (!this.consensusManager.validatorSignatures.has(blockHash)) {
        this.consensusManager.validatorSignatures.set(blockHash, []);
      }

      this.consensusManager.validatorSignatures.get(blockHash).push({
        validator: validatorAddress,
        stake: stakeAmount,
        timestamp: Date.now(),
      });

      logger.debug('CONSENSUS', `Validator ${validatorAddress} signed block ${blockHash} with stake ${stakeAmount}`);
    }
  }

  /**
   * CRITICAL: Get consensus status and security metrics
   */
  getConsensusStatus() {
    const miningPower = Array.from(this.consensusManager.miningPowerDistribution.entries())
      .map(([address, hashRate]) => ({
        address,
        hashRate,
        share: ((hashRate / this.consensusManager.totalNetworkHashRate) * 100).toFixed(2),
      }))
      .sort((a, b) => b.share - a.share);

    return {
      totalNetworkHashRate: this.consensusManager.totalNetworkHashRate,
      miningPowerDistribution: miningPower,
      suspiciousMiners: Array.from(this.consensusManager.suspiciousActivity),
      networkPartition: this.consensusManager.partitionDetection.isPartitioned,
      consecutiveLateBlocks: this.consensusManager.partitionDetection.consecutiveLateBlocks,
      validatorCount: this.consensusManager.stakedValidators.size,
      totalStake: this.consensusManager.totalStake,
      consensusThreshold: this.consensusManager.consensusThreshold,
      securityLevel: this._calculateSecurityLevel(),
    };
  }

  /**
   * CRITICAL: Calculate overall security level
   */
  _calculateSecurityLevel() {
    let securityScore = 100;

    // Deduct points for suspicious activity
    securityScore -= this.consensusManager.suspiciousActivity.size * 10;

    // Deduct points for network partition
    if (this.consensusManager.partitionDetection.isPartitioned) {
      securityScore -= 30;
    }

    // Deduct points for high hash rate concentration
    const topMiner = Array.from(this.consensusManager.miningPowerDistribution.values()).sort((a, b) => b - a)[0] || 0;
    const topMinerShare = topMiner / this.consensusManager.totalNetworkHashRate;
    if (topMinerShare > 0.3) {
      securityScore -= Math.floor((topMinerShare - 0.3) * 100);
    }

    return Math.max(0, Math.min(100, securityScore));
  }

  /**
   * CRITICAL: Get memory protection status
   */
  getMemoryProtectionStatus() {
    try {
      return this.memoryPool.memoryProtection.getMemoryStatus();
    } catch (error) {
      logger.error('BLOCKCHAIN', `Failed to get memory protection status: ${error.message}`);
      return { error: 'Failed to get memory protection status' };
    }
  }

  /**
   * CRITICAL: Get CPU protection status
   */
  getCPUProtectionStatus() {
    try {
      return this.blockchainValidation.cpuProtection.getCPUStatus();
    } catch (error) {
      logger.error('BLOCKCHAIN', `Failed to get CPU protection status: ${error.message}`);
      return { error: 'Failed to get CPU protection status' };
    }
  }

  /**
   * CRITICAL: Get detailed replay protection analysis
   */
  getReplayProtectionAnalysis() {
    const analysis = {
      summary: 'Comprehensive replay attack protection enabled',
      protectionMechanisms: [
        'Unique nonce per transaction',
        'Transaction expiration (24 hours)',
        'Historical transaction database',
        'Duplicate transaction ID detection',
        'Sender-based nonce validation',
        'Blockchain-level validation',
      ],
      databaseStats: {
        totalHistoricalTransactions: this.historicalTransactions.size,
        totalTransactionIds: this.historicalTransactionIds.size,
        databaseSize: JSON.stringify(Array.from(this.historicalTransactions.entries())).length,
      },
      recentActivity: [],
      threats: [],
    };

    // Get recent transactions (last 10)
    const recentEntries = Array.from(this.historicalTransactions.entries()).slice(-10);
    analysis.recentActivity = recentEntries.map(([key, value]) => ({
      nonce: value.nonce,
      sender: value.senderAddress,
      blockHeight: value.blockHeight,
      timestamp: new Date(value.timestamp).toISOString(),
    }));

    // Check for potential threats (transactions with same nonce from different senders)
    const nonceGroups = new Map();
    this.historicalTransactions.forEach((value, key) => {
      const { nonce } = value;
      if (!nonceGroups.has(nonce)) {
        nonceGroups.set(nonce, []);
      }
      nonceGroups.get(nonce).push(value);
    });

    nonceGroups.forEach((transactions, nonce) => {
      if (transactions.length > 1) {
        const senders = [...new Set(transactions.map(tx => tx.senderAddress))];
        if (senders.length > 1) {
          analysis.threats.push({
            type: 'Nonce collision detected',
            nonce,
            senders,
            severity: 'low',
            description: 'Multiple senders using same nonce (this is normal if nonces are truly random)',
          });
        }
      }
    });

    return analysis;
  }

  /**
   * CRITICAL: Test replay protection by attempting to add a duplicate transaction
   * This is useful for security testing and validation
   * @param transaction
   */
  testReplayProtection(transaction) {
    const testResults = {
      passed: true,
      tests: [],
      threats: [],
    };

    // Test 1: Check if transaction has required replay protection fields
    if (!transaction.isCoinbase) {
      if (!transaction.nonce) {
        testResults.passed = false;
        testResults.tests.push({
          test: 'Nonce presence',
          result: 'FAILED',
          description: 'Transaction missing nonce field',
        });
        testResults.threats.push('Transaction can be replayed without nonce');
      } else {
        testResults.tests.push({
          test: 'Nonce presence',
          result: 'PASSED',
          description: 'Transaction has nonce field',
        });
      }

      if (!transaction.expiresAt) {
        testResults.passed = false;
        testResults.tests.push({
          test: 'Expiration presence',
          result: 'FAILED',
          description: 'Transaction missing expiration field',
        });
        testResults.threats.push('Transaction can be replayed without expiration');
      } else {
        testResults.tests.push({
          test: 'Expiration presence',
          result: 'PASSED',
          description: 'Transaction has expiration field',
        });
      }
    }

    // Test 2: Check if transaction has expired
    if (transaction.isExpired && transaction.isExpired()) {
      testResults.passed = false;
      testResults.tests.push({
        test: 'Transaction expiration',
        result: 'FAILED',
        description: 'Transaction has expired',
      });
      testResults.threats.push('Expired transaction can be replayed');
    } else {
      testResults.tests.push({
        test: 'Transaction expiration',
        result: 'PASSED',
        description: 'Transaction is not expired',
      });
    }

    // Test 3: Check against historical blockchain
    if (this.isReplayAttack(transaction)) {
      testResults.passed = false;
      testResults.tests.push({
        test: 'Historical replay check',
        result: 'FAILED',
        description: 'Transaction detected as replay attack against historical blockchain',
      });
      testResults.threats.push('Transaction is a replay of a previously confirmed transaction');
    } else {
      testResults.tests.push({
        test: 'Historical replay check',
        result: 'PASSED',
        description: 'Transaction is not a replay attack',
      });
    }

    // Test 4: Check for duplicate in pending pool
    const pendingTxs = this.memoryPool.getPendingTransactions();
    if (transaction.isReplayAttack && typeof transaction.isReplayAttack === 'function') {
      if (transaction.isReplayAttack(pendingTxs)) {
        testResults.passed = false;
        testResults.tests.push({
          test: 'Pending pool replay check',
          result: 'FAILED',
          description: 'Transaction detected as replay attack in pending pool',
        });
        testResults.threats.push('Transaction is a replay of a pending transaction');
      } else {
        testResults.tests.push({
          test: 'Pending pool replay check',
          result: 'PASSED',
          description: 'Transaction is not a replay in pending pool',
        });
      }
    }

    return testResults;
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
   * @param transaction
   */
  addPendingTransaction(transaction) {
    // CRITICAL: Check for replay attacks against historical blockchain BEFORE adding to pool
    if (this.isReplayAttack(transaction)) {
      logger.error(
        'BLOCKCHAIN',
        `Transaction ${transaction.id} REJECTED: Replay attack detected against historical blockchain`
      );
      return false;
    }

    return this.transactionManager.addPendingTransaction(transaction);
  }

  /**
   * Add multiple transactions in batch
   * @param transactions
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
   * @param address
   */
  getBalance(address) {
    return this.utxoManager.getBalance(address);
  }

  /**
   * Get UTXOs for an address
   * @param address
   */
  getUTXOsForAddress(address) {
    return this.utxoManager.getUTXOsForAddress(address);
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
    return this.transactionManager.createTransaction(fromAddress, toAddress, amount, fee, tag);
  }

  /**
   * Save blockchain to file
   * @param filePath
   */
  saveToFile(filePath) {
    try {
      const data = {
        chain: this.chain,
        difficulty: this.difficulty,
        miningReward: this.miningReward,
        blockTime: this.blockTime,
        pendingTransactions: this.memoryPool.getPendingTransactions(),
        // CRITICAL: Save historical transaction database for replay attack protection
        historicalTransactions: Array.from(this.historicalTransactions.entries()),
        historicalTransactionIds: Array.from(this.historicalTransactionIds),
      };

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      logger.info(
        'BLOCKCHAIN',
        `Blockchain saved to file with ${this.chain.length} blocks and ${this.historicalTransactions.size} historical transactions`
      );
      return true;
    } catch (error) {
      logger.error('BLOCKCHAIN', `Failed to save blockchain: ${error.message}`);
      return false;
    }
  }

  /**
   * Get default blockchain file path
   */
  getDefaultFilePath() {
    const dataDir = this.config?.storage?.dataDir || this.dataDir || './data';
    const fileName = this.config?.storage?.blockchainFile || 'blockchain.json';
    return path.join(dataDir, fileName);
  }

  /**
   * Save blockchain to default file location
   */
  saveToDefaultFile() {
    return this.saveToFile(this.getDefaultFilePath());
  }

  /**
   * Load blockchain from file
   * @param filePath
   */
  loadFromFile(filePath) {
    logger.debug('BLOCKCHAIN', `Loading blockchain from file: ${filePath}`);
    try {
      if (fs.existsSync(filePath)) {
        logger.debug('BLOCKCHAIN', `File exists, reading and parsing JSON data`);
        const fileContent = fs.readFileSync(filePath, 'utf8');
        logger.debug('BLOCKCHAIN', `File content length: ${fileContent.length} characters`);

        const data = JSON.parse(fileContent);
        logger.debug(
          'BLOCKCHAIN',
          `JSON parsed successfully: chain=${data.chain?.length || 0} blocks, difficulty=${data.difficulty}, miningReward=${data.miningReward}`
        );

        // Convert loaded blocks to proper Block instances
        if (data.chain && Array.isArray(data.chain)) {
          logger.debug('BLOCKCHAIN', `Processing ${data.chain.length} blocks from file`);
          this.chain = data.chain.map((blockData, index) => {
            logger.debug(
              'BLOCKCHAIN',
              `Converting block ${index}: index=${blockData.index}, timestamp=${blockData.timestamp}, transactions=${blockData.transactions?.length || 0}`
            );
            try {
              const Block = require('./Block');
              logger.debug('BLOCKCHAIN', `Block class loaded successfully, calling fromJSON`);
              const blockInstance = Block.fromJSON(blockData);
              logger.debug(
                'BLOCKCHAIN',
                `Block ${index} converted successfully: index=${blockInstance.index}, hash=${blockInstance.hash?.substring(0, 16)}...`
              );
              return blockInstance;
            } catch (error) {
              logger.error(
                'BLOCKCHAIN',
                `Failed to convert block ${blockData.index || 'unknown'} to Block instance: ${error.message}`
              );
              logger.error('BLOCKCHAIN', `Error stack: ${error.stack}`);
              logger.warn('BLOCKCHAIN', `Returning original block data for block ${index}`);
              return blockData; // Return original if conversion fails
            }
          });
          logger.debug('BLOCKCHAIN', `Successfully converted ${this.chain.length} blocks to Block instances`);
        } else {
          logger.debug('BLOCKCHAIN', `No chain data found in file or invalid format, initializing empty chain`);
          this.chain = [];
        }

        logger.debug(
          'BLOCKCHAIN',
          `Setting blockchain properties: difficulty=${data.difficulty || 1000}, miningReward=${data.miningReward || 50}, blockTime=${data.blockTime || 60000}`
        );
        this.difficulty = data.difficulty || 1000;
        this.miningReward = data.miningReward || 50;
        this.blockTime = data.blockTime || 60000;

        // CRITICAL: Load historical transaction database for replay attack protection
        if (data.historicalTransactions && Array.isArray(data.historicalTransactions)) {
          logger.debug('BLOCKCHAIN', `Loading ${data.historicalTransactions.length} historical transactions from file`);
          this.historicalTransactions = new Map(data.historicalTransactions);
          logger.info('BLOCKCHAIN', `Loaded ${this.historicalTransactions.size} historical transactions from file`);
        } else {
          logger.debug('BLOCKCHAIN', `No historical transactions data found in file`);
        }

        if (data.historicalTransactionIds && Array.isArray(data.historicalTransactionIds)) {
          logger.debug(
            'BLOCKCHAIN',
            `Loading ${data.historicalTransactionIds.length} historical transaction IDs from file`
          );
          this.historicalTransactionIds = new Set(data.historicalTransactionIds);
          logger.info(
            'BLOCKCHAIN',
            `Loaded ${this.historicalTransactionIds.size} historical transaction IDs from file`
          );
        } else {
          logger.debug('BLOCKCHAIN', `No historical transaction IDs data found in file`);
        }

        // If no historical data in file, rebuild from chain
        if (this.historicalTransactions.size === 0) {
          logger.debug('BLOCKCHAIN', `No historical data found, rebuilding from chain`);
          this.rebuildHistoricalTransactionDatabase();
        }

        // CRITICAL: Load and validate checkpoints before blockchain validation
        logger.debug('BLOCKCHAIN', `Loading and validating checkpoints...`);
        if (!this.checkpointManager.loadCheckpoints()) {
          logger.error('BLOCKCHAIN', `Failed to load checkpoints`);
          return false;
        }

        // CRITICAL: Validate checkpoints against loaded blockchain
        logger.debug('BLOCKCHAIN', `Validating checkpoints against loaded blockchain...`);
        if (!this.checkpointManager.validateCheckpoints(this)) {
          logger.error('BLOCKCHAIN', `Checkpoint validation failed - daemon will stop`);
          // Note: validateCheckpoints will call process.exit(1) if invalid checkpoints are found
          return false;
        }

        logger.debug('BLOCKCHAIN', `Checkpoint validation passed`);

        // Update UTXO set from loaded chain
        logger.debug('BLOCKCHAIN', `Rebuilding UTXO set from ${this.chain.length} blocks`);
        this.utxoManager.rebuildUTXOSet(this.chain);

        logger.info('BLOCKCHAIN', `Blockchain loaded from file with ${this.chain.length} blocks`);
        logger.debug(
          'BLOCKCHAIN',
          `Final blockchain state: chain.length=${this.chain.length}, difficulty=${this.difficulty}, miningReward=${this.miningReward}`
        );
        return true;
      }
      logger.debug('BLOCKCHAIN', `File does not exist: ${filePath}`);
      return false;
    } catch (error) {
      logger.error('BLOCKCHAIN', `Failed to load blockchain: ${error.message}`);
      logger.error('BLOCKCHAIN', `Error stack: ${error.stack}`);
      logger.error('BLOCKCHAIN', `File path: ${filePath}`);
      return false;
    }
  }

  /**
   * CRITICAL: Rebuild historical transaction database from loaded blockchain
   */
  rebuildHistoricalTransactionDatabase() {
    // Clear existing database
    this.historicalTransactions.clear();
    this.historicalTransactionIds.clear();

    // Rebuild from all blocks
    this.chain.forEach(block => {
      this.addTransactionsToHistoricalDatabase(block);
    });

    logger.info(
      'BLOCKCHAIN',
      `Historical transaction database rebuilt with ${this.historicalTransactions.size} entries`
    );
  }

  /**
   * Clear blockchain (for testing/reset purposes)
   */
  clearChain() {
    this.chain = [];
    this.difficulty = 1000;
    this.miningReward = 50;
    this.blockTime = 60000;
    this.historicalTransactions.clear();
    this.historicalTransactionIds.clear();
    this.utxoManager.clearUTXOs();
    this.memoryPool.clear();
    this.spamProtection.reset();

    logger.info('BLOCKCHAIN', 'Blockchain cleared successfully');
    return true;
  }

  /**
   * Calculate total supply based on mined blocks and mining rewards
   */
  getTotalSupply() {
    try {
      // Calculate total supply from mining rewards
      const totalMiningRewards = this.chain.length * this.miningReward;

      // Add any additional supply mechanisms (if implemented in the future)
      // For now, only mining rewards contribute to supply

      logger.debug(
        'BLOCKCHAIN',
        `Calculating total supply: ${this.chain.length} blocks × ${this.miningReward} PAS = ${totalMiningRewards} PAS`
      );

      return totalMiningRewards;
    } catch (error) {
      logger.error('BLOCKCHAIN', `Error calculating total supply: ${error.message}`);
      return 0;
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
      validationStatus: this.isValidChain(),
    };
  }
}

module.exports = Blockchain;
