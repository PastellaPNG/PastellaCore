const WebSocket = require('ws');
const dns = require('dns');
const { promisify } = require('util');
const path = require('path');
const Blockchain = require('../models/Blockchain');
const Block = require('../models/Block');
const { Transaction } = require('../models/Transaction');
const fs = require('fs');
const logger = require('../utils/logger');
const NodeIdentity = require('./NodeIdentity');
const MessageValidator = require('../utils/MessageValidator');
const NetworkPartitionHandler = require('./NetworkPartitionHandler');

// Promisify DNS functions
const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve = promisify(dns.resolve);

class P2PNetwork {
  constructor(blockchain, port = 3001, config = null) {
    this.blockchain = blockchain;
    this.port = port;
    this.peers = new Set();
    this.wss = null;
    this.isRunning = false;
    this.messageHandlers = new Map();
    this.maxPeers = 10;
    this.config = config;
    this.seedNodes = [];
    this.isSeedNode = false;
    this.seedNodeConfig = null;
    this.connectedSeedNodes = 0;
    this.minSeedConnections = (config?.network?.minSeedConnections !== undefined) ? config.network.minSeedConnections : 2;
    this.networkSyncStatus = {
      isSyncing: false,
      lastSyncTime: null,
      syncAttempts: 0,
      maxSyncAttempts: 5
    };
    
    // Seed node reconnection tracking
    this.seedNodeConnections = new Map(); // Track connection status per seed node
    this.reconnectionInterval = null;
    this.reconnectionIntervalMs = 60000; // 60 seconds
    
    // Periodic sync tracking
    this.periodicSyncInterval = null;
    
    // Get data directory from config
    const dataDir = config?.storage?.dataDir || './data';
    
    // Peer reputation tracking system
    this.peerReputation = new Map(); // Map<peerAddress, reputationData>
    this.peerReputationFile = path.join(dataDir, 'peer-reputation.json');
    this.reputationConfig = {
      initialScore: 100,
      maxScore: 1000,
      minScore: -1000,
      goodBehaviorBonus: 10,
      badBehaviorPenalty: 50,
      banThreshold: -500,
      banDuration: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
      scoreDecayRate: 0.95, // Score decays by 5% per hour
      lastDecayTime: Date.now()
    };
    
    // Node identity and authentication system
    this.nodeIdentity = new NodeIdentity(null, null, dataDir);
    this.authenticatedPeers = new Map(); // Map<peerAddress, {nodeId, publicKey, authenticatedAt}>
    this.pendingChallenges = new Map(); // Map<peerAddress, {challenge, timestamp, nodeId}>
    this.initiatedAuthentication = new Set(); // Set<peerAddress> - track which peers we've initiated auth with
    this.authenticationTimeout = 10000; // 10 seconds for authentication (reduced for faster operation)
    
    // Message validation system
    this.messageValidator = new MessageValidator();
    this.messageValidationStats = {
      totalMessages: 0,
      validMessages: 0,
      invalidMessages: 0,
      validationErrors: new Map() // Map<errorType, count>
    };
    
    // Network partition handling system
    this.partitionHandler = new NetworkPartitionHandler(this);
    
    // Force IPv4-only DNS resolution
    this.setupIPv4OnlyDNS();
    this.setupMessageHandlers();
    this.loadSeedNodes();
    this.loadPeerReputation();
  }

  /**
   * Setup IPv4-only DNS resolution
   */
  setupIPv4OnlyDNS() {
    // Configure DNS to prefer IPv4
    dns.setDefaultResultOrder('ipv4first');
    logger.info('P2P', 'DNS resolution configured for IPv4-first');
  }

  /**
   * Load seed nodes from config
   */
  loadSeedNodes() {
    if (this.config && this.config.network && this.config.network.seedNodes) {
      this.seedNodes = this.config.network.seedNodes;
    }
  }

  /**
   * Setup seed node configuration
   */
  setupSeedNode(seedConfig) {
    this.isSeedNode = true;
    this.seedNodeConfig = seedConfig;
    this.maxPeers = seedConfig.maxConnections || 50;
    logger.info('P2P', `Seed node configured with max connections: ${this.maxPeers}`);
  }

  /**
   * Setup message handlers
   */
  setupMessageHandlers() {
    this.messageHandlers.set('QUERY_LATEST', this.handleQueryLatest.bind(this));
    this.messageHandlers.set('QUERY_ALL', this.handleQueryAll.bind(this));
    this.messageHandlers.set('RESPONSE_BLOCKCHAIN', this.handleResponseBlockchain.bind(this));
    this.messageHandlers.set('QUERY_TRANSACTION_POOL', this.handleQueryTransactionPool.bind(this));
    this.messageHandlers.set('RESPONSE_TRANSACTION_POOL', this.handleResponseTransactionPool.bind(this));
    this.messageHandlers.set('NEW_BLOCK', this.handleNewBlock.bind(this));
    this.messageHandlers.set('NEW_TRANSACTION', this.handleNewTransaction.bind(this));
    this.messageHandlers.set('SEED_NODE_INFO', this.handleSeedNodeInfo.bind(this));
    
    // Authentication message handlers
    this.messageHandlers.set('HANDSHAKE', this.handleHandshake.bind(this));
    this.messageHandlers.set('AUTH_CHALLENGE', this.handleAuthChallenge.bind(this));
    this.messageHandlers.set('AUTH_RESPONSE', this.handleAuthResponse.bind(this));
    this.messageHandlers.set('AUTH_SUCCESS', this.handleAuthSuccess.bind(this));
    this.messageHandlers.set('AUTH_FAILURE', this.handleAuthFailure.bind(this));
    
    // Partition handling message handlers
    this.messageHandlers.set('HEALTH_STATUS', this.handleHealthStatus.bind(this));
    this.messageHandlers.set('REQUEST_PEER_LIST', this.handleRequestPeerList.bind(this));
    this.messageHandlers.set('HEARTBEAT', this.handleHeartbeat.bind(this));
  }

  /**
   * Start P2P network
   */
  async start() {
    if (this.isRunning) {
      return false;
    }

    // Create HTTP server bound to IPv4 only
    const http = require('http');
    const server = http.createServer();
    
    // Bind to IPv4 only
    server.listen(this.port, '0.0.0.0', () => {
      logger.info('P2P', `P2P server listening on IPv4 0.0.0.0:${this.port}`);
    });
    
    this.wss = new WebSocket.Server({ server });
    
    this.wss.on('connection', (ws, req) => {
      const remoteAddress = req.socket.remoteAddress;
      logger.info('P2P', `New peer connected: ${remoteAddress}:${req.socket.remotePort}`);
      this.handleConnection(ws);
    });

    this.isRunning = true;
    
    // Start reputation maintenance
    this.startReputationMaintenance();
    
    // Start partition handling
    this.partitionHandler.start();
    
    // Connect to seed nodes if not running as seed node
    if (!this.isSeedNode && this.seedNodes.length > 0) {
      try {
        await this.connectToSeedNodes();
        // Wait for authentication to complete before syncing
        logger.info('P2P', 'Waiting for authentication to complete before network sync...');
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds for authentication
        // Start network synchronization after successful seed node connections
        await this.syncWithNetwork();
      } catch (error) {
        console.error(`❌ Failed to establish network connectivity: ${error.message}`);
        throw error;
      }
    }
    
    return true;
  }

