const express = require('express');
const cors = require('cors');
const path = require('path');
const AuthMiddleware = require('../utils/auth');
const InputValidator = require('../utils/validation');
const { TRANSACTION_TAGS } = require('../utils/constants');

class APIServer {
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
    
    // Initialize authentication middleware
    this.auth = new AuthMiddleware(config.api?.apiKey);
    
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
    
    // Add authentication middleware for sensitive endpoints
    // These endpoints require a valid API key to prevent unauthorized access
    this.app.use('/api/blocks/submit', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/network/connect', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/network/message-validation/reset', this.auth.validateApiKey.bind(this.auth));
    this.app.use('/api/network/partition-reset', this.auth.validateApiKey.bind(this.auth));
    
    // Add error handling middleware
    this.app.use((error, req, res, next) => {
      console.error(`❌ API Error: ${error.message}`);
      res.status(500).json({ error: error.message });
    });
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    // Root route for testing
    this.app.get('/', (req, res) => {
      res.json({ message: 'Pastella API Server is running!', version: '1.0.0' });
    });
    
    // Blockchain routes (always available)
    this.app.get('/api/blockchain/status', this.getBlockchainStatus.bind(this));
    this.app.get('/api/blockchain/security', this.getSecurityReport.bind(this));
    this.app.get('/api/blockchain/blocks', this.getBlocks.bind(this));
    this.app.get('/api/blockchain/blocks/:index', this.getBlock.bind(this));
    this.app.get('/api/blockchain/latest', this.getLatestBlock.bind(this));
    this.app.get('/api/blockchain/transactions', this.getPendingTransactions.bind(this));
    this.app.get('/api/blockchain/transactions/:txId', this.getTransaction.bind(this));
    this.app.post('/api/blockchain/transactions', this.submitTransaction.bind(this));

    // Block submission routes (always available)
    this.app.post('/api/blocks/submit', this.submitBlock.bind(this));
    this.app.get('/api/blocks/pending', this.getPendingBlocks.bind(this));
    this.app.post('/api/blocks/validate', this.validateBlock.bind(this));

    // Network routes (always available)
    this.app.get('/api/network/status', this.getNetworkStatus.bind(this));
    this.app.get('/api/network/peers', this.getPeers.bind(this));
    this.app.post('/api/network/connect', this.connectToPeer.bind(this));

    // Reputation routes (always available)
    this.app.get('/api/network/reputation', this.getReputationStats.bind(this));
    this.app.get('/api/network/reputation/:peerAddress', this.getPeerReputation.bind(this));

    // Message validation endpoints
    this.app.get('/api/network/message-validation', this.getMessageValidationStats.bind(this));
    this.app.post('/api/network/message-validation/reset', this.resetMessageValidationStats.bind(this));
    
    // Partition handling endpoints
    this.app.get('/api/network/partition-stats', this.getPartitionStats.bind(this));
    this.app.post('/api/network/partition-reset', this.resetPartitionStats.bind(this));

    // Daemon routes (always available)
    this.app.get('/api/daemon/status', this.getDaemonStatus.bind(this));

    // Utility routes (always available)
    this.app.get('/api/health', this.getHealth.bind(this));
    this.app.get('/api/info', this.getInfo.bind(this));
    
