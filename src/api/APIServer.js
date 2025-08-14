const path = require('path');
const cors = require('cors');
const express = require('express');

const Block = require('../models/Block.js');
const { Transaction, TransactionInput, TransactionOutput } = require('../models/Transaction.js');
const AuthMiddleware = require('../utils/auth.js');
const { TRANSACTION_TAGS } = require('../utils/constants.js');
const logger = require('../utils/logger.js');
const RateLimiter = require('../utils/rateLimiter.js');
const InputValidator = require('../utils/validation.js');

/**
 *
 */
class APIServer {
  /**
   *
   * @param blockchain
   * @param wallet
   * @param miner
   * @param p2pNetwork
   * @param port
   * @param config
   */
  constructor(blockchain, wallet, miner, p2pNetwork, port = 3002, config = {}) {
    this.blockchain = blockchain;
    this.wallet = wallet;
    this.miner = miner;
    this.p2pNetwork = p2pNetwork;
    this.port = port;
    this.config = config;
    this.app = express();
    this.server = null;
    this.isRunning = false;

    // Initialize rate limiter for DoS protection
    this.rateLimiter = new RateLimiter();

    // Initialize authentication middleware (no API key initially)
    this.auth = new AuthMiddleware();

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup middleware
   */
  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Add rate limiting middleware for DoS protection
    this.app.use((req, res, next) => this.rateLimitMiddleware(req, res, next));

    // Add authentication middleware for sensitive endpoints
    // These endpoints require a valid API key to prevent unauthorized access
    this.app.use('/api/blocks/submit', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/blocks/validate', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/network/connect', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/network/message-validation/reset', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/network/partition-reset', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/blockchain/reset', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/rate-limits*', this.auth.validateApiKey.bind(this.auth));

    this.app.use('/api/blockchain/validate-checkpoints', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/blockchain/checkpoints/clear', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/blockchain/checkpoints/update', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/blockchain/checkpoints/add', this.auth.validateApiKey.bind(this.auth));

    this.app.use('/api/memory-pool/status', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/spam-protection/status', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/spam-protection/reset', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/transactions/batch', this.auth.validateApiKey.bind(this.auth));

    this.app.use('/api/cpu-protection/enable', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/cpu-protection/disable', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/cpu-protection/settings', this.auth.validateApiKey.bind(this.auth));

    this.app.use('/api/batch-processing/config', this.auth.validateApiKey.bind(this.auth));

    this.app.use('/api/mempool/sync', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/mempool/sync/status', this.auth.validateApiKey.bind(this.auth));

    // Add error handling middleware
    this.app.use((error, req, res, _next) => {
      console.error(`❌ API Error: ${error.message}`);
      res.status(500).json({ error: error.message });
    });
  }

  /**
   * Rate limiting middleware for DoS protection
   * @param req
   * @param res
   * @param next
   */
  rateLimitMiddleware(req, res, next) {
    const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    const endpoint = req.path;

    // Debug logging for rate limiting
    logger.debug('RATE_LIMITER', `Processing request: ${req.method} ${endpoint} from ${clientIP}`);

    // Check if request is allowed
    if (!this.rateLimiter.isAllowed(clientIP, endpoint)) {
      const status = this.rateLimiter.getStatus(clientIP, endpoint);

      logger.warn('API', `Rate limited request from ${clientIP} for ${endpoint}`);

      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        rateLimit: {
          limit: status.limit,
          remaining: status.remaining,
          resetTime: new Date(status.resetTime).toISOString(),
          timeUntilReset: status.timeUntilReset,
        },
      });
    }

    // Add rate limit headers to response
    const status = this.rateLimiter.getStatus(clientIP, endpoint);
    res.set({
      'X-RateLimit-Limit': status.limit,
      'X-RateLimit-Remaining': status.remaining,
      'X-RateLimit-Reset': new Date(status.resetTime).toISOString(),
    });

    logger.debug('RATE_LIMITER', `Request allowed: ${req.method} ${endpoint} from ${clientIP}`);
    next();
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    // Root route for testing
    this.app.get('/', (req, res) => {
      res.json({ message: 'Pastella API Server is running!', version: '1.0.0' });
    });

    // Blockchain routes
    this.app.get('/api/blockchain/status', this.getBlockchainStatus.bind(this));
    this.app.get('/api/blockchain/blocks/:index', this.getBlock.bind(this));
    this.app.post('/api/blocks/submit', this.submitBlock.bind(this)); // Behind Key
    this.app.get('/api/blockchain/security', this.getSecurityReport.bind(this));
    this.app.get('/api/blockchain/mempool', this.getMempoolStatus.bind(this));
    this.app.get('/api/blockchain/replay-protection', this.getReplayProtectionAnalysis.bind(this));
    this.app.post('/api/blockchain/test-replay-protection', this.testReplayProtection.bind(this));
    this.app.get('/api/blockchain/consensus', this.getConsensusStatus.bind(this));
    this.app.get('/api/blockchain/security-analysis', this.getSecurityAnalysis.bind(this));
    this.app.post('/api/blockchain/validator-signature', this.addValidatorSignature.bind(this));
    this.app.post('/api/blockchain/reset', this.resetBlockchain.bind(this)); // Behind Key
    this.app.get('/api/blockchain/blocks', this.getBlocks.bind(this));
    this.app.get('/api/blockchain/latest', this.getLatestBlock.bind(this));
    this.app.get('/api/blockchain/transactions', this.getPendingTransactions.bind(this));
    this.app.get('/api/blockchain/transactions/:txId', this.getTransaction.bind(this));
    this.app.post('/api/blockchain/transactions', this.submitTransaction.bind(this));
    this.app.get('/api/blockchain/memory-protection', this.getMemoryProtectionStatus.bind(this));
    this.app.get('/api/blockchain/cpu-protection', this.getCPUProtectionStatus.bind(this));
    this.app.get('/api/network/reputation-status', this.getReputationStatus.bind(this));

    // Block submission routes
    this.app.get('/api/blocks/pending', this.getPendingBlocks.bind(this));
    this.app.post('/api/blocks/validate', this.validateBlock.bind(this)); // Behind Key

    // Network routes
    this.app.get('/api/network/status', this.getNetworkStatus.bind(this));
    this.app.get('/api/network/peers', this.getPeers.bind(this));
    this.app.post('/api/network/connect', this.connectToPeer.bind(this)); // Behind Key

    // Reputation routes
    this.app.get('/api/network/reputation', this.getReputationStats.bind(this));
    this.app.get('/api/network/reputation/:peerAddress', this.getPeerReputation.bind(this));

    // Message validation endpoints
    this.app.get('/api/network/message-validation', this.getMessageValidationStats.bind(this));
    this.app.post('/api/network/message-validation/reset', this.resetMessageValidationStats.bind(this)); // Behind Key

    // Partition handling endpoints
    this.app.get('/api/network/partition-stats', this.getPartitionStats.bind(this));
    this.app.post('/api/network/partition-reset', this.resetPartitionStats.bind(this)); // Behind Key

    // Daemon routes
    this.app.get('/api/daemon/status', this.getDaemonStatus.bind(this));

    // Rate limiting management routes (protected by API key)
    this.app.get('/api/rate-limits/stats', this.getRateLimitStats.bind(this)); // Behind Key
    this.app.post('/api/rate-limits/reset/:ip', this.resetRateLimitsForIP.bind(this)); // Behind Key
    this.app.post('/api/rate-limits/reset-all', this.resetAllRateLimits.bind(this)); // Behind Key

    // NEW FEATURES: Memory pool and spam protection routes (protected by API key)
    this.app.get('/api/memory-pool/status', this.getMemoryPoolStatus.bind(this)); // Behind Key
    this.app.get('/api/spam-protection/status', this.getSpamProtectionStatus.bind(this)); // Behind Key
    this.app.post('/api/spam-protection/reset', this.resetSpamProtection.bind(this)); // Behind Key
    this.app.post('/api/transactions/batch', this.addTransactionBatch.bind(this)); // Behind Key

    // CPU Protection management routes (protected by API key)
    this.app.post('/api/cpu-protection/enable', this.setCpuProtection.bind(this)); // Behind Key
    this.app.post('/api/cpu-protection/disable', this.setCpuProtection.bind(this)); // Behind Key
    this.app.post('/api/cpu-protection/settings', this.updateCpuProtection.bind(this)); // Behind Key

    // Batch Processing configuration route (protected by API key)
    this.app.get('/api/batch-processing/config', this.getBatchProcessingConfig.bind(this)); // Behind Key

    // Mempool synchronization routes (protected by API key)
    this.app.post('/api/mempool/sync', this.syncMempoolWithPeers.bind(this)); // Behind Key
    this.app.get('/api/mempool/sync/status', this.getMempoolSyncStatus.bind(this)); // Behind Key

    // Checkpoint endpoints
    this.app.get('/api/blockchain/checkpoints', this.getCheckpoints.bind(this));
    this.app.post('/api/blockchain/checkpoints/add', this.addCheckpoint.bind(this)); // Behind Key
    this.app.post('/api/blockchain/checkpoints/update', this.updateCheckpoints.bind(this)); // Behind Key
    this.app.post('/api/blockchain/checkpoints/clear', this.clearCheckpoints.bind(this)); // Behind Key
    this.app.post('/api/blockchain/validate-checkpoints', this.validateCheckpoints.bind(this)); // Behind Key

    // Utility routes (always available)
    this.app.get('/api/health', this.getHealth.bind(this));
    this.app.get('/api/info', this.getInfo.bind(this));
  }

  /**
   * Set API key for authentication
   * @param {string} apiKey - The API key to use for authentication
   */
  setApiKey(apiKey) {
    if (apiKey && typeof apiKey === 'string' && apiKey.length > 0) {
      this.auth.updateApiKey(apiKey);
    } else {
      // Don't clear the existing API key if called with invalid value
      if (apiKey === null || apiKey === undefined) {
        return;
      }
      this.auth.updateApiKey(null);
    }
  }

  /**
   * Start API server
   */
  start() {
    if (this.isRunning) {
      console.log('API server is already running');
      return false;
    }

    // Get host binding from config (defaults to 127.0.0.1 for security)
    const host = this.config.api?.host || '127.0.0.1';

    // Log the binding information at the beginning using consistent logger style
    logger.info('API', `API Server: http://${host}:${this.port}`);

    // Security warning for external binding
    if (host !== '127.0.0.1' && host !== 'localhost') {
      logger.warn('API', `API server bound to external interface: ${host}`);
      logger.warn('API', `Ensure your network is secure and API key authentication is enabled!`);
    } else {
      logger.info('API', `API server bound to localhost-only for security`);
    }

    this.server = this.app.listen(this.port, host, () => {
      this.isRunning = true;
    });

    // Add error handling
    this.server.on('error', error => {
      console.error(`❌ API Server error: ${error.message}`);
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${this.port} is already in use`);
      } else if (error.code === 'EACCES') {
        console.error(`Permission denied binding to ${host}:${this.port}`);
        console.error(`Try using a different port or run with elevated privileges`);
      } else if (error.code === 'EADDRNOTAVAIL') {
        console.error(`Address ${host} is not available on this system`);
        console.error(`Check your network configuration and try again`);
      }
    });

    return true;
  }

  /**
   * Stop API server
   */
  stop() {
    if (!this.isRunning) {
      console.log('API server is not running');
      return false;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.isRunning = false;
    console.log('API server stopped');
    return true;
  }

  // Blockchain endpoints
  /**
   *
   * @param req
   * @param res
   */
  getBlockchainStatus(req, res) {
    try {
      const status = this.blockchain.getStatus();
      // Ensure compatibility with wallet sync by adding height property
      res.json({
        ...status,
        height: status.chainLength,
        networkId: this.config.networkId || 'unknown',
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getSecurityReport(req, res) {
    try {
      const securityReport = this.blockchain.getSecurityReport();
      res.json(securityReport);
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getReplayProtectionStats(req, res) {
    try {
      const replayProtectionStats = this.blockchain.getReplayProtectionStats();
      res.json(replayProtectionStats);
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getMempoolStatus(req, res) {
    try {
      const mempoolStatus = {
        pendingTransactions: this.blockchain.memoryPool.getPendingTransactionCount(),
        memoryUsage: this.blockchain.memoryPool.estimateMemoryUsage(),
        poolSize: this.blockchain.memoryPool.getPendingTransactions().length,
        recentTransactions: this.blockchain.memoryPool
          .getPendingTransactions()
          .slice(-10)
          .map(tx => ({
            id: tx.id,
            fee: tx.fee,
            timestamp: tx.timestamp,
            isExpired: tx.isExpired ? tx.isExpired() : false,
          })),
      };
      res.json(mempoolStatus);
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getReplayProtectionAnalysis(req, res) {
    try {
      const analysis = this.blockchain.getReplayProtectionAnalysis();
      res.json(analysis);
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  testReplayProtection(req, res) {
    try {
      // Create a test transaction with replay protection
      const testInputs = [new TransactionInput('test-tx-hash', 0, 'test-signature', 'test-public-key')];

      const testOutputs = [new TransactionOutput('test-address', 10)];

              const testTransaction = new Transaction(testInputs, testOutputs, 0.001, TRANSACTION_TAGS.TRANSACTION, Date.now());
      testTransaction.calculateId();

      // Test the replay protection
      const testResults = this.blockchain.testReplayProtection(testTransaction);

      res.json({
        message: 'Replay protection test completed',
        testTransaction: {
          id: testTransaction.id,
          nonce: testTransaction.nonce,
          expiresAt: testTransaction.expiresAt,
          isExpired: testTransaction.isExpired(),
        },
        testResults,
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getConsensusStatus(req, res) {
    try {
      const consensusStatus = this.blockchain.getConsensusStatus();
      res.json(consensusStatus);
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getSecurityAnalysis(req, res) {
    try {
      const securityAnalysis = {
        timestamp: new Date().toISOString(),
        blockchain: {
          height: this.blockchain.getHeight(),
          difficulty: this.blockchain.difficulty,
          lastBlockHash: this.blockchain.getLatestBlock()?.hash || 'none',
        },
        consensus: this.blockchain.getConsensusStatus(),
        replayProtection: this.blockchain.getReplayProtectionStats(),
        threats: this._analyzeThreats(),
        recommendations: this._generateSecurityRecommendations(),
      };

      res.json(securityAnalysis);
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  addValidatorSignature(req, res) {
    try {
      const { blockHash, validatorAddress, stakeAmount } = req.body;

      // Input validation
      if (!blockHash || !validatorAddress || !stakeAmount) {
        return res.status(400).json({
          error: 'Missing required fields: blockHash, validatorAddress, stakeAmount',
        });
      }

      // Validate inputs
      const validatedHash = InputValidator.validateHash(blockHash);
      const validatedAddress = InputValidator.validateCryptocurrencyAddress(validatorAddress);
      const validatedStake = InputValidator.validateAmount(stakeAmount, { min: 0 });

      if (!validatedHash || !validatedAddress || validatedStake === null) {
        return res.status(400).json({
          error: 'Invalid input data',
        });
      }

      // Add validator signature
      this.blockchain.addValidatorSignature(validatedHash, validatedAddress, validatedStake);

      res.json({
        success: true,
        message: 'Validator signature added successfully',
        blockHash: validatedHash,
        validator: validatedAddress,
        stake: validatedStake,
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   * CRITICAL: Analyze current security threats
   */
  _analyzeThreats() {
    const threats = [];

    try {
      const consensus = this.blockchain.getConsensusStatus();

      // Check for 51% attack indicators
      if (consensus.miningPowerDistribution.length > 0) {
        const topMiner = consensus.miningPowerDistribution[0];
        if (parseFloat(topMiner.share) > 40) {
          threats.push({
            type: '51%_ATTACK_RISK',
            severity: 'HIGH',
            description: `Top miner controls ${topMiner.share}% of network hash rate`,
            recommendation: 'Implement additional consensus mechanisms and monitor closely',
          });
        }
      }

      // Check for network partition
      if (consensus.networkPartition) {
        threats.push({
          type: 'NETWORK_PARTITION',
          severity: 'MEDIUM',
          description: 'Network partition detected - consecutive late blocks',
          recommendation: 'Investigate network connectivity and peer synchronization',
        });
      }

      // Check for suspicious miners
      if (consensus.suspiciousMiners.length > 0) {
        threats.push({
          type: 'SUSPICIOUS_ACTIVITY',
          severity: 'MEDIUM',
          description: `${consensus.suspiciousMiners.length} miners flagged for suspicious activity`,
          recommendation: 'Review mining patterns and implement additional monitoring',
        });
      }

      // Check security level
      if (consensus.securityLevel < 70) {
        threats.push({
          type: 'LOW_SECURITY_LEVEL',
          severity: 'HIGH',
          description: `Overall security level is ${consensus.securityLevel}/100`,
          recommendation: 'Immediate security review and mitigation required',
        });
      }
    } catch (error) {
      threats.push({
        type: 'ANALYSIS_ERROR',
        severity: 'HIGH',
        description: `Failed to analyze threats: ${error.message}`,
        recommendation: 'Check system logs and restart security monitoring',
      });
    }

    return threats;
  }

  /**
   * CRITICAL: Generate security recommendations
   */
  _generateSecurityRecommendations() {
    const recommendations = [];

    try {
      const consensus = this.blockchain.getConsensusStatus();

      if (consensus.securityLevel < 80) {
        recommendations.push({
          priority: 'HIGH',
          action: 'Implement additional consensus validators',
          description: 'Add more proof-of-stake validators to improve network security',
        });
      }

      if (consensus.miningPowerDistribution.length > 0) {
        const topMiner = consensus.miningPowerDistribution[0];
        if (parseFloat(topMiner.share) > 30) {
          recommendations.push({
            priority: 'MEDIUM',
            action: 'Diversify mining power',
            description: 'Encourage more miners to join the network to reduce centralization',
          });
        }
      }

      if (consensus.validatorCount < 10) {
        recommendations.push({
          priority: 'MEDIUM',
          action: 'Increase validator count',
          description: 'Aim for at least 10 active validators for robust consensus',
        });
      }

      recommendations.push({
        priority: 'LOW',
        action: 'Regular security audits',
        description: 'Conduct monthly security audits and penetration testing',
      });
    } catch (error) {
      recommendations.push({
        priority: 'HIGH',
        action: 'System recovery',
        description: `System error detected: ${error.message}. Immediate attention required.`,
      });
    }

    return recommendations;
  }

  /**
   *
   * @param req
   * @param res
   */
  resetBlockchain(req, res) {
    try {
      // Clear the blockchain and create new genesis block
      this.blockchain.clearChain();

      // Create new genesis block with mandatory replay protection
      const genesisConfig = {
        premineAmount: 1000000, // 1 million PAS
        premineAddress: 'genesis-address',
        nonce: 0,
        hash: null, // Will be calculated
        algorithm: 'kawpow',
      };

      this.blockchain.initializeBlockchain(genesisConfig, true);

      res.json({
        success: true,
        message: 'Blockchain reset successfully with mandatory replay protection',
        genesisBlock: this.blockchain.chain[0]?.toJSON(),
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getBlocks(req, res) {
    try {
      // Input validation for limit parameter
      const validatedLimit =
        InputValidator.validateNumber(req.query.limit, {
          min: 1,
          max: 1000,
          integer: true,
        }) || 10;

      const blocks = this.blockchain.chain.slice(-validatedLimit).map(block => {
        // Check if block has toJSON method, if not, convert to proper Block object
        if (typeof block.toJSON === 'function') {
          return block.toJSON();
        }
        // Convert plain object to Block instance and then to JSON
        const blockInstance = Block.fromJSON(block);
        return blockInstance.toJSON();
      });

      res.json({
        blocks,
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getBlock(req, res) {
    try {
      // Input validation for block index
      const validatedIndex = InputValidator.validateNumber(req.params.index, {
        required: true,
        min: 0,
        integer: true,
      });

      if (validatedIndex === null) {
        return res.status(400).json({
          error: 'Invalid block index',
        });
      }

      const block = this.blockchain.chain[validatedIndex];

      if (!block) {
        return res.status(404).json({
          error: 'Block not found',
        });
      }

      // Check if block has toJSON method, if not, convert to proper Block object
      if (typeof block.toJSON === 'function') {
        res.json(block.toJSON());
      } else {
        // Convert plain object to Block instance and then to JSON
        const blockInstance = Block.fromJSON(block);
        res.json(blockInstance.toJSON());
      }
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getLatestBlock(req, res) {
    try {
      const latestBlock = this.blockchain.getLatestBlock();

      // Check if block has toJSON method, if not, convert to proper Block object
      if (typeof latestBlock.toJSON === 'function') {
        res.json(latestBlock.toJSON());
      } else {
        // Convert plain object to Block instance and then to JSON
        const blockInstance = Block.fromJSON(latestBlock);
        res.json(blockInstance.toJSON());
      }
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getPendingTransactions(req, res) {
    try {
      const transactions = this.blockchain.memoryPool.getPendingTransactions().map(tx => tx.toJSON());
      res.json({
        transactions,
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getTransaction(req, res) {
    try {
      // Input validation for transaction ID
      const validatedTxId = InputValidator.validateString(req.params.txId, {
        required: true,
        minLength: 1,
        maxLength: 100,
      });

      if (!validatedTxId) {
        return res.status(400).json({
          error: 'Invalid transaction ID',
        });
      }

      // Search in pending transactions
      let transaction = this.blockchain.memoryPool.getPendingTransactions().find(tx => tx.id === validatedTxId);

      // Search in blockchain
      if (!transaction) {
        transaction = this.blockchain.chain
          .find(block => block.transactions.find(tx => tx.id === validatedTxId))
          ?.transactions.find(tx => tx.id === validatedTxId);
      }

      if (!transaction) {
        return res.status(404).json({
          error: 'Transaction not found',
        });
      }

      res.json(transaction.toJSON());
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  submitTransaction(req, res) {
    try {
      const { transaction } = req.body;

      // Input validation
      if (!transaction) {
        return res.status(400).json({ error: 'Transaction data is required' });
      }

      // Validate transaction structure with InputValidator
      const transactionSchema = {
        id: value => InputValidator.validateString(value, { required: true, minLength: 1, maxLength: 100 }),
        inputs: value =>
          InputValidator.validateArray(
            value,
            input => {
              const result = InputValidator.validateObject(input, {
                txId: v => InputValidator.validateHash(v, { required: true }),
                outputIndex: v => InputValidator.validateNumber(v, { required: true, integer: true, min: 0 }),
                signature: v => InputValidator.validateString(v, { required: true, minLength: 1 }),
                publicKey: v => InputValidator.validateString(v, { required: true, minLength: 1 }),
              });
              return result;
            },
            { required: true, minLength: 1 }
          ),
        outputs: value =>
          InputValidator.validateArray(
            value,
            output => {
              // First validate the required fields (address, amount)
              const baseValidation = InputValidator.validateObject(output, {
                address: v => InputValidator.validateAddress(v, { required: true }),
                amount: v => InputValidator.validateAmount(v, { required: true, min: 0 }, this.config.decimals || 8),
              });

              if (!baseValidation) {
                return null;
              }

              // Add the tag field to the validated output
              const result = {
                ...baseValidation,
                tag: TRANSACTION_TAGS.TRANSACTION,
              };

              return result;
            },
            { required: true, minLength: 1 }
          ),
        fee: value => InputValidator.validateNumber(value, { required: true, min: 0 }),
        timestamp: value => InputValidator.validateNumber(value, { required: true, min: 0 }),
        isCoinbase: value =>
          // Boolean validation - just return the value as is
          value,
        tag: value =>
          // Tag validation - just return the value as is
          value,
        nonce: value =>
          // Nonce validation for replay protection
          InputValidator.validateString(value, { required: false, minLength: 1, maxLength: 100 }),
        expiresAt: value =>
          // Expiration validation for replay protection
          InputValidator.validateNumber(value, { required: false, min: 0 }),
        sequence: value =>
          // Sequence validation for replay protection
          InputValidator.validateNumber(value, { required: false, integer: true, min: 0 }),
      };

      const validatedTransaction = InputValidator.validateObject(transaction, transactionSchema);

      if (!validatedTransaction) {
        logger.error('API', `Transaction validation failed for transaction ${transaction.id || 'unknown'}`);
        return res.status(400).json({
          error: 'Invalid transaction structure or data',
          details: 'Check transaction format and required fields',
        });
      }

      // Validate minimum fee if configured
      if (this.config.wallet && this.config.wallet.minFee !== undefined) {
        if (!validatedTransaction.fee || validatedTransaction.fee < this.config.wallet.minFee) {
          return res.status(400).json({
            error: `Transaction fee must be at least ${this.config.wallet.minFee} PAS`,
            minFee: this.config.wallet.minFee,
            providedFee: validatedTransaction.fee || 0,
          });
        }
      }

      // Convert validated transaction to Transaction instance if needed
      let transactionInstance = validatedTransaction;
      if (typeof validatedTransaction === 'object' && !validatedTransaction.isValid) {
        try {
          transactionInstance = Transaction.fromJSON(validatedTransaction);
        } catch (error) {
          logger.error('API', `Failed to convert transaction to Transaction instance: ${error.message}`);
          return res.status(400).json({
            error: 'Invalid transaction format',
            details: 'Could not create transaction instance',
          });
        }
      }

      // Add transaction to mempool
      let success;
      try {
        success = this.blockchain.addPendingTransaction(transactionInstance);
      } catch (error) {
        logger.error('API', `Error in addPendingTransaction: ${error.message}`);
        return res.status(500).json({
          error: 'Failed to add transaction to mempool',
          details: error.message,
        });
      }

      if (!success) {
        return res.status(400).json({ error: 'Failed to add transaction to mempool' });
      }

      res.json({
        success: true,
        transactionId: validatedTransaction.id,
        message: 'Transaction submitted successfully',
      });
    } catch (error) {
      logger.error('API', `Unexpected error in submitTransaction: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  }

  // Network endpoints
  /**
   *
   * @param req
   * @param res
   */
  getNetworkStatus(req, res) {
    try {
      const status = this.p2pNetwork.getNetworkStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getPeers(req, res) {
    try {
      const peers = this.p2pNetwork.getPeerList();
      res.json({
        peers,
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  connectToPeer(req, res) {
    try {
      const { host, port } = req.body;

      // Input validation
      const validatedHost = InputValidator.validateString(host, {
        required: true,
        minLength: 1,
        maxLength: 255,
      });

      const validatedPort = InputValidator.validatePort(port, { required: true });

      if (!validatedHost || !validatedPort) {
        return res.status(400).json({
          error: 'Invalid host or port parameters',
        });
      }

      this.p2pNetwork.connectToPeer(validatedHost, validatedPort);

      res.json({
        success: true,
        message: `Connecting to peer ${validatedHost}:${validatedPort}`,
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  // Daemon endpoints
  /**
   *
   * @param req
   * @param res
   */
  getDaemonStatus(req, res) {
    logger.debug('API', `Daemon status request received`);
    logger.debug('API', `Request headers: ${JSON.stringify(req.headers)}`);

    try {
      logger.debug('API', `Gathering daemon status information...`);

      const apiStatus = {
        isRunning: this.isRunning,
        port: this.port,
      };
      logger.debug('API', `API status: ${JSON.stringify(apiStatus)}`);

      const networkStatus = {
        isRunning: this.p2pNetwork ? this.p2pNetwork.isRunning : false,
        port: this.p2pNetwork ? this.p2pNetwork.port : null,
      };
      logger.debug('API', `Network status: ${JSON.stringify(networkStatus)}`);

      const blockchainHeight = this.blockchain.chain.length;
      const { difficulty } = this.blockchain;
      const pendingTransactions = this.blockchain.memoryPool.getPendingTransactionCount();

      const blockchainStatus = {
        height: blockchainHeight,
        difficulty,
        pendingTransactions,
      };
      logger.debug(
        'API',
        `Blockchain status: height=${blockchainHeight}, difficulty=${difficulty}, pendingTransactions=${pendingTransactions}`
      );

      const status = {
        isRunning: true,
        api: apiStatus,
        network: networkStatus,
        blockchain: blockchainStatus,
      };

      logger.debug('API', `Daemon status response prepared successfully`);
      logger.debug('API', `Full response data: ${JSON.stringify(status)}`);

      res.json(status);
    } catch (error) {
      logger.error('API', `Error getting daemon status: ${error.message}`);
      logger.error('API', `Error stack: ${error.stack}`);
      logger.error('API', `Request details: headers=${JSON.stringify(req.headers)}`);

      res.status(500).json({
        error: 'Internal server error while getting daemon status',
        details: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Utility endpoints
  /**
   *
   * @param req
   * @param res
   */
  getHealth(req, res) {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  }

  /**
   *
   * @param req
   * @param res
   */
  getInfo(req, res) {
    res.json({
      name: this.config.name,
      ticker: this.config.ticker,
      version: '1.0.0',
      networkId: this.config.networkId || 'unknown',
      uptime: process.uptime(),
      apiPort: this.port,
      p2pPort: this.p2pPort,
      height: this.blockchain.chain.length,
      difficulty: this.blockchain.difficulty,
      pendingTransactions: this.blockchain.memoryPool.getPendingTransactionCount(),
      blockTime: this.config.blockchain.blockTime,
      coinbaseReward: this.config.blockchain.coinbaseReward,
      premineReward: this.config.blockchain.genesis.premineAmount,
      defaultFee: this.config.wallet.defaultFee,
      minFee: this.config.wallet.minFee,
      description: '',
    });
  }

  // Block submission endpoints
  /**
   *
   * @param req
   * @param res
   */
  submitBlock(req, res) {
    logger.debug('API', `Block submission request received`);
    logger.debug('API', `Request body: ${JSON.stringify(req.body)}`);
    logger.debug('API', `Request headers: ${JSON.stringify(req.headers)}`);

    try {
      const { block } = req.body;
      logger.debug('API', `Extracted block data: ${block ? 'present' : 'missing'}`);

      if (!block) {
        logger.debug('API', `Block submission failed: no block data in request body`);
        return res.status(400).json({
          error: 'Block data is required',
        });
      }

      logger.debug(
        'API',
        `Block data received: index=${block.index}, timestamp=${block.timestamp}, transactions=${block.transactions?.length || 0}`
      );
      logger.debug(
        'API',
        `Block hash: ${block.hash?.substring(0, 16) || 'none'}..., previousHash: ${block.previousHash?.substring(0, 16) || 'none'}...`
      );

      // Import Block class
      logger.debug('API', `Block class available`);

      // Create block object from JSON
      logger.debug('API', `Creating Block instance from JSON data`);
      const blockObj = Block.fromJSON(block);
      logger.debug(
        'API',
        `Block instance created: index=${blockObj.index}, hash=${blockObj.hash?.substring(0, 16)}...`
      );
      logger.debug(
        'API',
        `Block instance type: ${typeof blockObj}, has isValid: ${typeof blockObj.isValid === 'function'}`
      );

      // Validate block
      logger.debug('API', `Validating block ${blockObj.index}`);
      try {
        const isValidResult = blockObj.isValid();
        logger.debug('API', `Block validation result: ${isValidResult}`);

        if (!isValidResult) {
          logger.debug('API', `Block ${blockObj.index} validation failed`);
          return res.status(400).json({
            error: 'Invalid block submitted',
            details: 'Block validation failed',
          });
        }
        logger.debug('API', `Block ${blockObj.index} validation passed`);
      } catch (validationError) {
        logger.error('API', `Block validation error: ${validationError.message}`);
        logger.error('API', `Validation error stack: ${validationError.stack}`);
        return res.status(400).json({
          error: 'Block validation error',
          details: validationError.message,
        });
      }

      // Check if block already exists
      logger.debug('API', `Checking if block ${blockObj.index} already exists in chain`);
      const existingBlock = this.blockchain.chain.find(b => b.hash === blockObj.hash);
      if (existingBlock) {
        logger.debug('API', `Block ${blockObj.index} already exists in chain at index ${existingBlock.index}`);
        return res.status(409).json({
          error: 'Block already exists in chain',
          details: `Block with hash ${blockObj.hash.substring(0, 16)}... already exists at index ${existingBlock.index}`,
        });
      }
      logger.debug('API', `Block ${blockObj.index} is not a duplicate`);

      // Add block to blockchain
      logger.debug('API', `Adding block ${blockObj.index} to blockchain`);
      const addResult = this.blockchain.addBlock(blockObj);
      logger.debug('API', `Blockchain addBlock result: ${addResult}`);

      if (addResult) {
        logger.debug('API', `Block ${blockObj.index} added to blockchain successfully`);

        // Broadcast to network
        try {
          logger.debug('API', `Broadcasting new block to P2P network`);
          if (this.p2pNetwork) {
            this.p2pNetwork.broadcastNewBlock(blockObj);
            logger.debug('API', `Block broadcasted successfully`);
          } else {
            logger.debug('API', `P2P network not available, skipping broadcast`);
          }
        } catch (broadcastError) {
          logger.warn('API', `Failed to broadcast block: ${broadcastError.message}`);
          logger.debug('API', `Broadcast error stack: ${broadcastError.stack}`);
        }

        // Save blockchain immediately
        try {
          this.blockchain.saveToDefaultFile();
          logger.debug('API', `Blockchain saved immediately after API block submission`);
        } catch (saveError) {
          logger.warn('API', `Failed to save blockchain immediately: ${saveError.message}`);
        }

        logger.debug('API', `Sending success response for block ${blockObj.index}`);
        res.json({
          success: true,
          message: 'Block submitted successfully',
          block: {
            index: blockObj.index,
            hash: blockObj.hash,
            timestamp: blockObj.timestamp,
          },
        });
      } else {
        logger.debug('API', `Failed to add block ${blockObj.index} to blockchain`);
        res.status(400).json({
          error: 'Failed to add block to chain',
          details: 'Blockchain rejected the block',
        });
      }
    } catch (error) {
      logger.error('API', `Block submission error: ${error.message}`);
      logger.error('API', `Error stack: ${error.stack}`);
      logger.error('API', `Request body: ${JSON.stringify(req.body)}`);

      res.status(500).json({
        error: 'Internal server error during block submission',
        details: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getPendingBlocks(req, res) {
    try {
      const pendingTransactions = this.blockchain.memoryPool.getPendingTransactions();

      // Group transactions by potential block
      const blockGroups = [];
      let currentGroup = [];
      let currentSize = 0;

      pendingTransactions.forEach(tx => {
        if (currentSize + tx.size > this.config.blockchain.blockSize) {
          blockGroups.push(currentGroup);
          currentGroup = [];
          currentSize = 0;
        }
        currentGroup.push(tx);
        currentSize += tx.size;
      });
      if (currentGroup.length > 0) {
        blockGroups.push(currentGroup);
      }

      res.json({
        pendingTransactions: blockGroups.map(group => ({
          transactions: group.map(tx => tx.toJSON()),
          totalSize: group.reduce((sum, tx) => sum + tx.size, 0),
        })),
        count: blockGroups.length,
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  validateBlock(req, res) {
    try {
      const { block } = req.body;

      if (!block) {
        return res.status(400).json({
          error: 'Block data is required',
        });
      }

      // Create block object from JSON
      const blockObj = Block.fromJSON(block);

      // Validate block
      const isValid = blockObj.isValid();

      res.json({
        valid: isValid,
        block: {
          index: blockObj.index,
          hash: blockObj.hash,
          timestamp: blockObj.timestamp,
          difficulty: blockObj.difficulty,
          nonce: blockObj.nonce,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  // Reputation endpoints
  /**
   *
   * @param req
   * @param res
   */
  getReputationStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available',
        });
      }

      const stats = this.p2pNetwork.getReputationStats();
      res.json({
        reputation: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getPeerReputation(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available',
        });
      }

      // Input validation for peer address
      const validatedPeerAddress = InputValidator.validateString(req.params.peerAddress, {
        required: true,
        minLength: 1,
        maxLength: 255,
      });

      if (!validatedPeerAddress) {
        return res.status(400).json({
          error: 'Invalid peer address',
        });
      }

      const reputation = this.p2pNetwork.getPeerReputation(validatedPeerAddress);
      res.json({
        peerAddress: validatedPeerAddress,
        reputation,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: error.message,
      });
    }
  }

  // Message validation endpoints
  /**
   *
   * @param req
   * @param res
   */
  getMessageValidationStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available',
        });
      }

      const stats = this.p2pNetwork.getMessageValidationStats();
      res.json({
        ...stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting message validation stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  resetMessageValidationStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available',
        });
      }

      this.p2pNetwork.resetMessageValidationStats();
      res.json({
        message: 'Message validation statistics reset successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error resetting message validation stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getPartitionStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available',
        });
      }

      const stats = this.p2pNetwork.partitionHandler.getPartitionStats();
      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting partition stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  resetPartitionStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available',
        });
      }

      this.p2pNetwork.partitionHandler.resetPartitionStats();
      res.json({
        success: true,
        message: 'Partition statistics reset successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error resetting partition stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Rate limiting management endpoints
  /**
   *
   * @param req
   * @param res
   */
  getRateLimitStats(req, res) {
    try {
      const stats = this.rateLimiter.getStats();
      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting rate limit stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  resetRateLimitsForIP(req, res) {
    try {
      const { ip } = req.params;
      if (!ip || ip === 'unknown') {
        return res.status(400).json({
          error: 'Invalid IP address',
        });
      }

      const resetCount = this.rateLimiter.resetForIP(ip);
      res.json({
        success: true,
        message: `Rate limits reset for IP ${ip}`,
        resetEndpoints: resetCount,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error resetting rate limits for IP: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  resetAllRateLimits(req, res) {
    try {
      const resetCount = this.rateLimiter.resetAll();
      res.json({
        success: true,
        message: 'All rate limits reset successfully',
        resetEntries: resetCount,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error resetting all rate limits: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // NEW FEATURES: Memory pool and spam protection management endpoints
  /**
   *
   * @param req
   * @param res
   */
  getMemoryPoolStatus(req, res) {
    try {
      const status = this.blockchain.manageMemoryPool();
      res.json({
        success: true,
        data: {
          poolSize: status.poolSize,
          memoryUsage: status.memoryUsage,
          actions: status.actions,
          maxPoolSize: this.config?.memory?.maxPoolSize || 10000,
          maxMemoryUsage: (this.config?.memory?.maxMemoryUsage || 2048) * 1024 * 1024, // Convert MB to bytes
          cpuProtection: status.cpuProtection,
          batchProcessing: this.blockchain.memoryPool.getBatchProcessingConfig(),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting memory pool status: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Enable or disable CPU protection
   * @param req
   * @param res
   */
  setCpuProtection(req, res) {
    try {
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          error: 'Invalid request: enabled must be a boolean',
        });
      }

      this.blockchain.memoryPool.memoryProtection.setCpuProtection(enabled);

      res.json({
        success: true,
        message: `CPU protection ${enabled ? 'enabled' : 'disabled'} successfully`,
        data: {
          cpuProtectionEnabled: enabled,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error setting CPU protection: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Update CPU protection settings
   * @param req
   * @param res
   */
  updateCpuProtection(req, res) {
    try {
      const { maxCpuUsage, monitoringInterval, cleanupInterval } = req.body;

      const settings = {};
      if (maxCpuUsage !== undefined) {
        if (typeof maxCpuUsage !== 'number' || maxCpuUsage < 1 || maxCpuUsage > 100) {
          return res.status(400).json({
            error: 'Invalid maxCpuUsage: must be a number between 1 and 100',
          });
        }
        settings.maxCpuUsage = maxCpuUsage;
      }

      if (monitoringInterval !== undefined) {
        if (typeof monitoringInterval !== 'number' || monitoringInterval < 1000) {
          return res.status(400).json({
            error: 'Invalid monitoringInterval: must be a number >= 1000ms',
          });
        }
        settings.monitoringInterval = monitoringInterval;
      }

      if (cleanupInterval !== undefined) {
        if (typeof cleanupInterval !== 'number' || cleanupInterval < 1000) {
          return res.status(400).json({
            error: 'Invalid cleanupInterval: must be a number >= 1000ms',
          });
        }
        settings.cleanupInterval = cleanupInterval;
      }

      this.blockchain.memoryPool.memoryProtection.updateCpuProtection(settings);

      res.json({
        success: true,
        message: 'CPU protection settings updated successfully',
        data: settings,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error updating CPU protection: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Get batch processing configuration
   * @param req
   * @param res
   */
  getBatchProcessingConfig(req, res) {
    try {
      const config = this.blockchain.memoryPool.getBatchProcessingConfig();

      res.json({
        success: true,
        data: config,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting batch processing config: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getSpamProtectionStatus(req, res) {
    try {
      const bannedAddresses = Array.from(this.blockchain.spamProtection.spamProtection.bannedAddresses);
      const rateLimitData = Array.from(this.blockchain.spamProtection.addressRateLimits.entries()).map(
        ([address, data]) => ({
          address,
          count: data.count,
          firstTx: new Date(data.firstTx).toISOString(),
          banTime: data.banTime ? new Date(data.banTime).toISOString() : null,
        })
      );

      res.json({
        success: true,
        data: {
          bannedAddresses,
          rateLimitData,
          maxTransactionsPerAddress: this.blockchain.spamProtection.spamProtection.maxTransactionsPerAddress,
          maxTransactionsPerMinute: this.blockchain.spamProtection.spamProtection.maxTransactionsPerMinute,
          addressBanDuration: this.blockchain.spamProtection.spamProtection.addressBanDuration,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting spam protection status: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  resetSpamProtection(req, res) {
    try {
      // Reset all spam protection data
      this.blockchain.spamProtection.spamProtection.bannedAddresses.clear();
      this.blockchain.spamProtection.addressRateLimits.clear();
      this.blockchain.spamProtection.spamProtection.lastCleanup = Date.now();

      res.json({
        success: true,
        message: 'Spam protection reset successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error resetting spam protection: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  addTransactionBatch(req, res) {
    try {
      const { transactions } = req.body;

      if (!transactions || !Array.isArray(transactions)) {
        return res.status(400).json({
          error: 'Invalid request: transactions array required',
        });
      }

      // Convert plain objects to Transaction instances if needed
      const processedTransactions = transactions.map(tx => {
        if (typeof tx === 'object' && !tx.isValid) {
          try {
            return Transaction.fromJSON(tx);
          } catch (error) {
            logger.warn(
              'API',
              `Failed to convert transaction ${tx.id || 'unknown'} to Transaction instance: ${error.message}`
            );
            return tx; // Return original if conversion fails
          }
        }
        return tx;
      });

      const result = this.blockchain.addTransactionBatch(processedTransactions);

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error adding transaction batch: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getMemoryProtectionStatus(req, res) {
    try {
      const status = this.blockchain.getMemoryProtectionStatus();
      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting memory protection status: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getCPUProtectionStatus(req, res) {
    try {
      const status = this.blockchain.getCPUProtectionStatus();
      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting CPU protection status: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getReputationStatus(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available',
        });
      }
      const status = this.p2pNetwork.getReputationStatus();
      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting reputation status: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Checkpoint endpoints
  /**
   *
   * @param req
   * @param res
   */
  getCheckpoints(req, res) {
    try {
      const checkpoints = this.blockchain.checkpointManager.getAllCheckpoints();
      const stats = this.blockchain.checkpointManager.getCheckpointStats();

      res.json({
        success: true,
        checkpoints,
        stats,
      });
    } catch (error) {
      logger.error('API', `Error getting checkpoints: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  addCheckpoint(req, res) {
    try {
      const { height, hash, description } = req.body;

      if (!height || !hash) {
        return res.status(400).json({
          success: false,
          error: 'Height and hash are required',
        });
      }

      const success = this.blockchain.checkpointManager.addCheckpoint(height, hash, description);

      if (success) {
        res.json({
          success: true,
          message: `Checkpoint added at height ${height}`,
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Failed to add checkpoint',
        });
      }
    } catch (error) {
      logger.error('API', `Error adding checkpoint: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  updateCheckpoints(req, res) {
    try {
      // This would typically update checkpoints from a trusted source
      // For now, just return success
      res.json({
        success: true,
        message: 'Checkpoints updated successfully',
        updated: 0,
      });
    } catch (error) {
      logger.error('API', `Error updating checkpoints: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  clearCheckpoints(req, res) {
    try {
      const success = this.blockchain.checkpointManager.clearCheckpoints();

      if (success) {
        res.json({
          success: true,
          message: 'All checkpoints cleared successfully',
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to clear checkpoints',
        });
      }
    } catch (error) {
      logger.error('API', `Error clearing checkpoints: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  validateCheckpoints(req, res) {
    try {
      logger.debug('API', `Checkpoint validation request received`);

      // Validate checkpoints against current blockchain
      const isValid = this.blockchain.checkpointManager.validateCheckpoints(this.blockchain);

      if (isValid) {
        const stats = this.blockchain.checkpointManager.getCheckpointStats();
        res.json({
          success: true,
          message: 'Checkpoint validation completed successfully',
          checkpointsUsed: stats.total,
          stats,
        });
      } else {
        // This should never happen as validateCheckpoints will exit the process
        res.status(500).json({
          success: false,
          error: 'Checkpoint validation failed',
        });
      }
    } catch (error) {
      logger.error('API', `Error validating checkpoints: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  syncMempoolWithPeers(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available',
        });
      }

      logger.info('API', `Manual mempool sync initiated by API request`);
      const syncResult = this.p2pNetwork.syncMempoolWithPeers();

      if (syncResult.success) {
        res.json({
          success: true,
          message: `Mempool sync initiated. Peers notified: ${syncResult.peersNotified}`,
          timestamp: new Date().toISOString(),
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to initiate mempool sync',
          details: syncResult.message,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error('API', `Error initiating mempool sync: ${error.message}`);
      res.status(500).json({
        success: false,
        error: 'Internal server error during mempool sync',
        details: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   *
   * @param req
   * @param res
   */
  getMempoolSyncStatus(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available',
        });
      }

      const syncStatus = this.p2pNetwork.getMempoolSyncStatus();
      res.json({
        success: true,
        data: syncStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('API', `Error getting mempool sync status: ${error.message}`);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

module.exports = APIServer;