  /**
   * Connect to seed nodes with minimum connection requirement
   */
  async connectToSeedNodes() {
    if (this.minSeedConnections === 0) {
      logger.info('P2P', 'P2P Network: Standalone mode (no seed connections required)');
      return 0;
    }
    
    logger.info('P2P', 'P2P Network: Attempting to connect to seed nodes...');
    
    // Filter out seed nodes that match our own port to prevent self-connection
    const filteredSeedNodes = this.seedNodes.filter(seedNode => {
      try {
        const url = new URL(seedNode);
        if (url.port === this.port.toString()) {
          return false; // Skip self-connection silently
        }
        return true;
      } catch (error) {
        return false; // Skip invalid URLs silently
      }
    });
    
    if (filteredSeedNodes.length === 0) {
      logger.info('P2P', 'P2P Network: No external seed nodes available');
      this.minSeedConnections = 0;
      return 0;
    }
    
    // Initialize seed node connection tracking
    filteredSeedNodes.forEach(seedNode => {
      this.seedNodeConnections.set(seedNode, { connected: false, lastAttempt: 0 });
    });
    
    const connectionPromises = filteredSeedNodes.map(async (seedNode) => {
      try {
        const url = new URL(seedNode);
        const connected = await this.connectToPeer(url.hostname, url.port);
        if (connected) {
          this.connectedSeedNodes++;
          this.seedNodeConnections.set(seedNode, { connected: true, lastAttempt: Date.now() });
          return true;
        } else if (connected === null) {
          // Already connected, mark as connected
          this.seedNodeConnections.set(seedNode, { connected: true, lastAttempt: Date.now() });
          return true;
        } else {
          this.seedNodeConnections.set(seedNode, { connected: false, lastAttempt: Date.now() });
          return false;
        }
      } catch (error) {
        this.seedNodeConnections.set(seedNode, { connected: false, lastAttempt: Date.now() });
        return false; // Fail silently
      }
    });

    const results = await Promise.all(connectionPromises);
    const successfulConnections = results.filter(result => result).length;
    
    if (successfulConnections >= this.minSeedConnections) {
      logger.info('P2P', `P2P Network: Connected to ${successfulConnections} seed nodes`);
    } else if (this.minSeedConnections > 0) {
      logger.info('P2P', `P2P Network: Standalone mode (${successfulConnections}/${this.minSeedConnections} seed connections)`);
    }
    
    // Start reconnection process
    this.startSeedNodeReconnection();
    
    return successfulConnections;
  }

  /**
   * Start seed node reconnection process
   */
  startSeedNodeReconnection() {
    if (this.reconnectionInterval) {
      clearInterval(this.reconnectionInterval);
    }
    
    this.reconnectionInterval = setInterval(() => {
      this.attemptSeedNodeReconnection();
    }, this.reconnectionIntervalMs);
    
    logger.debug('P2P', `Seed node reconnection process started (every ${this.reconnectionIntervalMs / 1000}s)`);
  }

  /**
   * Attempt to reconnect to disconnected seed nodes
   */
  async attemptSeedNodeReconnection() {
    if (!this.isRunning || this.isSeedNode) {
      return;
    }
    
    const now = Date.now();
    const disconnectedSeedNodes = [];
    
    // Find disconnected seed nodes that haven't been attempted recently
    for (const [seedNode, status] of this.seedNodeConnections.entries()) {
      if (!status.connected && (now - status.lastAttempt) >= this.reconnectionIntervalMs) {
        disconnectedSeedNodes.push(seedNode);
      }
    }
    
    if (disconnectedSeedNodes.length === 0) {
      return; // No disconnected seed nodes to reconnect
    }
    
    // Only log reconnection attempts at debug level to reduce spam
    logger.debug('P2P', `Attempting to reconnect to ${disconnectedSeedNodes.length} disconnected seed nodes...`);
    
    for (const seedNode of disconnectedSeedNodes) {
      try {
        const url = new URL(seedNode);
        
        // Check if this is still our own port (in case config changed)
        if (url.port === this.port.toString()) {
          continue; // Skip self-connection
        }
        
        // Update last attempt time
        this.seedNodeConnections.set(seedNode, { 
          connected: false, 
          lastAttempt: now 
        });
        
        const connected = await this.connectToPeer(url.hostname, url.port);
        if (connected) {
          this.connectedSeedNodes++;
          this.seedNodeConnections.set(seedNode, { 
            connected: true, 
            lastAttempt: now 
          });
          logger.info('P2P', `✅ Reconnected to seed node: ${url.hostname}:${url.port}`);
        } else if (connected === null) {
          // Already connected, just update status
          this.seedNodeConnections.set(seedNode, { 
            connected: true, 
            lastAttempt: now 
          });
          logger.debug('P2P', `Seed node already connected: ${seedNode}`);
        }
      } catch (error) {
        // Connection failed, keep as disconnected - only log at debug level
        logger.debug('P2P', `Reconnection failed for ${seedNode}: ${error.message}`);
      }
    }
  }

  /**
   * Stop seed node reconnection process
   */
  stopSeedNodeReconnection() {
    if (this.reconnectionInterval) {
      clearInterval(this.reconnectionInterval);
      this.reconnectionInterval = null;
      logger.info('P2P', 'Seed node reconnection process stopped');
    }
  }

  /**
   * Mark a seed node as disconnected based on peer address
   */
  markSeedNodeAsDisconnected(peerAddress) {
    // Convert IPv6 localhost to IPv4 for comparison
    const normalizedPeerAddress = peerAddress.replace('::1', '127.0.0.1');
    
    for (const [seedNode, status] of this.seedNodeConnections.entries()) {
      try {
        const url = new URL(seedNode);
        const seedNodeAddress = `${url.hostname === 'localhost' ? '127.0.0.1' : url.hostname}:${url.port}`;
        
        if (seedNodeAddress === normalizedPeerAddress && status.connected) {
          this.seedNodeConnections.set(seedNode, { 
            connected: false, 
            lastAttempt: Date.now() 
          });
          return true; // This was a seed node
        }
      } catch (error) {
        // Skip invalid URLs
      }
    }
    
    return false; // This was not a seed node
  }

  /**
   * Stop P2P network
   */
  stop() {
    if (!this.isRunning) {
      console.log('P2P network is not running');
      return false;
    }

    logger.info('P2P', 'Stopping P2P network...');

    // Stop reputation maintenance
    this.stopReputationMaintenance();

    // Stop partition handling
    this.partitionHandler.stop();

    // Stop reconnection process
    this.stopSeedNodeReconnection();

    // Stop periodic sync
    if (this.periodicSyncInterval) {
      clearInterval(this.periodicSyncInterval);
      this.periodicSyncInterval = null;
    }

    // Save reputation data before stopping
    this.savePeerReputation();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.peers.clear();
    this.seedNodeConnections.clear();
    this.isRunning = false;
    
    logger.info('P2P', 'P2P network stopped');
    return true;
  }

