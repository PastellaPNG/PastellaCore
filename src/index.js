const fs = require('fs');
const os = require('os');
const path = require('path');

const chalk = require('chalk');

const APIServer = require('./api/APIServer');
const Blockchain = require('./models/Blockchain');
const P2PNetwork = require('./network/P2PNetwork');
const logger = require('./utils/logger');

// Import core modules

// Load configuration
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Load package.json for version info
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

/**
 *
 */
class PastellaDaemon {
  /**
   *
   */
  constructor() {
    this.blockchain = new Blockchain('./data', config); // Pass config for memory limits
    this.p2pNetwork = null;
    this.apiServer = null;
    this.isRunning = false;
    this.rl = null; // readline interface
  }

  /**
   * Display daemon intro with specifications
   * @param currentConfig
   */
  displayIntro(currentConfig = config) {
    const { version } = packageJson;
    const freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024));
    const cpuCores = os.cpus().length;

    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                    🚀 PASTELLA DAEMON                        ║'));
    console.log(chalk.blue.bold('║                   NodeJS Cryptocurrency                      ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');

    // Version and basic info
    console.log(chalk.cyan.bold('📋 SYSTEM SPECIFICATIONS:'));
    console.log(chalk.cyan('  • Pastella Version: '), chalk.white.bold(`v${version}`));
    console.log(chalk.cyan('  • CPU Cores:        '), chalk.white.bold(cpuCores));
    console.log(chalk.cyan('  • Free Memory:      '), chalk.white.bold(`${freeMem} GB`));
    console.log('');

    // Blockchain specifications
    console.log(chalk.yellow.bold('🔗 BLOCKCHAIN SPECS:'));
    console.log(chalk.yellow('  • Consensus:      '), chalk.white.bold('Proof of Work (KawPow)'));
    console.log(
      chalk.yellow('  • Block Time:     '),
      chalk.white.bold(`${currentConfig.blockchain.blockTime / 1000}s`)
    );
    console.log('');

    // Network specifications
    console.log(chalk.green.bold('🌐 NETWORK SPECS:'));
    console.log(chalk.green('  • P2P Port:       '), chalk.white.bold(currentConfig.network.p2pPort));
    console.log(chalk.green('  • API Port:       '), chalk.white.bold(currentConfig.api.port));
    console.log('');

    // Storage specifications
    console.log(chalk.gray.bold('💾 STORAGE:'));
    console.log(chalk.gray('  • Data Directory: '), chalk.white.bold(currentConfig.storage.dataDir));
    console.log(chalk.gray('  • Blockchain File:'), chalk.white.bold(currentConfig.storage.blockchainFile));
    console.log('');
  }

  /**
   * Initialize the daemon
   * @param updatedConfig
   */
  async initialize(updatedConfig = null) {
    // Use updated config if provided, otherwise use global config
    const currentConfig = updatedConfig || config;
    // Display comprehensive intro
    this.displayIntro(currentConfig);

    // Ensure data directory exists
    if (!fs.existsSync(currentConfig.storage.dataDir)) {
      fs.mkdirSync(currentConfig.storage.dataDir, { recursive: true });
      logger.info('SYSTEM', 'Created data directory');
    }

    // Load or create blockchain
    const blockchainPath = path.join(currentConfig.storage.dataDir, currentConfig.storage.blockchainFile);
    try {
      if (!(await this.blockchain.loadFromFile(blockchainPath))) {
        // Check if file exists but validation failed
        if (fs.existsSync(blockchainPath)) {
          logger.error('BLOCKCHAIN', 'Existing blockchain file found but validation failed!');
          logger.error('BLOCKCHAIN', 'This could indicate data corruption or an invalid blockchain state.');
          logger.error('BLOCKCHAIN', 'Consider backing up your data and starting with a fresh blockchain.');

          // Backup the corrupted file
          const backupPath = `${blockchainPath}.backup.${Date.now()}`;
          try {
            fs.copyFileSync(blockchainPath, backupPath);
            logger.info('BLOCKCHAIN', `Corrupted blockchain backed up to: ${backupPath}`);
          } catch (backupError) {
            logger.warn('BLOCKCHAIN', `Failed to backup corrupted blockchain: ${backupError.message}`);
          }

          // Remove the corrupted file
          try {
            fs.unlinkSync(blockchainPath);
            logger.info('BLOCKCHAIN', 'Removed corrupted blockchain file');
          } catch (removeError) {
            logger.warn('BLOCKCHAIN', `Failed to remove corrupted blockchain: ${removeError.message}`);
          }

          logger.info('BLOCKCHAIN', 'Creating new blockchain to replace invalid one...');
        } else {
          logger.info('BLOCKCHAIN', 'No existing blockchain found. Creating new one...');
        }

        // Create genesis block with config settings
        const defaultAddress =
          currentConfig.blockchain?.genesis?.premineAddress || '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
        this.blockchain.initialize(defaultAddress, currentConfig);
        this.blockchain.saveToFile(blockchainPath);
        logger.info('BLOCKCHAIN', 'New blockchain created and saved successfully');
      } else {
        logger.info('BLOCKCHAIN', 'Existing blockchain loaded and validated successfully');
      }
    } catch (error) {
      // If the error is about difficulty mismatch, stop the daemon
      if (
        error.name === 'BlockchainDifficultyMismatchError' ||
        error.message.includes('BLOCKCHAIN_DIFFICULTY_MISMATCH')
      ) {
        logger.error('SYSTEM', '🛑 CRITICAL ERROR: Blockchain configuration mismatch');
        logger.error('SYSTEM', '🛑 The daemon cannot start with incompatible blockchain');
        logger.error('SYSTEM', '🛑 Please fix the configuration or use a compatible blockchain');
        process.exit(1);
      }
      // For other errors, rethrow
      throw error;
    }

    // Initialize components
    logger.info('SYSTEM', 'Initializing system components...');

    this.p2pNetwork = new P2PNetwork(this.blockchain, currentConfig.network.p2pPort, currentConfig);
    this.apiServer = new APIServer(this.blockchain, null, null, this.p2pNetwork, currentConfig.api.port, currentConfig);

    // Safe logging of blockchain height
    const chainLength = this.blockchain.chain ? this.blockchain.chain.length : 0;
    logger.info('BLOCKCHAIN', `Blockchain Height: ${chainLength}`);
  }

  /**
   * Start the daemon
   * @param updatedConfig
   */
  async start(updatedConfig = null) {
    if (this.isRunning) {
      logger.info('SYSTEM', 'Daemon is already running');
      return;
    }

    await this.initialize(updatedConfig);

    // Start P2P network
    if (config.network.enabled !== false) {
      try {
        logger.info('P2P', 'Starting P2P network...');
        await this.p2pNetwork.start();
        logger.info('P2P', `P2P Network: ws://localhost:${config.network.p2pPort}`);
      } catch (error) {
        logger.error('P2P', `Failed to start P2P network: ${error.message}`);
        throw error;
      }
    }

    // Start API server
    if (config.api.enabled !== false) {
      // Set API key if provided via CLI
      if (config.api?.apiKey) {
        this.apiServer.setApiKey(config.api.apiKey);
        logger.info('API', `API authentication enabled with key: ${config.api.apiKey.substring(0, 8)}...`);
      }

      this.apiServer.start();
      // The API server will log its own binding information with the correct host
    }

    // Log block submission service status
    logger.info('BLOCKS', 'Block Submission Service: Enabled');

    // Log blockchain data service status
    logger.info('BLOCKCHAIN', 'Blockchain Data Service: Enabled');

    this.isRunning = true;
    console.log(chalk.green.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.green.bold('║                    🎉 DAEMON IS RUNNING                      ║'));
    console.log(chalk.green.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log(chalk.cyan('💡 Press Ctrl+C to stop the daemon'));
    console.log(chalk.cyan('⌨️  Keyboard shortcuts: h (help), s (status), n (network), c (chain)'));

    // Setup periodic tasks
    this.setupPeriodicTasks();

    // Setup graceful shutdown
    this.setupGracefulShutdown();

    // Setup keyboard shortcuts
    this.setupKeyboardShortcuts();
  }

  /**
   * Stop the daemon
   */
  async stop() {
    if (!this.isRunning) {
      logger.warn('SYSTEM', '⚠️  Daemon is not running');
      return;
    }

    console.log(chalk.red.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.red.bold('║                    🛑 SHUTTING DOWN                          ║'));
    console.log(chalk.red.bold('╚══════════════════════════════════════════════════════════════╝'));

    // Stop P2P network
    if (this.p2pNetwork) {
      this.p2pNetwork.stop();
      console.log(chalk.yellow('🌐 P2P Network: Stopped'));
    }

    // Stop API server
    if (this.apiServer) {
      this.apiServer.stop();
      console.log(chalk.yellow('🔌 API Server: Stopped'));
    }

    // Save blockchain state
    console.log(chalk.cyan('💾 Saving blockchain state...'));
    this.blockchain.saveToDefaultFile();

    this.isRunning = false;
    console.log(chalk.green.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.green.bold('║                    ✅ DAEMON STOPPED                         ║'));
    console.log(chalk.green.bold('╚══════════════════════════════════════════════════════════════╝'));
  }

  /**
   * Setup periodic tasks
   */
  setupPeriodicTasks() {
    // Save blockchain every 2 minutes (reduced from 5 minutes for better persistence)
    setInterval(
      () => {
        if (this.isRunning) {
          this.blockchain.saveToDefaultFile();
        }
      },
      2 * 60 * 1000
    );

    // Cleanup expired transactions every 2 minutes (CRITICAL FEATURE)
    setInterval(
      () => {
        if (this.isRunning) {
          const cleanupResult = this.blockchain.cleanupExpiredTransactions();
          if (cleanupResult.cleaned > 0) {
            logger.info('SYSTEM', `🧹 Cleaned up ${cleanupResult.cleaned} expired transactions`);
          }
        }
      },
      2 * 60 * 1000
    );

    // Cleanup orphaned UTXOs every 10 minutes (CRITICAL FEATURE)
    setInterval(
      () => {
        if (this.isRunning) {
          const cleanupResult = this.blockchain.cleanupOrphanedUTXOs();
          if (cleanupResult.cleaned > 0) {
            logger.info('SYSTEM', `🧹 Cleaned up ${cleanupResult.cleaned} orphaned UTXOs`);
          }
        }
      },
      10 * 60 * 1000
    );

    // Memory pool management every 5 minutes (CRITICAL FEATURE)
    setInterval(
      () => {
        if (this.isRunning) {
          const mempoolStatus = this.blockchain.manageMemoryPool();
          if (mempoolStatus.actions > 0) {
            logger.info('SYSTEM', `💾 Memory pool managed: ${mempoolStatus.actions} actions taken`);
          }
        }
      },
      5 * 60 * 1000
    );

    // Spam protection cleanup every 3 minutes (CRITICAL FEATURE)
    setInterval(
      () => {
        if (this.isRunning) {
          this.blockchain.cleanupSpamProtection();
        }
      },
      3 * 60 * 1000
    );

    // Note: Difficulty adjustment now happens before each new block is mined
    // in the minePendingTransactions method, so no periodic adjustment needed

    // Sync with network every 30 seconds
    setInterval(async () => {
      if (this.isRunning && this.p2pNetwork) {
        try {
          await this.p2pNetwork.syncWithNetwork();
        } catch (error) {
          console.error(chalk.yellow(`⚠️  Network sync failed: ${error.message}`));
        }
      }
    }, 30 * 1000);
  }

  /**
   * Setup graceful shutdown
   */
  setupGracefulShutdown() {
    const shutdown = async signal => {
      console.log(chalk.yellow.bold(`\n📡 Received ${signal}. Shutting down gracefully...`));
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGQUIT', () => shutdown('SIGQUIT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', error => {
      console.error(chalk.red.bold('❌ Uncaught Exception:'), error);
      this.stop().then(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error(chalk.red.bold('❌ Unhandled Rejection at:'), promise, chalk.red('reason:'), reason);
      this.stop().then(() => process.exit(1));
    });
  }

  /**
   * Get daemon status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      blockchain: this.blockchain.getStatus(),
      network: this.p2pNetwork ? this.p2pNetwork.getNetworkStatus() : null,
      api: this.apiServer ? { isRunning: this.apiServer.isRunning, port: this.apiServer.port } : null,
    };
  }

  /**
   * Setup keyboard shortcuts for interactive commands
   */
  setupKeyboardShortcuts() {
    // Handle raw input for single key presses
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', key => {
      // Handle Ctrl+C
      if (key === '\u0003') {
        process.exit(0);
      }

      // Handle single key presses
      switch (key.toLowerCase()) {
        case 'h':
          this.showHelp();
          break;
        case 's':
          this.showStatus();
          break;
        case 'n':
          this.showNetworkStatus();
          break;
        case 'c':
          this.showChainStatus();
          break;
        case 'm':
          this.showMempoolStatus();
          break;
      }
    });
  }

  /**
   * Show help for keyboard shortcuts
   */
  showHelp() {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                      ⌨️  KEYBOARD SHORTCUTS                   ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');
    console.log(chalk.cyan('  h - Help'), chalk.white('(show this help)'));
    console.log(chalk.cyan('  s - Status'), chalk.white('(show daemon status)'));
    console.log(chalk.cyan('  n - Network'), chalk.white('(show network status)'));
    console.log(chalk.cyan('  c - Chain'), chalk.white('(show blockchain status)'));
    console.log(chalk.cyan('  m - Mempool'), chalk.white('(show mempool status & sync)'));
    console.log(chalk.cyan('  q - Quick info'), chalk.white('(show stop instructions)'));
    console.log(chalk.cyan('  Ctrl+C'), chalk.white('- Stop daemon'));
    console.log('');
  }

  /**
   * Show comprehensive daemon status
   */
  showStatus() {
    const status = this.getStatus();
    const latestBlock = this.blockchain.getLatestBlock();

    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                      📊 DAEMON STATUS                        ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');

    // Overall status
    console.log(chalk.yellow.bold('🚀 DAEMON:'));
    console.log(chalk.cyan('  Status:'), status.isRunning ? chalk.green('Running') : chalk.red('Stopped'));
    console.log(chalk.cyan('  Uptime:'), chalk.white(this.getUptime()));
    console.log('');

    // API status
    console.log(chalk.yellow.bold('🔌 API SERVER:'));
    console.log(chalk.cyan('  Status:'), status.api?.isRunning ? chalk.green('Running') : chalk.red('Stopped'));
    console.log(chalk.cyan('  Port:'), chalk.white(status.api?.port || 'N/A'));
    console.log('');

    // Network status
    console.log(chalk.yellow.bold('🌐 P2P NETWORK:'));
    if (status.network) {
      console.log(chalk.cyan('  Status:'), status.network.isRunning ? chalk.green('Running') : chalk.red('Stopped'));
      console.log(chalk.cyan('  Port:'), chalk.white(status.network.port || 'N/A'));
      console.log(
        chalk.cyan('  Peers:'),
        chalk.white(`${status.network.peerCount || 0}/${status.network.maxPeers || 0}`)
      );
      console.log(
        chalk.cyan('  Seed Connections:'),
        chalk.white(
          `${status.network.connectedSeedNodes || 0}/${status.network.minSeedConnections || 0} (min required)`
        )
      );
    } else {
      console.log(chalk.red('  P2P Network disabled'));
    }
    console.log('');

    // Blockchain status
    console.log(chalk.yellow.bold('🔗 BLOCKCHAIN:'));
    console.log(chalk.cyan('  Network ID:'), chalk.white(status.blockchain?.networkId || 'unknown'));
    console.log(chalk.cyan('  Height:'), chalk.white(status.blockchain?.length || 0));
    console.log(chalk.cyan('  Difficulty:'), chalk.white(status.blockchain?.difficulty || 0));
    console.log(chalk.cyan('  Pending TXs:'), chalk.white(status.blockchain?.pendingTransactions || 0));
    if (latestBlock) {
      console.log(chalk.cyan('  Latest Block:'), chalk.white(`${latestBlock.hash.substring(0, 16)}...`));
      console.log(chalk.cyan('  Block Time:'), chalk.white(new Date(latestBlock.timestamp).toLocaleString()));
    }
    console.log('');

    // Sync status
    this.showSyncStatus();
    console.log('');
  }

  /**
   * Show network status
   */
  showNetworkStatus() {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                      🌐 NETWORK STATUS                       ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');

    if (!this.p2pNetwork) {
      console.log(chalk.red('❌ P2P Network is not enabled'));
      return;
    }

    const networkStatus = this.p2pNetwork.getNetworkStatus();
    const peerList = this.p2pNetwork.getPeerList();

    console.log(chalk.yellow.bold('📡 NETWORK INFO:'));
    console.log(chalk.cyan('  Status:'), networkStatus.isRunning ? chalk.green('Running') : chalk.red('Stopped'));
    console.log(chalk.cyan('  Network ID:'), chalk.white(networkStatus.networkId || 'unknown'));
    console.log(chalk.cyan('  Port:'), chalk.white(networkStatus.port));
    console.log(chalk.cyan('  Peers:'), chalk.white(`${networkStatus.peerCount}/${networkStatus.maxPeers}`));
    console.log(
      chalk.cyan('  Seed Connections:'),
      chalk.white(
        `${networkStatus.seedNodeConnections.connectedSeedNodes}/${networkStatus.seedNodeConnections.minSeedConnections} (min required)`
      )
    );
    console.log('');

    if (peerList.length > 0) {
      console.log(chalk.yellow.bold('🔗 CONNECTED PEERS:'));
      const maxPeersToShow = 7;
      const peersToShow = peerList.slice(0, maxPeersToShow);

      peersToShow.forEach((peer, index) => {
        // Check connection state using our tracking system instead of WebSocket readyState
        const peerAddress = peer.address || peer.url.replace('ws://', '');
        const isConnected = this.p2pNetwork?.connectionStates?.get(peerAddress) === 'connected';
        const statusText = isConnected ? chalk.green('(connected)') : chalk.red('(disconnected)');
        const typeText = peer.isSeedNode ? chalk.blue('[seed]') : chalk.gray('[peer]');
        console.log(chalk.cyan(`  ${index + 1}.`), chalk.white(`${peer.url} ${statusText} ${typeText}`));
      });

      if (peerList.length > maxPeersToShow) {
        console.log(chalk.gray(`  ... and ${peerList.length - maxPeersToShow} more peers`));
      }
      console.log('');
    }

    if (networkStatus.seedNodes && networkStatus.seedNodes.length > 0) {
      console.log(chalk.yellow.bold('🌱 SEED NODES:'));
      networkStatus.seedNodes.forEach((node, index) => {
        // Extract hostname and port from seed node URL
        const seedUrl = node.replace('ws://', '').replace('wss://', '');
        const seedHost = seedUrl.split(':')[0];
        const seedPort = seedUrl.split(':')[1];

        // Check if this is the current node
        const isCurrentNode =
          (seedHost === 'localhost' || seedHost === '127.0.0.1') && parseInt(seedPort) === networkStatus.port;

        if (isCurrentNode) {
          // This is the current node
          const statusText = chalk.yellow('(this node)');
          console.log(chalk.cyan(`  ${index + 1}.`), chalk.white(node), statusText);
        } else {
          // Check if this seed node is connected by comparing with peer list
          const isConnected = peerList.some(peer => {
            // Extract hostname and port from peer URL (now always IPv4)
            const peerHost = peer.url.split(':')[0];
            const peerPort = peer.url.split(':')[1];

            // Check if ports match and hostnames are equivalent
            const portsMatch = seedPort === peerPort;
            const hostsMatch =
              seedHost === peerHost ||
              (seedHost === 'localhost' && peerHost === '127.0.0.1') ||
              (peerHost === 'localhost' && seedHost === '127.0.0.1');

            // Use our connection state tracking instead of WebSocket readyState
            const peerAddress = peer.address || peer.url.replace('ws://', '');
            const connectionState = this.p2pNetwork?.connectionStates?.get(peerAddress);
            return portsMatch && hostsMatch && connectionState === 'connected';
          });

          const statusText = isConnected ? chalk.green('(connected)') : chalk.red('(disconnected)');
          console.log(chalk.cyan(`  ${index + 1}.`), chalk.white(node), statusText);
        }
      });
      console.log('');
    }

    // Sync status
    this.showSyncStatus();
    console.log('');
  }

  /**
   * Show blockchain status
   */
  showChainStatus() {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                      🔗 BLOCKCHAIN STATUS                    ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');

    const latestBlock = this.blockchain.getLatestBlock();
    const totalSupply = this.blockchain.getTotalSupply();

    console.log(chalk.yellow.bold('📊 CHAIN INFO:'));
    console.log(chalk.cyan('  Height:'), chalk.white(this.blockchain.chain.length));
    console.log(chalk.cyan('  Difficulty:'), chalk.white(this.blockchain.difficulty));
    console.log(chalk.cyan('  Block Time:'), chalk.white(`${config.blockchain.blockTime / 1000}s`));
    console.log(chalk.cyan('  Total Supply:'), chalk.white(`${totalSupply} PAS`));
    console.log(chalk.cyan('  Pending TXs:'), chalk.white(this.blockchain.memoryPool.getPendingTransactionCount()));
    console.log('');

    if (latestBlock) {
      console.log(chalk.yellow.bold('🔗 LATEST BLOCK:'));
      console.log(chalk.cyan('  Index:'), chalk.white(latestBlock.index));
      console.log(chalk.cyan('  Hash:'), chalk.white(`${latestBlock.hash.substring(0, 16)}...`));
      console.log(chalk.cyan('  Previous:'), chalk.white(`${latestBlock.previousHash.substring(0, 16)}...`));
      console.log(chalk.cyan('  Nonce:'), chalk.white(latestBlock.nonce));
      console.log(chalk.cyan('  Difficulty:'), chalk.white(latestBlock.difficulty));
      console.log(chalk.cyan('  Transactions:'), chalk.white(latestBlock.transactions.length));
      console.log(chalk.cyan('  Timestamp:'), chalk.white(new Date(latestBlock.timestamp).toLocaleString()));
      console.log('');
    }

    // Show recent blocks
    if (this.blockchain.chain.length > 1) {
      console.log(chalk.yellow.bold('📋 RECENT BLOCKS:'));
      const recentBlocks = this.blockchain.chain.slice(-5).reverse();
      recentBlocks.forEach((block, index) => {
        const timeAgo = this.getTimeAgo(block.timestamp);
        console.log(chalk.cyan(`  ${block.index}.`), chalk.white(`${block.hash.substring(0, 16)}... (${timeAgo})`));
      });
      console.log('');
    }

    // Sync status
    this.showSyncStatus();
    console.log('');
  }

  /**
   * Show mempool status
   */
  showMempoolStatus() {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                      💰 MEMPOOL STATUS                       ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');

    const mempool = this.blockchain.memoryPool;
    const pendingTxCount = mempool.getPendingTransactionCount();
    const maxMempoolSize = mempool.getMaxMempoolSize();
    const currentMempoolSize = mempool.getCurrentMempoolSize();
    const oldestTxTimestamp = mempool.getOldestTransactionTimestamp();
    const newestTxTimestamp = mempool.getNewestTransactionTimestamp();

    console.log(chalk.yellow.bold('📊 MEMPOOL INFO:'));
    console.log(chalk.cyan('  Pending TXs:'), chalk.white(pendingTxCount));
    console.log(chalk.cyan('  Current Mempool Size:'), chalk.white(`${currentMempoolSize} KB`));
    console.log(chalk.cyan('  Max Mempool Size:'), chalk.white(`${maxMempoolSize} KB`));
    console.log(chalk.cyan('  Oldest TX:'), chalk.white(new Date(oldestTxTimestamp).toLocaleString()));
    console.log(chalk.cyan('  Newest TX:'), chalk.white(new Date(newestTxTimestamp).toLocaleString()));
    console.log('');

    if (pendingTxCount > 0) {
      console.log(chalk.yellow.bold('💰 PENDING TRANSACTIONS:'));
      const transactions = mempool.getPendingTransactions();
      transactions.forEach((tx, index) => {
        console.log(chalk.cyan(`  ${index + 1}.`), chalk.white(`${tx.id} (Size: ${tx.size} bytes)`));
        console.log(chalk.gray(`   • Fee: ${tx.fee} PAS, Age: ${this.getTimeAgo(tx.timestamp)}`));
        console.log(chalk.gray(`   • Sender: ${tx.sender}, Receiver: ${tx.receiver}, Amount: ${tx.amount} PAS`));
        console.log(chalk.gray(`   • Timestamp: ${new Date(tx.timestamp).toLocaleString()}`));
        console.log('');
      });
    } else {
      console.log(chalk.green('  No pending transactions in mempool.'));
    }

    // Sync status
    this.showSyncStatus();
    console.log('');
  }

  /**
   * Show sync status
   */
  showSyncStatus() {
    if (!this.p2pNetwork) {
      console.log(chalk.yellow.bold('🔄 SYNC STATUS:'));
      console.log(chalk.red('  P2P Network disabled - no sync possible'));
      return;
    }

    const networkStatus = this.p2pNetwork.getNetworkStatus();

    console.log(chalk.yellow.bold('🔄 SYNC STATUS:'));
    if (networkStatus.networkSyncStatus) {
      const syncStatus = networkStatus.networkSyncStatus;
      console.log(chalk.cyan('  Status:'), syncStatus.isSyncing ? chalk.yellow('Syncing') : chalk.green('Idle'));
      if (syncStatus.lastSyncTime) {
        console.log(chalk.cyan('  Last Sync:'), chalk.white(new Date(syncStatus.lastSyncTime).toLocaleString()));
      }
      console.log(
        chalk.cyan('  Sync Attempts:'),
        chalk.white(`${syncStatus.syncAttempts}/${syncStatus.maxSyncAttempts}`)
      );
    } else {
      console.log(chalk.cyan('  Status:'), chalk.green('Idle'));
    }
  }

  /**
   * Get uptime string
   */
  getUptime() {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Get time ago string
   * @param timestamp
   */
  getTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ago`;
    }
    if (hours > 0) {
      return `${hours}h ago`;
    }
    if (minutes > 0) {
      return `${minutes}m ago`;
    }
    return `${seconds}s ago`;
  }
}

// Main execution
/**
 *
 */
async function main() {
  const daemon = new PastellaDaemon();

  // Parse command line arguments
  const args = process.argv.slice(2);

  // Check for debug flag first
  if (args.includes('--debug')) {
    logger.setDebugMode(true);
    logger.info('SYSTEM', '🐛 Debug mode enabled');
  }

  if (args.includes('--help') || args.includes('-h')) {
    const { version } = packageJson;

    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                    🚀 PASTELLA DAEMON                        ║'));
    console.log(chalk.blue.bold('║                   NodeJS Cryptocurrency                      ║'));
    console.log(chalk.blue.bold(`║                       Version ${version}                          ║`));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');
    console.log(chalk.cyan.bold('📖 DESCRIPTION:'));
    console.log(chalk.white('  Pastella (PAS) is a complete cryptocurrency implementation featuring'));
    console.log(chalk.white('  Proof-of-Work mining, UTXO model, and peer-to-peer networking.'));
    console.log('');
    console.log(chalk.cyan.bold('🚀 USAGE:'), chalk.white('node src/index.js [options]'));
    console.log('');
    console.log(chalk.yellow.bold('⚙️  OPTIONS:'));
    console.log(chalk.cyan('  --help, -h           '), chalk.white('Show this help message'));
    console.log(chalk.cyan('  --version, -v        '), chalk.white('Show detailed version information'));
    console.log(chalk.cyan('  --debug              '), chalk.white('Enable debug logging'));
    console.log(chalk.cyan('  --config <path>      '), chalk.white('Path to config file (default: ./config.json)'));
    console.log(chalk.cyan('  --data-dir <path>    '), chalk.white('Data directory (default: ./data)'));
    console.log(chalk.cyan('  --api-port <port>    '), chalk.white('REST API port (default: 3002)'));
    console.log(chalk.cyan('  --p2p-port <port>    '), chalk.white('P2P network port (default: 3001)'));
    console.log(chalk.cyan('  --no-api             '), chalk.white('Disable REST API server'));
    console.log(chalk.cyan('  --no-p2p             '), chalk.white('Disable P2P network'));
    console.log(chalk.cyan('  --block-time <ms>    '), chalk.white('Set block time in milliseconds (default: 60000)'));
    console.log(chalk.cyan('  --min-seed-conn <n>  '), chalk.white('Minimum seed node connections (0-10, default: 2)'));
    console.log(chalk.cyan('  --api-key <key>      '), chalk.white('API key for authentication (default: none)'));
    console.log(chalk.cyan('  --host <ip>          '), chalk.white('API server host binding (default: 127.0.0.1)'));
    console.log(chalk.cyan('  --generate-genesis   '), chalk.white('Generate new genesis block configuration'));
    console.log('');
    console.log(chalk.yellow.bold('💡 EXAMPLES:'));
    console.log(
      chalk.cyan('  node src/index.js                                     '),
      chalk.white('# Start with all services')
    );
    console.log(
      chalk.cyan('  node src/index.js --debug                             '),
      chalk.white('# Start with debug logging')
    );
    console.log(
      chalk.cyan('  node src/index.js --no-api --no-p2p                   '),
      chalk.white('# Blockchain only mode')
    );
    console.log(chalk.cyan('  node src/index.js --api-port 8080 --p2p-port 8081     '), chalk.white('# Custom ports'));
    console.log(
      chalk.cyan('  node src/index.js --data-dir /path/to/data            '),
      chalk.white('# Custom data directory')
    );
    console.log(
      chalk.cyan('  node src/index.js --min-seed-conn 1                   '),
      chalk.white('# Require only 1 seed connection')
    );
    console.log(
      chalk.cyan('  node src/index.js --api-key mysecretkey               '),
      chalk.white('# Enable API authentication')
    );
    console.log(
      chalk.cyan('  node src/index.js --host 192.168.1.100 --api-key key  '),
      chalk.white('# Bind to specific network interface')
    );
    console.log(
      chalk.cyan('  node src/index.js --generate-genesis                  '),
      chalk.white('# Generate new genesis configuration')
    );
    console.log('');
    console.log(chalk.yellow.bold('🔗 SERVICES:'));
    console.log(chalk.green('  • Blockchain:     '), chalk.white('Core blockchain with UTXO model'));
    console.log(chalk.green('  • Mining:         '), chalk.white('Velora mining'));
    console.log(chalk.green('  • P2P Network:    '), chalk.white('WebSocket peer-to-peer networking'));
    console.log(chalk.green('  • REST API:       '), chalk.white('HTTP API for external integration'));
    console.log(chalk.green('  • CLI Wallet:     '), chalk.white('Local wallet management (use CLI)'));
    console.log('');
    console.log(chalk.yellow.bold('🔒 SECURITY:'));
    console.log(chalk.red('  • API Server:     '), chalk.white('Defaults to localhost-only (127.0.0.1)'));
    console.log(chalk.red('  • External Access:'), chalk.white('Requires --host + --api-key for security'));
    console.log(chalk.red('  • Authentication:  '), chalk.white('API key required for non-localhost binding'));
    console.log('');
    console.log(chalk.yellow.bold('📞 SUPPORT:'));
    console.log(chalk.white('  • License:        '), chalk.cyan(packageJson.license));
    console.log(chalk.white('  • Author:         '), chalk.cyan(packageJson.author));
    console.log(chalk.white('  • Repository:     '), chalk.cyan('https://github.com/PastellaOrg/PastellaCore'));
    console.log('');
    process.exit(0);
  }

  if (args.includes('--generate-genesis')) {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                    🚀 GENESIS GENERATOR                      ║'));
    console.log(chalk.blue.bold('║                   Generate Custom Genesis Block              ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');

    // Import required modules for genesis generation
    const Block = require('./models/Block');
    const { Transaction } = require('./models/Transaction');
    const { TRANSACTION_TAGS } = require('./utils/constants');
    const readline = require('readline');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const question = query => new Promise(resolve => rl.question(query, resolve));

    /**
     *
     */
    async function generateGenesis() {
      try {
        console.log(chalk.cyan.bold('📋 GENESIS BLOCK CONFIGURATION:'));
        console.log(chalk.white('Please provide the following parameters for your genesis block:'));
        console.log('');
        console.log(chalk.yellow('💡 Difficulty Note: Use 100-1000 to ensure actual mining effort is required'));
        console.log(chalk.gray('   Lower difficulties (like 10) will find valid hashes immediately (nonce 0)'));
        console.log(chalk.gray('   Higher difficulties (>1000) are capped to prevent impossible mining'));
        console.log(chalk.gray('   Recommended: 500-1000 for reasonable mining time'));
        console.log('');

        // Get user input
        const premineAddress = await question(chalk.cyan('🏦 Premine Address: '));
        const premineAmount = parseFloat(await question(chalk.cyan('💰 Premine Amount (PAS): '))) * 100000000; // Convert to atomic units
        const difficulty = parseInt(
          await question(chalk.cyan('⚡ Mining Difficulty (100-10000, recommended: 1000): '))
        );
        const timestamp = await question(
          chalk.cyan('🕐 Genesis Timestamp (Unix timestamp, or press Enter for current time): ')
        );

        // Validate inputs
        if (!premineAddress || premineAddress.trim() === '') {
          throw new Error('Premine address is required');
        }

        if (isNaN(premineAmount) || premineAmount <= 0) {
          throw new Error('Premine amount must be a positive number');
        }

        if (isNaN(difficulty) || difficulty < 100 || difficulty > 10000) {
          throw new Error('Difficulty must be between 100 and 10000 (recommended: 1000)');
        }

        // Use current timestamp if not provided
        const genesisTimestamp = timestamp.trim() === '' ? Date.now() : parseInt(timestamp);
        if (isNaN(genesisTimestamp) || genesisTimestamp <= 0) {
          throw new Error('Invalid timestamp');
        }

        console.log('');
        console.log(chalk.yellow.bold('⏳ Generating genesis block...'));
        console.log(chalk.gray(`• Address: ${premineAddress}`));
        console.log(chalk.gray(`• Amount: ${premineAmount / 100000000} PAS (${premineAmount} atomic units)`));
        console.log(chalk.gray(`• Difficulty: ${difficulty}`));
        console.log(chalk.gray(`• Timestamp: ${genesisTimestamp} (${new Date(genesisTimestamp).toISOString()})`));
        console.log('');

        // Create premine transaction
        const premineTransaction = Transaction.createCoinbase(
          premineAddress,
          premineAmount,
          genesisTimestamp,
          null, // Let the transaction generate its own nonce
          null, // Let the transaction generate its own atomicSequence
          true
        );
        premineTransaction.tag = TRANSACTION_TAGS.PREMINE;

        // Override the atomicSequence for genesis blocks to use custom format
        const randomNumber = Math.floor(Math.random() * 1000000);
        premineTransaction._atomicSequence = `${genesisTimestamp}-genesis-coinbase-${randomNumber}`;

        // Don't override the timestamp - keep the config timestamp for determinism
        premineTransaction.calculateId();

        // Get the generated values from the transaction
        const coinbaseNonce = premineTransaction.nonce;
        const coinbaseAtomicSequence = premineTransaction._atomicSequence;

        console.log(chalk.green('✅ Premine transaction created'));
        console.log(chalk.gray(`   Transaction ID: ${premineTransaction.id}`));
        console.log(chalk.gray(`   Coinbase Nonce: ${coinbaseNonce}`));
        console.log(chalk.gray(`   Coinbase Sequence: ${coinbaseAtomicSequence}`));

        // Create genesis block and find valid nonce
        const genesisBlock = new Block(0, genesisTimestamp, [premineTransaction], '0', 0, difficulty);
        genesisBlock.calculateMerkleRoot();

        // IMPORTANT: Generate cache using the SAME logic as the miner AND Block.js validation
        const KawPowUtils = require('./utils/kawpow');
        const kawPowUtils = new KawPowUtils();

        // Use EXACTLY the same cache generation as BOTH the miner AND Block.js validation:
        // - Both use 1000 cache entries (no optimization)
        // - This ensures hash consistency across all components
        const seed = kawPowUtils.generateSeedHash(0); // Genesis block index is 0
        const genesisCache = kawPowUtils.generateCache(seed, 1000); // 1000 entries (same as miner & validation)

        console.log(chalk.green(`✅ Genesis cache generated: ${genesisCache.length} entries`));

        const target = genesisBlock.calculateTarget();
        console.log(chalk.green('✅ Genesis block structure created'));
        console.log(chalk.gray(`   Target: ${target}`));
        console.log(chalk.gray(`   Merkle Root: ${genesisBlock.merkleRoot}`));

        console.log('');

        // Find valid nonce
        console.log(chalk.yellow.bold('⛏️  MINING GENESIS BLOCK (KawPow Algorithm)'));
        console.log(chalk.gray(`   Target: ${target.substring(0, 16)}...`));
        console.log(chalk.gray(`   Difficulty: ${difficulty}`));
        console.log(chalk.gray('   Algorithm: KawPow (ProgPoW + Keccak256)'));
        console.log('');

        let nonce = 0;
        const maxAttempts = 10000000; // 10 million attempts
        const startTime = Date.now();
        const lastUpdate = 0;

        // Progress bar setup
        const progressBarLength = 30;
        const updateInterval = 10000; // Update every 10k nonces

        console.log(chalk.cyan(`   Progress: [${'░'.repeat(progressBarLength)}] 0%`));

        while (nonce < maxAttempts) {
          genesisBlock.nonce = nonce;

          // IMPORTANT: Use the SAME cache and hash calculation as the miner
          genesisBlock.hash = kawPowUtils.kawPowHash(0, '0', nonce, genesisCache);
          genesisBlock.algorithm = 'kawpow';

          // Check if hash meets difficulty requirement
          const hashNum = BigInt(`0x${genesisBlock.hash}`);
          const targetNum = BigInt(`0x${target}`);

          if (hashNum <= targetNum) {
            // Clear the progress line
            process.stdout.write(`\r${' '.repeat(80)}\r`);

            const miningTime = ((Date.now() - startTime) / 1000).toFixed(2);
            const hashRate = Math.floor(nonce / (miningTime / 1000));

            console.log(chalk.green.bold('   🎉 GENESIS BLOCK MINED!'));
            console.log(chalk.green('   ════════════════════════════════════════════════════════════'));
            console.log(chalk.cyan('   �� Mining Statistics:'));
            console.log(chalk.gray(`      • Nonce: ${nonce.toLocaleString()}`));
            console.log(chalk.gray(`      • Hash: ${genesisBlock.hash}`));
            console.log(chalk.gray(`      • Time: ${miningTime}s`));
            console.log(chalk.gray(`      • Hash Rate: ${hashRate.toLocaleString()} H/s`));
            console.log(chalk.gray(`      • Target: ${target.substring(0, 16)}...`));
            console.log(chalk.gray(`      • Hash < Target: ${hashNum < targetNum ? '✅' : '❌'}`));
            console.log('');
            break;
          }

          // Update progress every 10k nonces
          if (nonce % updateInterval === 0) {
            const progress = Math.min((nonce / maxAttempts) * 100, 100);
            const filledLength = Math.floor((progress / 100) * progressBarLength);
            const emptyLength = progressBarLength - filledLength;

            const progressBar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const hashRate = Math.floor(nonce / (elapsed / 1000));

            process.stdout.write(
              chalk.cyan(
                `\r   Progress: [${progressBar}] ${progress.toFixed(1)}% | ${nonce.toLocaleString()} nonces | ${elapsed}s | ${hashRate.toLocaleString()} H/s`
              )
            );
          }

          nonce++;
        }

        if (nonce >= maxAttempts) {
          // Clear the progress line
          process.stdout.write(`\r${' '.repeat(80)}\r`);

          const miningTime = ((Date.now() - startTime) / 1000).toFixed(2);
          const hashRate = Math.floor(nonce / (miningTime / 1000));

          console.log(chalk.red.bold('   ❌ MINING FAILED'));
          console.log(chalk.red('   ════════════════════════════════════════════════════════════'));
          console.log(chalk.yellow('   📊 Final Statistics:'));
          console.log(chalk.gray(`      • Attempted: ${nonce.toLocaleString()} nonces`));
          console.log(chalk.gray(`      • Time: ${miningTime}s`));
          console.log(chalk.gray(`      • Hash Rate: ${hashRate.toLocaleString()} H/s`));
          console.log(chalk.gray(`      • Target: ${target.substring(0, 16)}...`));
          console.log('');
          console.log(chalk.yellow('   💡 Suggestion: Try reducing the difficulty or increasing max attempts.'));
          console.log('');

          throw new Error(
            `Could not find valid nonce within ${maxAttempts.toLocaleString()} attempts. Try reducing difficulty.`
          );
        }

        console.log('');
        console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
        console.log(chalk.blue.bold('║                    🎉 GENESIS GENERATED                      ║'));
        console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
        console.log('');

        // Generate config.json snippet
        console.log(chalk.cyan.bold('📝 CONFIG.JSON Snippet:'));
        console.log(chalk.white('Add this to your config.json file:'));
        console.log('');
        console.log(chalk.gray('{'));
        console.log(chalk.gray('  "blockchain": {'));
        console.log(chalk.gray(`    "difficulty": ${difficulty},`));
        console.log(chalk.gray('    "genesis": {'));
        console.log(chalk.gray(`      "timestamp": ${genesisTimestamp},`));
        console.log(chalk.gray(`      "premineAmount": ${premineAmount},`));
        console.log(chalk.gray(`      "premineAddress": "${premineAddress}",`));
        console.log(chalk.gray(`      "difficulty": ${difficulty},`));
        console.log(chalk.gray(`      "nonce": ${nonce},`));
        console.log(chalk.gray(`      "hash": "${genesisBlock.hash}",`));
        console.log(chalk.gray(`      "algorithm": "kawpow",`));
        console.log(chalk.gray(`      "coinbaseNonce": "${coinbaseNonce}",`));
        console.log(chalk.gray(`      "coinbaseAtomicSequence": "${coinbaseAtomicSequence}"`));
        console.log(chalk.gray('    }'));
        console.log(chalk.gray('  }'));
        console.log(chalk.gray('}'));
        console.log('');
        console.log(chalk.cyan('💡 Note: premineAmount is in atomic units (8 decimals)'));
        console.log(chalk.gray(`   Your input: ${premineAmount / 100000000} PAS = ${premineAmount} atomic units`));

        // Generate complete config.json
        const newConfig = {
          ...config,
          blockchain: {
            ...config.blockchain,
            difficulty,
            genesis: {
              timestamp: genesisTimestamp,
              premineAmount,
              premineAddress,
              difficulty,
              nonce,
              hash: genesisBlock.hash,
              algorithm: 'kawpow',
              coinbaseNonce,
              coinbaseAtomicSequence,
            },
          },
        };

        console.log(chalk.yellow.bold('🔧 IMPORTANT: Cache Consistency'));
        console.log(
          chalk.white(
            'The genesis block was generated using the EXACT same cache generation logic as the miner AND validator:'
          )
        );
        console.log(chalk.gray(`   • Cache size: 1000 entries (no optimization)`));
        console.log(chalk.gray(`   • Seed hash: ${seed.substring(0, 16)}...`));
        console.log(chalk.gray(`   • This ensures hash validation will work correctly!`));
        console.log('');

        // Ask if user wants to save config
        const saveConfig = await question(chalk.cyan('💾 Save as new config.json? (y/N): '));

        if (saveConfig.toLowerCase() === 'y' || saveConfig.toLowerCase() === 'yes') {
          const configPath = await question(chalk.cyan('📁 Config file path (default: config-new.json): '));
          const finalPath = configPath.trim() === '' ? 'config-new.json' : configPath;

          fs.writeFileSync(finalPath, JSON.stringify(newConfig, null, 2));
          console.log(chalk.green(`✅ Configuration saved to: ${finalPath}`));
        }

        console.log('');
        console.log(chalk.yellow.bold('🚀 NEXT STEPS:'));
        console.log(chalk.white('1. Update your config.json with the generated values'));
        console.log(chalk.white('2. Delete any existing blockchain.json file'));
        console.log(chalk.white('3. Start your daemon: node src/index.js'));
        console.log(chalk.white('4. Your custom genesis block will be created!'));
        console.log('');
        console.log(chalk.blue.bold('🔧 CRITICAL: Cache Consistency Fixed'));
        console.log(chalk.white('The genesis block now uses the EXACT same KawPow cache generation as the miner.'));
        console.log(chalk.white('This should resolve the "Genesis block validation failed" error! 🎉'));
        console.log('');
        console.log(chalk.blue.bold('🎉 Happy forking! 🎉'));
      } catch (error) {
        console.error(chalk.red.bold('❌ Error generating genesis block:'), error.message);
        process.exit(1);
      } finally {
        rl.close();
      }
    }

    generateGenesis();
    return; // Exit early
  }

  if (args.includes('--version') || args.includes('-v')) {
    const { version } = packageJson;
    const nodeVersion = process.version;
    const platform = os.platform();
    const arch = os.arch();

    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                    🚀 PASTELLA DAEMON                      ║'));
    console.log(chalk.blue.bold('║                   NodeJS Cryptocurrency                      ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════╝'));
    console.log('');
    console.log(chalk.cyan.bold('📋 VERSION INFORMATION:'));
    console.log(chalk.cyan('  • Pastella Version: '), chalk.white.bold(version));
    console.log(chalk.cyan('  • Node.js Version:  '), chalk.white.bold(nodeVersion));
    console.log(chalk.cyan('  • Platform:         '), chalk.white.bold(`${platform} ${arch}`));
    console.log(chalk.cyan('  • License:          '), chalk.white.bold(packageJson.license));
    console.log(chalk.cyan('  • Author:           '), chalk.white.bold(packageJson.author));
    console.log('');
    console.log(chalk.yellow.bold('🔗 BLOCKCHAIN SPECS:'));
    console.log(chalk.yellow('  • Consensus:       '), chalk.white.bold('Proof of Work (KawPow)'));
    console.log(chalk.yellow('  • Block Time:      '), chalk.white.bold(`${config.blockchain.blockTime / 1000}s`));
    console.log(
      chalk.yellow('  • Genesis Difficulty:'),
      chalk.white.bold(config.blockchain.genesis?.difficulty || 'Not set')
    );
    console.log(
      chalk.yellow('  • Difficulty Algorithm:'),
      chalk.white.bold(config.blockchain.difficultyAlgorithm || 'lwma3')
    );
    console.log(chalk.yellow('  • Coinbase Reward: '), chalk.white.bold(`${config.blockchain.coinbaseReward} PAS`));
    console.log('');
    process.exit(0);
  }

  // Parse arguments with values
  const parseArgValue = argName => {
    const index = args.indexOf(argName);
    if (index !== -1 && index + 1 < args.length) {
      return args[index + 1];
    }
    return null;
  };

  // Override config based on arguments
  if (args.includes('--no-api')) {
    config.api.enabled = false;
  }
  if (args.includes('--no-p2p')) {
    config.network.enabled = false;
  }
  if (args.includes('--wallet')) {
    config.wallet = config.wallet || {};
    config.wallet.enabled = true;
  }

  // Parse configurable values
  const apiPort = parseArgValue('--api-port');
  if (apiPort) {
    const port = parseInt(apiPort);
    if (isNaN(port) || port < 1 || port > 65535) {
      logger.error('SYSTEM', 'Invalid API port. Must be between 1 and 65535.');
      process.exit(1);
    }
    config.api.port = port;
  }

  const p2pPort = parseArgValue('--p2p-port');
  if (p2pPort) {
    const port = parseInt(p2pPort);
    if (isNaN(port) || port < 1 || port > 65535) {
      logger.error('SYSTEM', 'Invalid P2P port. Must be between 1 and 65535.');
      process.exit(1);
    }
    config.network.p2pPort = port;
  }

  const dataDir = parseArgValue('--data-dir');
  if (dataDir) {
    config.storage.dataDir = dataDir;
  }

  const difficultyAlgorithm = parseArgValue('--difficulty-algorithm');
  if (difficultyAlgorithm) {
    if (!['aggressive', 'dogecoin', 'lwma3'].includes(difficultyAlgorithm)) {
      logger.error('SYSTEM', 'Invalid difficulty algorithm. Must be "aggressive", "dogecoin", or "lwma3".');
      process.exit(1);
    }
    config.blockchain.difficultyAlgorithm = difficultyAlgorithm;
    logger.info('SYSTEM', `Difficulty algorithm set to: ${difficultyAlgorithm}`);
  }

  const blockTime = parseArgValue('--block-time');
  if (blockTime) {
    const time = parseInt(blockTime);
    if (isNaN(time) || time < 1000 || time > 300000) {
      logger.error('SYSTEM', 'Invalid block time. Must be between 1000 and 300000 ms.');
      process.exit(1);
    }
    config.blockchain.blockTime = time;
  }

  const minSeedConn = parseArgValue('--min-seed-conn');
  if (minSeedConn) {
    const minConn = parseInt(minSeedConn);
    if (isNaN(minConn) || minConn < 0 || minConn > 10) {
      logger.error('SYSTEM', 'Invalid minimum seed connections. Must be between 0 and 10.');
      process.exit(1);
    }
    config.network.minSeedConnections = minConn;
  }

  const apiKey = parseArgValue('--api-key');
  if (apiKey) {
    if (apiKey.length < 8) {
      logger.error('SYSTEM', 'API key must be at least 8 characters long.');
      process.exit(1);
    }
    config.api = config.api || {};
    config.api.apiKey = apiKey;
    logger.info('SYSTEM', 'API authentication enabled');
  }

  // Parse host binding argument
  const host = parseArgValue('--host');
  if (host) {
    // Validate host format
    const isValidHost = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(host);
    if (!isValidHost) {
      logger.error('SYSTEM', 'Invalid host format. Must be a valid IP address or localhost.');
      logger.error('SYSTEM', 'Examples: 127.0.0.1, 192.168.1.100, 0.0.0.0');
      process.exit(1);
    }

    config.api = config.api || {};
    config.api.host = host;

    // CRITICAL: Require API key for non-localhost binding
    if (host !== '127.0.0.1' && host !== 'localhost') {
      if (!apiKey) {
        console.error(chalk.red('🚨 SECURITY ERROR: API key is REQUIRED when binding to external interfaces!'));
        console.error(chalk.red('   Binding to external interfaces without authentication is a security risk.'));
        console.error(chalk.red('   Please provide an API key with --api-key <key>'));
        console.error(chalk.red('   Or use --host 127.0.0.1 for localhost-only access.'));
        process.exit(1);
      }
    }
  } else {
    // Default to localhost for security
    config.api = config.api || {};
    config.api.host = '127.0.0.1';
  }

  // Load custom config file if specified
  const configPath = parseArgValue('--config');
  if (configPath) {
    try {
      const customConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // Merge custom config with defaults
      config = { ...config, ...customConfig };
      logger.info('SYSTEM', `Loaded custom config from: ${configPath}`);
    } catch (error) {
      logger.error('SYSTEM', `Failed to load config file: ${error.message}`);
      process.exit(1);
    }
  }

  try {
    await daemon.start(config);
  } catch (error) {
    logger.error('SYSTEM', `Failed to start daemon: ${error.message}`);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = PastellaDaemon;