    // Test route
    this.app.get('/api/test', (req, res) => {
      res.json({ message: 'API server is working!', timestamp: new Date().toISOString() });
    });
  }

  /**
   * Start API server
   */
  start() {
    if (this.isRunning) {
      console.log('API server is already running');
      return false;
    }

    this.server = this.app.listen(this.port, () => {
      this.isRunning = true;
    });

    // Add error handling
    this.server.on('error', (error) => {
      console.error(`❌ API Server error: ${error.message}`);
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${this.port} is already in use`);
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
  getBlockchainStatus(req, res) {
    try {
      const status = this.blockchain.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  getSecurityReport(req, res) {
    try {
      const securityReport = this.blockchain.getSecurityReport();
      res.json(securityReport);
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  getBlocks(req, res) {
    try {
      // Input validation for limit parameter
      const validatedLimit = InputValidator.validateNumber(req.query.limit, { 
        min: 1, 
        max: 1000, 
        integer: true 
      }) || 10;
      
      const blocks = this.blockchain.chain.slice(-validatedLimit).map(block => block.toJSON());
      res.json({
        blocks: blocks
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  getBlock(req, res) {
    try {
      // Input validation for block index
      const validatedIndex = InputValidator.validateNumber(req.params.index, { 
        required: true, 
        min: 0, 
        integer: true 
      });
      
      if (validatedIndex === null) {
        return res.status(400).json({
          error: 'Invalid block index'
        });
      }
      
      const block = this.blockchain.chain[validatedIndex];
      
      if (!block) {
        return res.status(404).json({
          error: 'Block not found'
        });
      }

      res.json(block.toJSON());
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  getLatestBlock(req, res) {
    try {
      const latestBlock = this.blockchain.getLatestBlock();
      res.json(latestBlock.toJSON());
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  getPendingTransactions(req, res) {
    try {
      const transactions = this.blockchain.pendingTransactions.map(tx => tx.toJSON());
      res.json({
        transactions: transactions
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  getTransaction(req, res) {
    try {
      // Input validation for transaction ID
      const validatedTxId = InputValidator.validateString(req.params.txId, { 
        required: true, 
        minLength: 1, 
        maxLength: 100 
      });
      
      if (!validatedTxId) {
        return res.status(400).json({
          error: 'Invalid transaction ID'
        });
      }
      
      // Search in pending transactions
      let transaction = this.blockchain.pendingTransactions.find(tx => tx.id === validatedTxId);
      
      // Search in blockchain
      if (!transaction) {
        for (const block of this.blockchain.chain) {
          transaction = block.transactions.find(tx => tx.id === validatedTxId);
          if (transaction) break;
        }
      }

      if (!transaction) {
        return res.status(404).json({
          error: 'Transaction not found'
        });
      }

      res.json(transaction.toJSON());
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  submitTransaction(req, res) {
    try {
      const { transaction } = req.body;
      
      // Input validation
      if (!transaction) {
        return res.status(400).json({ error: 'Transaction data is required' });
      }

      // Validate transaction structure with InputValidator
      const transactionSchema = {
        id: (value) => {
          return InputValidator.validateString(value, { required: true, minLength: 1, maxLength: 100 });
        },
        inputs: (value) => {
          return InputValidator.validateArray(value, (input) => {
            const result = InputValidator.validateObject(input, {
              txId: (v) => {
                return InputValidator.validateHash(v, { required: true });
              },
              outputIndex: (v) => {
                return InputValidator.validateNumber(v, { required: true, integer: true, min: 0 });
              },
              signature: (v) => {
                return InputValidator.validateString(v, { required: true, minLength: 1 });
              },
              publicKey: (v) => {
                return InputValidator.validateString(v, { required: true, minLength: 1 });
              }
            });
            return result;
          }, { required: true, minLength: 1 });
        },
        outputs: (value) => {
          return InputValidator.validateArray(value, (output) => {
            // First validate the required fields (address, amount)
            const baseValidation = InputValidator.validateObject(output, {
              address: (v) => {
                return InputValidator.validateAddress(v, { required: true });
              },
              amount: (v) => {
                return InputValidator.validateAmount(v, { required: true, min: 0 }, this.config.decimals || 8);
              }
            });
            
            if (!baseValidation) {
              return null;
            }
            
            // Add the tag field to the validated output
            const result = {
              ...baseValidation,
              tag: TRANSACTION_TAGS.TRANSACTION
            };
            
            return result;
          }, { required: true, minLength: 1 });
        },
        fee: (value) => {
          return InputValidator.validateNumber(value, { required: true, min: 0 });
        },
        timestamp: (value) => {
          return InputValidator.validateNumber(value, { required: true, min: 0 });
        },
        isCoinbase: (value) => {
          // Boolean validation - just return the value as is
          return value;
        },
        tag: (value) => {
          // Tag validation - just return the value as is
          return value;
        }
      };

      const validatedTransaction = InputValidator.validateObject(transaction, transactionSchema);
      
      if (!validatedTransaction) {
        return res.status(400).json({ error: 'Invalid transaction structure or data' });
      }

      // Validate minimum fee if configured
      if (this.config.wallet && this.config.wallet.minFee !== undefined) {
        if (!validatedTransaction.fee || validatedTransaction.fee < this.config.wallet.minFee) {
          return res.status(400).json({ 
            error: `Transaction fee must be at least ${this.config.wallet.minFee} PAS`,
            minFee: this.config.wallet.minFee,
            providedFee: validatedTransaction.fee || 0
          });
        }
      }

      // Add transaction to mempool
      const success = this.blockchain.addPendingTransaction(validatedTransaction);
      
      if (!success) {
        return res.status(400).json({ error: 'Failed to add transaction to mempool' });
      }

      res.json({
        success: true,
        transactionId: validatedTransaction.id,
        message: 'Transaction submitted successfully'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  
  // Network endpoints
  getNetworkStatus(req, res) {
    try {
      const status = this.p2pNetwork.getNetworkStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  getPeers(req, res) {
    try {
      const peers = this.p2pNetwork.getPeerList();
      res.json({
        peers: peers
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  connectToPeer(req, res) {
    try {
      const { host, port } = req.body;
      
      // Input validation
      const validatedHost = InputValidator.validateString(host, { 
        required: true, 
        minLength: 1, 
        maxLength: 255 
      });
      
      const validatedPort = InputValidator.validatePort(port, { required: true });
      
      if (!validatedHost || !validatedPort) {
        return res.status(400).json({
          error: 'Invalid host or port parameters'
        });
      }

      this.p2pNetwork.connectToPeer(validatedHost, validatedPort);
      
      res.json({
        success: true,
        message: `Connecting to peer ${validatedHost}:${validatedPort}`
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  // Daemon endpoints
  getDaemonStatus(req, res) {
    try {
      res.json({
        isRunning: true,
        api: {
          isRunning: this.isRunning,
          port: this.port
        },
        network: {
          isRunning: this.p2pNetwork ? this.p2pNetwork.isRunning : false,
          port: this.p2pNetwork ? this.p2pNetwork.port : null
        },
        blockchain: {
          height: this.blockchain.chain.length,
          difficulty: this.blockchain.difficulty,
          pendingTransactions: this.blockchain.pendingTransactions.length
        }
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  // Utility endpoints
  getHealth(req, res) {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
  }

  getInfo(req, res) {
    res.json({
        name: this.config.name,
        ticker: this.config.ticker,
        version: '1.0.0',
        uptime: process.uptime(),
        apiPort: this.port,
        p2pPort: this.p2pPort,
        height: this.blockchain.chain.length,
        difficulty: this.blockchain.difficulty,
        pendingTransactions: this.blockchain.pendingTransactions.length,
        blockTime: this.config.blockchain.blockTime,
        coinbaseReward: this.config.blockchain.coinbaseReward,
        premineReward: this.config.blockchain.genesis.premineAmount,
        defaultFee: this.config.wallet.defaultFee,
        minFee: this.config.wallet.minFee,
        description: '',
    });
  }

  // Block submission endpoints
  submitBlock(req, res) {
    try {
      const { block } = req.body;
      
      if (!block) {
        return res.status(400).json({
          error: 'Block data is required'
        });
      }

      // Import Block class
      const Block = require('../models/Block');
      
      // Create block object from JSON
      const blockObj = Block.fromJSON(block);
      
      // Validate block
      if (!blockObj.isValid()) {
        return res.status(400).json({
          error: 'Invalid block submitted'
        });
      }

      // Check if block already exists
      if (this.blockchain.chain.some(b => b.hash === blockObj.hash)) {
        return res.status(409).json({
          error: 'Block already exists in chain'
        });
      }

      // Add block to blockchain
      if (this.blockchain.addBlock(blockObj)) {
                  // Broadcast to network
          if (this.p2pNetwork) {
            this.p2pNetwork.broadcastNewBlock(blockObj);
          }
        
        res.json({
          success: true,
          message: 'Block submitted successfully',
          block: {
            index: blockObj.index,
            hash: blockObj.hash,
            timestamp: blockObj.timestamp
          }
        });
      } else {
        res.status(400).json({
          error: 'Failed to add block to chain'
        });
      }
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  getPendingBlocks(req, res) {
    try {
      // Return pending transactions that can be mined into blocks
      const pendingTransactions = this.blockchain.pendingTransactions;
      
      res.json({
        pendingTransactions: pendingTransactions.map(tx => ({
          id: tx.id,
          inputs: tx.inputs.length,
          outputs: tx.outputs.length,
          fee: tx.fee,
          timestamp: tx.timestamp
        })),
        count: pendingTransactions.length
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  validateBlock(req, res) {
    try {
      const { block } = req.body;
      
      if (!block) {
        return res.status(400).json({
          error: 'Block data is required'
        });
      }

      // Import Block class
      const Block = require('../models/Block');
      
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
          nonce: blockObj.nonce
        }
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  // Reputation endpoints
  getReputationStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available'
        });
      }

      const stats = this.p2pNetwork.getReputationStats();
      res.json({
        reputation: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  getPeerReputation(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available'
        });
      }

      // Input validation for peer address
      const validatedPeerAddress = InputValidator.validateString(req.params.peerAddress, { 
        required: true, 
        minLength: 1, 
        maxLength: 255 
      });
      
      if (!validatedPeerAddress) {
        return res.status(400).json({
          error: 'Invalid peer address'
        });
      }

      const reputation = this.p2pNetwork.getPeerReputation(validatedPeerAddress);
      res.json({
        peerAddress: validatedPeerAddress,
        reputation: reputation,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }

  // Message validation endpoints
  getMessageValidationStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available'
        });
      }

      const stats = this.p2pNetwork.getMessageValidationStats();
      res.json({
        ...stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('API', `Error getting message validation stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  resetMessageValidationStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available'
        });
      }

      this.p2pNetwork.resetMessageValidationStats();
      res.json({ 
        message: 'Message validation statistics reset successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('API', `Error resetting message validation stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  getPartitionStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available'
        });
      }

      const stats = this.p2pNetwork.partitionHandler.getPartitionStats();
      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('API', `Error getting partition stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  resetPartitionStats(req, res) {
    try {
      if (!this.p2pNetwork) {
        return res.status(503).json({
          error: 'P2P network not available'
        });
      }

      this.p2pNetwork.partitionHandler.resetPartitionStats();
      res.json({
        success: true,
        message: 'Partition statistics reset successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('API', `Error resetting partition stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

module.exports = APIServer; 