  /**
   * Handle new WebSocket connection
   */
  handleConnection(ws) {
    // Get peer address for reputation tracking
    const peerAddress = this.getPeerAddress(ws);
    
    // Check if peer is banned
    if (this.isPeerBanned(peerAddress)) {
      logger.warn('P2P', `[REPUTATION] Rejecting banned peer: ${peerAddress}`);
      ws.close();
      return;
    }
    
    // Check if we have reached max peers
    if (this.peers.size >= this.maxPeers) {
      logger.warn('P2P', `Max peers reached (${this.maxPeers}), rejecting connection`);
      this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'max_peers_reached' });
      ws.close();
      return;
    }

    // Update reputation for successful connection
    this.updatePeerReputation(peerAddress, 'connect');
    
    // Debug log reputation for new connections
    this.debugPeerReputation(peerAddress);

    this.peers.add(ws);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        
        // Update reputation for message received
        this.updatePeerReputation(peerAddress, 'message_received');
        
        this.handleMessage(ws, message);
      } catch (error) {
        logger.error('P2P', `Error parsing message: ${error.message}`);
        this.updatePeerReputation(peerAddress, 'invalid_message', { reason: 'json_parse_error' });
      }
    });

    ws.on('close', () => {
      // Update reputation for disconnect
      this.updatePeerReputation(peerAddress, 'disconnect');
      
      // Clean up authentication data
      this.authenticatedPeers.delete(peerAddress);
      this.pendingChallenges.delete(peerAddress);
      this.initiatedAuthentication.delete(peerAddress);
      
      // Check if this was a seed node connection
      const wasSeedNode = this.markSeedNodeAsDisconnected(peerAddress);
      
      this.peers.delete(ws);
      
      if (wasSeedNode) {
        logger.info('P2P', `Seed node disconnected: ${peerAddress}`);
        this.connectedSeedNodes = Math.max(0, this.connectedSeedNodes - 1);
      } else {
        // Notify partition handler of peer disconnection
        this.partitionHandler.handlePeerDisconnection(peerAddress);
      }
      logger.info('P2P', `Peer disconnected: ${peerAddress}`);
    });

    ws.on('error', (error) => {
      logger.error('P2P', `WebSocket error from ${peerAddress}: ${error.message}`);
      this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'websocket_error' });
      this.authenticatedPeers.delete(peerAddress);
      this.pendingChallenges.delete(peerAddress);
      this.initiatedAuthentication.delete(peerAddress);
      this.peers.delete(ws);
    });

    // Start authentication process - use deterministic timing based on node ID
    // The node with the lower node ID initiates authentication to prevent conflicts
    const myNodeId = this.nodeIdentity.nodeId;
    const delay = 20 + (parseInt(myNodeId.substring(0, 8), 16) % 50); // Reduced delay for faster authentication
    logger.debug('P2P', `[AUTH] Scheduling authentication initiation for ${peerAddress} in ${delay}ms (Node ID: ${myNodeId.substring(0, 16)}...)`);
    setTimeout(() => {
      // Check if we haven't received a handshake yet (meaning the other node hasn't initiated)
      if (!this.pendingChallenges.has(peerAddress) && !this.initiatedAuthentication.has(peerAddress)) {
        logger.debug('P2P', `[AUTH] No handshake received from ${peerAddress}, initiating authentication`);
        this.initiatedAuthentication.add(peerAddress);
        this.initiateAuthentication(ws, peerAddress);
      } else {
        logger.debug('P2P', `[AUTH] Handshake already received from ${peerAddress} or already initiated, skipping`);
      }
    }, delay);
  }



  /**
   * Send message to peer
   */
  sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast message to all peers
   */
  broadcast(message) {
    this.peers.forEach(peer => {
      this.sendMessage(peer, message);
    });
  }

  /**
   * Resolve hostname to IPv4 address
   */
  async resolveHostname(hostname) {
    try {
      // If it's already an IP address, return it
      if (this.isIPv4(hostname)) {
        return hostname;
      }
      
      // Handle localhost and common localhost variants without DNS
      const localhostVariants = ['localhost', 'localhost.localdomain', 'local', 'loopback'];
      if (localhostVariants.includes(hostname.toLowerCase())) {
        return '127.0.0.1';
      }
      
      // For other hostnames, try DNS resolution
      try {
        const addresses = await dnsResolve4(hostname);
        if (addresses.length > 0) {
          logger.info('P2P', `Resolved ${hostname} to ${addresses[0]}`);
          return addresses[0];
        }
      } catch (dnsError) {
        logger.error('P2P', `DNS resolution failed for ${hostname}: ${dnsError.message}`);
        throw dnsError;
      }
      
      throw new Error(`No IPv4 addresses found for ${hostname}`);
    } catch (error) {
      logger.error('P2P', `Failed to resolve ${hostname}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if string is a valid IPv4 address
   */
  isIPv4(ip) {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipv4Regex.test(ip);
  }

  /**
   * Connect to a peer with DNS resolution
   */
  async connectToPeer(host, port) {
    return new Promise(async (resolve, reject) => {
      try {
        // Resolve hostname to IPv4 address
        const resolvedHost = await this.resolveHostname(host);
        const targetAddress = `${resolvedHost}:${port}`;
        
        // Check if we're already connected to this peer
        const isAlreadyConnected = Array.from(this.peers).some(peer => {
          const peerAddress = `${peer._socket.remoteAddress}:${peer._socket.remotePort}`;
          const normalizedPeerAddress = peerAddress.replace('::1', '127.0.0.1');
          return normalizedPeerAddress === targetAddress;
        });
        
        if (isAlreadyConnected) {
          logger.debug('P2P', `Already connected to ${host} (${targetAddress}), skipping`);
          resolve(null); // Return null to indicate already connected
          return;
        }
        
        const ws = new WebSocket(`ws://${targetAddress}`);
        
        ws.on('open', () => {
          logger.info('P2P', `Connected to peer: ${host} (${targetAddress})`);
          this.handleConnection(ws);
          resolve(ws);
        });
        
        ws.on('error', (error) => {
          // Only log connection errors at debug level to reduce spam
          logger.debug('P2P', `Failed to connect to ${host} (${targetAddress}): ${error.message}`);
          reject(error);
        });
        
        ws.on('close', () => {
          // Only log connection close at debug level to reduce spam
          logger.debug('P2P', `Connection closed to ${host} (${targetAddress})`);
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle seed node info message
   */
  handleSeedNodeInfo(ws, message) {
    logger.info('P2P', `Received seed node info: ${JSON.stringify(message.data)}`);
  }

  /**
   * Handle query latest block
   */
  handleQueryLatest(ws, message) {
    const latestBlock = this.blockchain.getLatestBlock();
    this.sendMessage(ws, {
      type: 'RESPONSE_BLOCKCHAIN',
      data: {
        blocks: [latestBlock.toJSON()]
      }
    });
  }

  /**
   * Handle query all blocks
   */
  handleQueryAll(ws, message) {
    this.sendMessage(ws, {
      type: 'RESPONSE_BLOCKCHAIN',
      data: {
        blocks: this.blockchain.chain.map(block => block.toJSON())
      }
    });
  }

  /**
   * Handle blockchain response
   */
  handleResponseBlockchain(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    const receivedChainData = message.data.blocks;
    
    if (receivedChainData.length === 0) {
      logger.debug('P2P', `[REPUTATION] Empty blockchain response from ${peerAddress}`);
      return; // Skip empty blockchain silently
    }

    try {
      // Convert JSON data back to Block objects
      const receivedChain = receivedChainData.map(blockData => Block.fromJSON(blockData));
    const latestBlockReceived = receivedChain[receivedChain.length - 1];
    const latestBlockHeld = this.blockchain.getLatestBlock();

    if (latestBlockReceived.index > latestBlockHeld.index) {
        logger.info('SYNC', `Received block ${latestBlockReceived.index} (we have ${latestBlockHeld.index}) from ${peerAddress}`);
      
      if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
        if (this.blockchain.addBlock(latestBlockReceived)) {
            logger.info('BLOCKCHAIN', `Added block ${latestBlockReceived.index} to chain from ${peerAddress}`);
          this.broadcastNewBlock(latestBlockReceived);
            this.updatePeerReputation(peerAddress, 'sync_success', { blocksReceived: receivedChain.length });
          } else {
            logger.warn('P2P', `[REPUTATION] Failed to add block from ${peerAddress}`);
            this.updatePeerReputation(peerAddress, 'sync_failure', { reason: 'block_add_failed' });
        }
      } else if (receivedChain.length === 1) {
          logger.debug('P2P', `[REPUTATION] Chain replacement needed from ${peerAddress}`);
        this.broadcast({ type: 'QUERY_ALL' });
      } else {
          logger.info('BLOCKCHAIN', `Replacing chain with ${receivedChain.length} blocks from ${peerAddress}`);
        this.blockchain.replaceChain(receivedChain);
          this.updatePeerReputation(peerAddress, 'sync_success', { chainReplaced: true, blocksReceived: receivedChain.length });
      }
    } else {
        logger.debug('P2P', `[REPUTATION] Blockchain up to date from ${peerAddress}`);
        this.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'up_to_date_sync' });
      }
    } catch (error) {
      logger.error('P2P', `[REPUTATION] Error processing blockchain response from ${peerAddress}: ${error.message}`);
      this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'blockchain_processing_error' });
    }
  }

  /**
   * Handle query transaction pool
   */
  handleQueryTransactionPool(ws, message) {
    this.sendMessage(ws, {
      type: 'RESPONSE_TRANSACTION_POOL',
      data: {
        transactions: this.blockchain.pendingTransactions.map(tx => tx.toJSON())
      }
    });
  }

  /**
   * Handle transaction pool response
   */
  handleResponseTransactionPool(ws, message) {
    const receivedTransactionData = message.data.transactions;
    
    receivedTransactionData.forEach(transactionData => {
      try {
        const transaction = Transaction.fromJSON(transactionData);
        this.blockchain.addPendingTransaction(transaction);
      } catch (error) {
        logger.error('P2P', `Error adding transaction from pool: ${error.message}`);
      }
    });
  }

  /**
   * Handle new block
   */
  handleNewBlock(ws, message) {
    const blockData = message.data;
    
    try {
      const block = Block.fromJSON(blockData);
      
      // Check if block already exists before attempting to add
      if (this.blockchain.chain.some(existingBlock => existingBlock.hash === block.hash)) {
        logger.debug('BLOCKCHAIN', `Block ${block.index} (${block.hash.substring(0, 16)}...) already exists, skipping`);
        return;
      }
      
      if (this.blockchain.addBlock(block)) {
        this.broadcastNewBlock(block);
      } else {
        logger.debug('BLOCKCHAIN', `Block ${block.index} validation failed, likely duplicate or outdated`);
      }
    } catch (error) {
      logger.error('BLOCKCHAIN', `Error adding new block: ${error.message}`);
    }
  }

  /**
   * Handle new transaction
   */
  handleNewTransaction(ws, message) {
    const transactionData = message.data;
    
    try {
      const transaction = Transaction.fromJSON(transactionData);
      this.blockchain.addPendingTransaction(transaction);
      this.broadcastNewTransaction(transaction);
    } catch (error) {
      logger.error('P2P', `Error adding new transaction: ${error.message}`);
    }
  }

  /**
   * Broadcast new block to all peers
   */
  broadcastNewBlock(block) {
    this.broadcast({
      type: 'NEW_BLOCK',
      data: block.toJSON()
    });
  }

  /**
   * Broadcast new transaction to all peers
   */
  broadcastNewTransaction(transaction) {
    this.broadcast({
      type: 'NEW_TRANSACTION',
      data: transaction.toJSON()
    });
  }

  /**
   * Sync blockchain with peers
   */
  syncBlockchain() {
    this.broadcast({ type: 'QUERY_LATEST' });
  }

  /**
   * Sync transaction pool with peers
   */
  syncTransactionPool() {
    this.broadcast({ type: 'QUERY_TRANSACTION_POOL' });
  }

  /**
   * Synchronize with the network
   */
  async syncWithNetwork() {
    if (this.networkSyncStatus.isSyncing) {
      return; // Skip if already syncing
    }

    // Check if we have any connected peers to sync with
    if (this.peers.size === 0) {
      return; // Skip sync silently when no peers
    }

    if (this.connectedSeedNodes < this.minSeedConnections) {
      return; // Skip sync silently when insufficient connections
    }

    this.networkSyncStatus.isSyncing = true;
    this.networkSyncStatus.syncAttempts++;
    
    try {
      // Sync blockchain first
      await this.syncBlockchain();
      
      // Then sync transaction pool
      await this.syncTransactionPool();
      
      this.networkSyncStatus.lastSyncTime = new Date();
      this.networkSyncStatus.isSyncing = false;
      
      // Only log successful sync occasionally to reduce spam
      if (this.networkSyncStatus.syncAttempts % 20 === 0) {
        logger.info('NETWORK', `Network sync: ${this.peers.size} peers, ${this.blockchain.chain.length} blocks`);
      }
      
      // Schedule periodic sync (only if not already scheduled)
      if (!this.periodicSyncInterval) {
        this.schedulePeriodicSync();
      }
      
    } catch (error) {
      this.networkSyncStatus.isSyncing = false;
      console.error(`❌ Network sync failed: ${error.message}`);
      
      if (this.networkSyncStatus.syncAttempts < this.networkSyncStatus.maxSyncAttempts) {
        setTimeout(() => this.syncWithNetwork(), 5000);
      } else {
        console.error(`Network sync failed after ${this.networkSyncStatus.maxSyncAttempts} attempts`);
      }
    }
  }

  /**
   * Schedule periodic network synchronization
   */
  schedulePeriodicSync() {
    // Clear any existing interval first
    if (this.periodicSyncInterval) {
      clearInterval(this.periodicSyncInterval);
    }
    
    // Sync every 30 seconds, but only if we have peers and sufficient seed connections
    this.periodicSyncInterval = setInterval(() => {
      if (this.isRunning && this.peers.size > 0 && this.connectedSeedNodes >= this.minSeedConnections) {
        this.syncWithNetwork().catch(error => {
          console.error(`Periodic sync failed: ${error.message}`);
        });
      }
    }, 30000);
    
    logger.info('P2P', 'Periodic network sync scheduled (every 30s)');
  }

  /**
   * Enhanced blockchain synchronization
   */
  async syncBlockchain() {
    return new Promise((resolve, reject) => {
      // If no peers are connected, resolve immediately
      if (this.peers.size === 0) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Blockchain sync timeout'));
      }, 10000);

      this.broadcast({ type: 'QUERY_LATEST' });
      
      // Wait for responses and update blockchain
      const checkInterval = setInterval(() => {
        if (this.peers.size > 0) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * Get network status
   */
  getNetworkStatus() {
    const reputationStats = this.getReputationStats();
    const authenticatedPeers = this.getAuthenticatedPeers();
    const messageValidationStats = this.getMessageValidationStats();
    const partitionStats = this.partitionHandler.getPartitionStats();
    
    return {
      isRunning: this.isRunning,
      port: this.port,
      peerCount: this.peers.size,
      maxPeers: this.maxPeers,
      isSeedNode: this.isSeedNode,
      connectedSeedNodes: this.connectedSeedNodes,
      minSeedConnections: this.minSeedConnections,
      networkSyncStatus: this.networkSyncStatus,
      seedNodes: this.seedNodes,
      nodeIdentity: {
        nodeId: this.nodeIdentity.nodeId,
        publicKey: this.nodeIdentity.publicKey ? '***' : null // Don't expose full public key
      },
      authentication: {
        authenticatedPeers: authenticatedPeers.length,
        totalPeers: this.peers.size,
        authenticationRate: this.peers.size > 0 ? Math.round((authenticatedPeers.length / this.peers.size) * 100) : 0
      },
      messageValidation: {
        totalMessages: messageValidationStats.totalMessages,
        validMessages: messageValidationStats.validMessages,
        invalidMessages: messageValidationStats.invalidMessages,
        validationRate: messageValidationStats.validationRate,
        supportedMessageTypes: messageValidationStats.validatorStats.messageTypes
      },
      reputation: {
        totalPeers: reputationStats.totalPeers,
        goodPeers: reputationStats.goodPeers,
        badPeers: reputationStats.badPeers,
        bannedPeers: reputationStats.bannedPeers,
        averageScore: reputationStats.averageScore
      },
      partitionHandling: {
        isPartitioned: partitionStats.isPartitioned,
        totalPartitions: partitionStats.totalPartitions,
        currentPartitions: partitionStats.currentPartitions,
        partitionDuration: partitionStats.partitionDuration,
        recoveryAttempts: partitionStats.recoveryAttempts,
        successfulRecoveries: partitionStats.successfulRecoveries,
        failedRecoveries: partitionStats.failedRecoveries,
        disconnectedPeers: partitionStats.disconnectedPeers,
        recoveryInProgress: partitionStats.recoveryInProgress,
        lastHealthCheck: partitionStats.lastHealthCheck
      }
    };
  }

  /**
   * Get list of connected peers
   */
  getPeerList() {
    const peerList = [];
    this.peers.forEach(peer => {
      const remoteAddress = peer._socket.remoteAddress;
      const remotePort = peer._socket.remotePort;
      
      // Convert IPv6 localhost to IPv4 for consistency
      const displayAddress = remoteAddress === '::1' ? '127.0.0.1' : remoteAddress;
      const peerAddress = `${displayAddress}:${remotePort}`;
      
      // Check if this is a seed node connection
      const isSeedNode = this.isSeedNodeConnection(peerAddress);
      
      // Get reputation data
      const reputation = this.getPeerReputation(peerAddress);
      
      // Get authentication data
      const authInfo = this.getAuthenticatedPeerInfo(peerAddress);
      
      peerList.push({
        url: peerAddress,
        originalAddress: remoteAddress,
        readyState: peer.readyState,
        isSeedNode: isSeedNode,
        authenticated: !!authInfo,
        nodeId: authInfo ? authInfo.nodeId : null,
        authenticatedAt: authInfo ? new Date(authInfo.authenticatedAt).toISOString() : null,
        reputation: {
          score: reputation.score,
          banned: reputation.banned,
          banExpiry: reputation.banExpiry,
          connectionCount: reputation.connectionCount,
          goodActions: reputation.goodActions,
          badActions: reputation.badActions,
          messageCount: reputation.messageCount,
          invalidMessageCount: reputation.invalidMessageCount,
          lastSeen: reputation.lastSeen
        }
      });
    });
    return peerList;
  }

  /**
   * Check if a peer address corresponds to a seed node
   */
  isSeedNodeConnection(peerAddress) {
    for (const [seedNode, status] of this.seedNodeConnections.entries()) {
      try {
        const url = new URL(seedNode);
        const seedNodeAddress = `${url.hostname === 'localhost' ? '127.0.0.1' : url.hostname}:${url.port}`;
        
        if (seedNodeAddress === peerAddress) {
          return true;
        }
      } catch (error) {
        // Skip invalid URLs
      }
    }
    return false;
  }

  /**
   * Disconnect specific peer
   */
  disconnectPeer(ws) {
    if (this.peers.has(ws)) {
      ws.close();
      this.peers.delete(ws);
      console.log('Peer disconnected manually');
    }
  }

  /**
   * Disconnect all peers
   */
  disconnectAllPeers() {
    this.peers.forEach(peer => {
      peer.close();
    });
    this.peers.clear();
    console.log('All peers disconnected');
  }

  /**
   * Get seed node information
   */
  getSeedNodeInfo() {
    if (!this.isSeedNode) {
      return null;
    }
    
    return {
      isSeedNode: true,
      port: this.port,
      maxConnections: this.maxPeers,
      currentConnections: this.peers.size,
      seedNodes: this.seedNodes
    };
  }

  // ===== PEER REPUTATION SYSTEM =====

  /**
   * Start reputation maintenance (decay and save)
   */
  startReputationMaintenance() {
    // Decay reputation scores every hour
    this.reputationDecayInterval = setInterval(() => {
      this.decayReputationScores();
    }, 60 * 60 * 1000); // 1 hour

    // Save reputation data every 5 minutes
    this.reputationSaveInterval = setInterval(() => {
      this.savePeerReputation();
    }, 5 * 60 * 1000); // 5 minutes

    // Log reputation stats every 10 minutes
    this.reputationStatsInterval = setInterval(() => {
      const stats = this.getReputationStats();
      logger.debug('P2P', `[REPUTATION STATS] Total: ${stats.totalPeers}, Good: ${stats.goodPeers}, Bad: ${stats.badPeers}, Banned: ${stats.bannedPeers}, Avg Score: ${stats.averageScore}`);
    }, 10 * 60 * 1000); // 10 minutes

    logger.info('P2P', '[REPUTATION] Started reputation maintenance system');
  }

  /**
   * Stop reputation maintenance
   */
  stopReputationMaintenance() {
    if (this.reputationDecayInterval) {
      clearInterval(this.reputationDecayInterval);
      this.reputationDecayInterval = null;
    }
    
    if (this.reputationSaveInterval) {
      clearInterval(this.reputationSaveInterval);
      this.reputationSaveInterval = null;
    }
    
    if (this.reputationStatsInterval) {
      clearInterval(this.reputationStatsInterval);
      this.reputationStatsInterval = null;
    }

    logger.info('P2P', '[REPUTATION] Stopped reputation maintenance system');
  }

  /**
   * Load peer reputation data from file
   */
  loadPeerReputation() {
    try {
      if (fs.existsSync(this.peerReputationFile)) {
        const data = fs.readFileSync(this.peerReputationFile, 'utf8');
        const reputationData = JSON.parse(data);
        
        // Convert back to Map
        this.peerReputation = new Map(Object.entries(reputationData));
        
        logger.info('P2P', `[REPUTATION] Loaded reputation data for ${this.peerReputation.size} peers`);
        logger.debug('P2P', `[REPUTATION] Reputation file: ${this.peerReputationFile}`);
      } else {
        logger.info('P2P', '[REPUTATION] No existing reputation file found, starting fresh');
      }
    } catch (error) {
      logger.error('P2P', `[REPUTATION] Failed to load reputation data: ${error.message}`);
      this.peerReputation = new Map();
    }
  }

  /**
   * Save peer reputation data to file
   */
  savePeerReputation() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.peerReputationFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Convert Map to object for JSON serialization
      const reputationData = Object.fromEntries(this.peerReputation);
      
      fs.writeFileSync(this.peerReputationFile, JSON.stringify(reputationData, null, 2));
      
      logger.debug('P2P', `[REPUTATION] Saved reputation data for ${this.peerReputation.size} peers`);
    } catch (error) {
      logger.error('P2P', `[REPUTATION] Failed to save reputation data: ${error.message}`);
    }
  }

  /**
   * Get peer address from WebSocket
   */
  getPeerAddress(ws) {
    try {
      const remoteAddress = ws._socket.remoteAddress;
      const remotePort = ws._socket.remotePort;
      
      // Convert IPv6 localhost to IPv4 for consistency
      const displayAddress = remoteAddress === '::1' ? '127.0.0.1' : remoteAddress;
      return `${displayAddress}:${remotePort}`;
    } catch (error) {
      logger.error('P2P', `[REPUTATION] Failed to get peer address: ${error.message}`);
      return 'unknown';
    }
  }

  /**
   * Get or create reputation data for a peer
   */
  getPeerReputation(peerAddress) {
    if (!this.peerReputation.has(peerAddress)) {
      const reputationData = {
        score: this.reputationConfig.initialScore,
        lastSeen: Date.now(),
        connectionCount: 0,
        goodActions: 0,
        badActions: 0,
        banned: false,
        banExpiry: null,
        lastMessageTime: null,
        messageCount: 0,
        invalidMessageCount: 0,
        syncAttempts: 0,
        successfulSyncs: 0
      };
      
      this.peerReputation.set(peerAddress, reputationData);
      logger.debug('P2P', `[REPUTATION] Created new reputation entry for ${peerAddress} (score: ${reputationData.score})`);
    }
    
    return this.peerReputation.get(peerAddress);
  }

  /**
   * Update peer reputation score
   */
  updatePeerReputation(peerAddress, action, details = {}) {
    const reputation = this.getPeerReputation(peerAddress);
    const oldScore = reputation.score;
    
    switch (action) {
      case 'connect':
        reputation.connectionCount++;
        reputation.lastSeen = Date.now();
        reputation.score = Math.min(reputation.score + 5, this.reputationConfig.maxScore);
        logger.debug('P2P', `[REPUTATION] ${peerAddress} connected (score: ${oldScore} → ${reputation.score})`);
        break;
        
      case 'disconnect':
        reputation.lastSeen = Date.now();
        logger.debug('P2P', `[REPUTATION] ${peerAddress} disconnected (score: ${reputation.score})`);
        break;
        
      case 'good_behavior':
        reputation.goodActions++;
        reputation.score = Math.min(reputation.score + this.reputationConfig.goodBehaviorBonus, this.reputationConfig.maxScore);
        logger.debug('P2P', `[REPUTATION] ${peerAddress} good behavior (score: ${oldScore} → ${reputation.score})`);
        break;
        
      case 'bad_behavior':
        reputation.badActions++;
        reputation.score = Math.max(reputation.score - this.reputationConfig.badBehaviorPenalty, this.reputationConfig.minScore);
        logger.warn('P2P', `[REPUTATION] ${peerAddress} bad behavior (score: ${oldScore} → ${reputation.score}) - ${details.reason || 'Unknown'}`);
        
        // Check if peer should be banned
        if (reputation.score <= this.reputationConfig.banThreshold && !reputation.banned) {
          reputation.banned = true;
          reputation.banExpiry = Date.now() + this.reputationConfig.banDuration;
          logger.warn('P2P', `[REPUTATION] ${peerAddress} banned until ${new Date(reputation.banExpiry).toISOString()}`);
        }
        break;
        
      case 'message_received':
        reputation.messageCount++;
        reputation.lastMessageTime = Date.now();
        reputation.score = Math.min(reputation.score + 1, this.reputationConfig.maxScore);
        logger.debug('P2P', `[REPUTATION] ${peerAddress} message received (score: ${oldScore} → ${reputation.score})`);
        break;
        
      case 'invalid_message':
        reputation.invalidMessageCount++;
        reputation.score = Math.max(reputation.score - 10, this.reputationConfig.minScore);
        logger.warn('P2P', `[REPUTATION] ${peerAddress} invalid message (score: ${oldScore} → ${reputation.score}) - ${details.reason || 'Unknown'}`);
        break;
        
      case 'sync_success':
        reputation.syncAttempts++;
        reputation.successfulSyncs++;
        reputation.score = Math.min(reputation.score + 15, this.reputationConfig.maxScore);
        logger.debug('P2P', `[REPUTATION] ${peerAddress} sync success (score: ${oldScore} → ${reputation.score})`);
        break;
        
      case 'sync_failure':
        reputation.syncAttempts++;
        reputation.score = Math.max(reputation.score - 5, this.reputationConfig.minScore);
        logger.debug('P2P', `[REPUTATION] ${peerAddress} sync failure (score: ${oldScore} → ${reputation.score})`);
        break;
        
      default:
        logger.warn('P2P', `[REPUTATION] Unknown reputation action: ${action}`);
    }
    
    // Save reputation data periodically
    if (Math.abs(oldScore - reputation.score) >= 10) {
      this.savePeerReputation();
    }
  }

  /**
   * Check if peer is banned
   */
  isPeerBanned(peerAddress) {
    const reputation = this.getPeerReputation(peerAddress);
    
    if (reputation.banned && reputation.banExpiry) {
      if (Date.now() > reputation.banExpiry) {
        // Ban expired, unban the peer
        reputation.banned = false;
        reputation.banExpiry = null;
        reputation.score = Math.max(reputation.score, 0); // Reset to at least 0
        logger.info('P2P', `[REPUTATION] ${peerAddress} ban expired, peer unbanned (score: ${reputation.score})`);
        this.savePeerReputation();
        return false;
      } else {
        logger.debug('P2P', `[REPUTATION] ${peerAddress} is banned until ${new Date(reputation.banExpiry).toISOString()}`);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Decay reputation scores over time (call periodically)
   */
  decayReputationScores() {
    const now = Date.now();
    const hoursSinceLastDecay = (now - this.reputationConfig.lastDecayTime) / (1000 * 60 * 60);
    
    if (hoursSinceLastDecay >= 1) { // Decay every hour
      let decayedCount = 0;
      
      this.peerReputation.forEach((reputation, peerAddress) => {
        const oldScore = reputation.score;
        
        // Decay score towards initial score
        if (reputation.score > this.reputationConfig.initialScore) {
          reputation.score = Math.max(
            this.reputationConfig.initialScore,
            reputation.score * Math.pow(this.reputationConfig.scoreDecayRate, hoursSinceLastDecay)
          );
        } else if (reputation.score < this.reputationConfig.initialScore) {
          reputation.score = Math.min(
            this.reputationConfig.initialScore,
            reputation.score + (this.reputationConfig.initialScore - reputation.score) * 0.1
          );
        }
        
        if (Math.abs(oldScore - reputation.score) > 1) {
          decayedCount++;
        }
      });
      
      this.reputationConfig.lastDecayTime = now;
      
      if (decayedCount > 0) {
        logger.debug('P2P', `[REPUTATION] Decayed scores for ${decayedCount} peers`);
        this.savePeerReputation();
      }
    }
  }

  /**
   * Get reputation statistics
   */
  getReputationStats() {
    const stats = {
      totalPeers: this.peerReputation.size,
      bannedPeers: 0,
      goodPeers: 0,
      badPeers: 0,
      averageScore: 0,
      totalScore: 0
    };
    
    this.peerReputation.forEach((reputation) => {
      stats.totalScore += reputation.score;
      
      if (reputation.banned) {
        stats.bannedPeers++;
      } else if (reputation.score >= 150) {
        stats.goodPeers++;
      } else if (reputation.score <= 50) {
        stats.badPeers++;
      }
    });
    
    stats.averageScore = stats.totalPeers > 0 ? Math.round(stats.totalScore / stats.totalPeers) : 0;
    
    return stats;
  }

  /**
   * Debug: Log reputation information for a peer
   */
  debugPeerReputation(peerAddress) {
    const reputation = this.getPeerReputation(peerAddress);
    logger.debug('P2P', `[REPUTATION DEBUG] ${peerAddress}:`, {
      score: reputation.score,
      banned: reputation.banned,
      banExpiry: reputation.banExpiry ? new Date(reputation.banExpiry).toISOString() : null,
      connectionCount: reputation.connectionCount,
      goodActions: reputation.goodActions,
      badActions: reputation.badActions,
      messageCount: reputation.messageCount,
      invalidMessageCount: reputation.invalidMessageCount,
      syncAttempts: reputation.syncAttempts,
      successfulSyncs: reputation.successfulSyncs,
      lastSeen: new Date(reputation.lastSeen).toISOString()
    });
  }

  // ==================== NODE AUTHENTICATION METHODS ====================

  /**
   * Initiate authentication process with a new peer
   */
  initiateAuthentication(ws, peerAddress) {
    logger.info('P2P', `[AUTH] Starting authentication with ${peerAddress}`);
    
    // Send handshake message
    const handshake = this.nodeIdentity.createHandshake();
    logger.debug('P2P', `[AUTH] Sending handshake to ${peerAddress} with Node ID: ${handshake.data.nodeId}`);
    this.sendMessage(ws, handshake);
    
    // Set authentication timeout
    setTimeout(() => {
      if (!this.authenticatedPeers.has(peerAddress)) {
        logger.warn('P2P', `[AUTH] Authentication timeout for ${peerAddress}`);
        this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'auth_timeout' });
        ws.close();
      }
    }, this.authenticationTimeout);
  }

  /**
   * Handle handshake message from peer
   */
  handleHandshake(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    
    try {
      // Verify handshake
      if (!this.nodeIdentity.verifyHandshake(message)) {
        logger.warn('P2P', `[AUTH] Invalid handshake from ${peerAddress}`);
        this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'invalid_handshake' });
        this.sendMessage(ws, { type: 'AUTH_FAILURE', reason: 'invalid_handshake' });
        ws.close();
        return;
      }

      const { data } = message;
      logger.info('P2P', `[AUTH] Valid handshake from ${peerAddress} (Node ID: ${data.nodeId})`);

      // Store the peer's handshake information
      this.pendingChallenges.set(peerAddress, {
        nodeId: data.nodeId,
        publicKey: data.publicKey,
        handshakeReceived: true
      });

      logger.debug('P2P', `[AUTH] Stored handshake from ${peerAddress}, total pending: ${this.pendingChallenges.size}`);

      // Send our handshake immediately if we haven't already
      if (!this.initiatedAuthentication.has(peerAddress)) {
        logger.debug('P2P', `[AUTH] Sending immediate handshake to ${peerAddress}`);
        this.initiatedAuthentication.add(peerAddress);
        const handshake = this.nodeIdentity.createHandshake();
        this.sendMessage(ws, handshake);
      }

      // Check if we have both handshakes and can proceed with challenge
      const pendingChallenge = this.pendingChallenges.get(peerAddress);
      if (pendingChallenge.handshakeReceived && this.initiatedAuthentication.has(peerAddress)) {
        logger.debug('P2P', `[AUTH] Both handshakes exchanged with ${peerAddress}, sending challenge`);
        
        // Create authentication challenge
        const challenge = this.nodeIdentity.createChallenge();
        this.pendingChallenges.set(peerAddress, {
          ...pendingChallenge,
          challenge: challenge.challenge,
          timestamp: challenge.timestamp
        });

        // Send challenge
        this.sendMessage(ws, {
          type: 'AUTH_CHALLENGE',
          data: challenge
        });
      }

    } catch (error) {
      logger.error('P2P', `[AUTH] Error handling handshake from ${peerAddress}: ${error.message}`);
      this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'handshake_error' });
      ws.close();
    }
  }

  /**
   * Handle authentication challenge from peer
   */
  handleAuthChallenge(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    
    try {
      const { data } = message;
      
      logger.debug('P2P', `[AUTH] Received challenge from ${peerAddress}, pending challenges: ${this.pendingChallenges.size}`);
      
      // Get the pending challenge to get the peer's public key
      const pendingChallenge = this.pendingChallenges.get(peerAddress);
      if (!pendingChallenge || !pendingChallenge.publicKey) {
        logger.warn('P2P', `[AUTH] No pending challenge or missing public key for ${peerAddress}`);
        logger.debug('P2P', `[AUTH] Available pending challenges: ${Array.from(this.pendingChallenges.keys()).join(', ')}`);
        this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'no_pending_challenge' });
        ws.close();
        return;
      }
      
      // Verify challenge using the public key from the handshake
      if (!this.nodeIdentity.verifyChallengeResponse(
        data.challenge, 
        data, 
        pendingChallenge.nodeId, 
        pendingChallenge.publicKey
      )) {
        logger.warn('P2P', `[AUTH] Invalid challenge from ${peerAddress}`);
        this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'invalid_challenge' });
        this.sendMessage(ws, { type: 'AUTH_FAILURE', reason: 'invalid_challenge' });
        ws.close();
        return;
      }

      // Create response to challenge
      const response = this.nodeIdentity.createChallengeResponse(data.challenge, data.timestamp);
      
      // Send response
      this.sendMessage(ws, {
        type: 'AUTH_RESPONSE',
        data: response
      });

    } catch (error) {
      logger.error('P2P', `[AUTH] Error handling challenge from ${peerAddress}: ${error.message}`);
      this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'challenge_error' });
      ws.close();
    }
  }

  /**
   * Handle authentication response from peer
   */
  handleAuthResponse(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    
    try {
      const pendingChallenge = this.pendingChallenges.get(peerAddress);
      if (!pendingChallenge) {
        logger.warn('P2P', `[AUTH] No pending challenge for ${peerAddress}`);
        this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'no_pending_challenge' });
        ws.close();
        return;
      }

      const { data } = message;
      
      // Verify response
      if (!this.nodeIdentity.verifyChallengeResponse(
        pendingChallenge.challenge,
        data,
        pendingChallenge.nodeId,
        pendingChallenge.publicKey
      )) {
        logger.warn('P2P', `[AUTH] Invalid response from ${peerAddress}`);
        this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'invalid_response' });
        this.sendMessage(ws, { type: 'AUTH_FAILURE', reason: 'invalid_response' });
        ws.close();
        return;
      }

      // Authentication successful
      this.authenticatedPeers.set(peerAddress, {
        nodeId: pendingChallenge.nodeId,
        publicKey: pendingChallenge.publicKey,
        authenticatedAt: Date.now()
      });

      this.pendingChallenges.delete(peerAddress);
      
      logger.info('P2P', `[AUTH] Authentication successful with ${peerAddress} (Node ID: ${pendingChallenge.nodeId})`);
      
      // Send success message
      this.sendMessage(ws, { type: 'AUTH_SUCCESS' });
      
      // Update reputation for successful authentication
      this.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'auth_success' });
      
      // Now send initial blockchain query and seed node info
      this.sendMessage(ws, { type: 'QUERY_LATEST' });
      
      if (this.isSeedNode) {
        this.sendMessage(ws, { 
          type: 'SEED_NODE_INFO', 
          data: {
            isSeedNode: true,
            maxConnections: this.maxPeers,
            currentConnections: this.peers.size
          }
        });
      }

    } catch (error) {
      logger.error('P2P', `[AUTH] Error handling response from ${peerAddress}: ${error.message}`);
      this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'response_error' });
      ws.close();
    }
  }

  /**
   * Handle authentication success message
   */
  handleAuthSuccess(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    logger.info('P2P', `[AUTH] Authentication confirmed by ${peerAddress}`);
    
    // Update reputation for successful authentication
    this.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'auth_confirmed' });
  }

  /**
   * Handle authentication failure message
   */
  handleAuthFailure(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    const reason = message.reason || 'unknown';
    logger.warn('P2P', `[AUTH] Authentication failed with ${peerAddress}: ${reason}`);
    
    this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: `auth_failed_${reason}` });
    ws.close();
  }

  /**
   * Check if peer is authenticated
   */
  isPeerAuthenticated(peerAddress) {
    return this.authenticatedPeers.has(peerAddress);
  }

  /**
   * Get authenticated peer info
   */
  getAuthenticatedPeerInfo(peerAddress) {
    return this.authenticatedPeers.get(peerAddress);
  }

  /**
   * Get all authenticated peers
   */
  getAuthenticatedPeers() {
    return Array.from(this.authenticatedPeers.entries()).map(([address, info]) => ({
      address,
      nodeId: info.nodeId,
      authenticatedAt: new Date(info.authenticatedAt).toISOString()
    }));
  }

  /**
   * Get message validation statistics
   */
  getMessageValidationStats() {
    const errorBreakdown = {};
    this.messageValidationStats.validationErrors.forEach((count, errorType) => {
      errorBreakdown[errorType] = count;
    });

    return {
      totalMessages: this.messageValidationStats.totalMessages,
      validMessages: this.messageValidationStats.validMessages,
      invalidMessages: this.messageValidationStats.invalidMessages,
      validationRate: this.messageValidationStats.totalMessages > 0 
        ? Math.round((this.messageValidationStats.validMessages / this.messageValidationStats.totalMessages) * 100) 
        : 0,
      errorBreakdown,
      validatorStats: this.messageValidator.getValidationStats()
    };
  }

  /**
   * Reset message validation statistics
   */
  resetMessageValidationStats() {
    this.messageValidationStats = {
      totalMessages: 0,
      validMessages: 0,
      invalidMessages: 0,
      validationErrors: new Map()
    };
    logger.info('P2P', '[MESSAGE_VALIDATION] Statistics reset');
  }

  /**
   * Update message handling to require authentication for sensitive operations
   */
  handleMessage(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    
    // Debug log for authentication messages
    if (['HANDSHAKE', 'AUTH_CHALLENGE', 'AUTH_RESPONSE', 'AUTH_SUCCESS', 'AUTH_FAILURE'].includes(message.type)) {
      logger.debug('P2P', `[AUTH] Received ${message.type} from ${peerAddress}`);
    }
    
    // Update message statistics
    this.messageValidationStats.totalMessages++;
    
    // Comprehensive message validation
    const validation = this.messageValidator.validateMessage(message, peerAddress);
    if (!validation.valid) {
      this.messageValidationStats.invalidMessages++;
      
      // Track validation errors
      const errorType = validation.error || 'unknown_error';
      const currentCount = this.messageValidationStats.validationErrors.get(errorType) || 0;
      this.messageValidationStats.validationErrors.set(errorType, currentCount + 1);
      
      logger.warn('P2P', `[MESSAGE_VALIDATION] Invalid message from ${peerAddress}: ${validation.error}`);
      if (validation.details) {
        logger.debug('P2P', `[MESSAGE_VALIDATION] Details: ${validation.details}`);
      }
      logger.debug('P2P', `[MESSAGE_VALIDATION] Invalid message content: ${JSON.stringify(message)}`);
      
      this.updatePeerReputation(peerAddress, 'invalid_message', { 
        reason: 'message_validation_failed',
        error: validation.error,
        details: validation.details
      });
      return;
    }
    
    this.messageValidationStats.validMessages++;

    // Check authentication for sensitive operations
    const sensitiveOperations = ['NEW_BLOCK', 'NEW_TRANSACTION', 'RESPONSE_BLOCKCHAIN', 'RESPONSE_TRANSACTION_POOL'];
    if (sensitiveOperations.includes(message.type) && !this.isPeerAuthenticated(peerAddress)) {
      logger.warn('P2P', `[AUTH] Unauthenticated peer ${peerAddress} attempted sensitive operation: ${message.type}`);
      this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'unauthorized_operation' });
      ws.close();
      return;
    }
    
    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      try {
        handler(ws, message);
        // Update reputation for successful message handling
        this.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'message_handled_successfully' });
      } catch (error) {
        logger.error('P2P', `[MESSAGE_HANDLER] Error handling message from ${peerAddress}: ${error.message}`);
        this.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'message_handler_error', error: error.message });
      }
    } else {
      logger.warn('P2P', `Unknown message type: ${message.type} from ${peerAddress}`);
      this.updatePeerReputation(peerAddress, 'invalid_message', { reason: 'unknown_message_type' });
    }
  }

  /**
   * Handle health status messages from peers
   */
  handleHealthStatus(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    logger.debug('P2P', `Received health status from ${peerAddress}: ${JSON.stringify(message.data)}`);
    
    // Update peer reputation for good communication
    this.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'health_status_received' });
  }

  /**
   * Handle peer list requests
   */
  handleRequestPeerList(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    logger.debug('P2P', `Peer list requested by ${peerAddress}`);
    
    // Send our peer list back
    const peerList = this.getPeerList();
    const response = {
      type: 'PEER_LIST_RESPONSE',
      data: {
        peers: peerList.map(peer => peer.url),
        timestamp: Date.now(),
        requester: message.data.requester
      }
    };
    
    this.sendMessage(ws, response);
    this.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'peer_list_provided' });
  }

  /**
   * Handle heartbeat messages
   */
  handleHeartbeat(ws, message) {
    const peerAddress = this.getPeerAddress(ws);
    logger.debug('P2P', `Heartbeat received from ${peerAddress}, sequence: ${message.data.sequence}`);
    
    // Update peer reputation for maintaining connection
    this.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'heartbeat_received' });
  }
}

module.exports = P2PNetwork; 