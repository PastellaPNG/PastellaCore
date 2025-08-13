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
const NetworkPartitionHandler = require('./NetworkPartitionHandler');

// Import modular components
const PeerManager = require('./PeerManager');
const SeedNodeManager = require('./SeedNodeManager');
const PeerReputation = require('./PeerReputation');
const MessageHandler = require('./MessageHandler');
const NetworkSync = require('./NetworkSync');

// Promisify DNS functions
const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve = promisify(dns.resolve);

/**
 * MODULAR & SECURE P2P NETWORK CLASS
 * 
 * This class now orchestrates specialized modules:
 * - PeerManager: Handles all peer connection management
 * - SeedNodeManager: Manages seed node connections and reconnection
 * - PeerReputation: Handles peer reputation and banning
 * - MessageHandler: Manages message processing and routing
 * - NetworkSync: Handles network synchronization and peer discovery
 * 
 * BENEFITS:
 * - Better code organization and maintainability
 * - Easier testing and debugging
 * - Clear separation of concerns
 * - Reduced file size and complexity
 */
class P2PNetwork {
  constructor(blockchain, port = 3001, config = null) {
    this.blockchain = blockchain;
    this.port = port;
    this.wss = null;
    this.isRunning = false;
    this.config = config;
    
    // Get data directory from config
    const dataDir = config?.storage?.dataDir || './data';
    
    // Initialize modular components
    this.peerManager = new PeerManager(config?.network?.maxPeers || 10);
    this.seedNodeManager = new SeedNodeManager(config, port);
    this.peerReputation = new PeerReputation(dataDir);
    this.messageHandler = new MessageHandler(blockchain, this.peerReputation);
    this.networkSync = new NetworkSync(blockchain, this.peerManager, this.seedNodeManager);
    
    // Node identity and authentication system
    this.nodeIdentity = new NodeIdentity(null, null, dataDir);
    this.authenticatedPeers = new Map(); // Map<peerAddress, {nodeId, publicKey, authenticatedAt}>
    this.pendingChallenges = new Map(); // Map<peerAddress, {challenge, timestamp, nodeId}>
    this.initiatedAuthentication = new Set(); // Set<peerAddress> - track which peers we've initiated auth with
    this.authenticationTimeout = 10000; // 10 seconds for authentication
    
    // Network partition handling system
    this.partitionHandler = new NetworkPartitionHandler(this);
    
    // Force IPv4-only DNS resolution
    this.setupIPv4OnlyDNS();
    this.loadSeedNodes();
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
      this.seedNodeManager.loadSeedNodes(this.config);
    }
  }

  /**
   * Setup seed node configuration
   */
  setupSeedNode(seedConfig) {
    this.seedNodeManager.setupSeedNode(seedConfig);
    this.peerManager.setMaxPeers(seedConfig.maxConnections || 50);
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
    if (!this.seedNodeManager.isSeedNode && this.seedNodeManager.seedNodes.length > 0) {
      try {
        await this.networkSync.connectToSeedNodes(this.connectToPeer.bind(this));
        // Wait for authentication to complete before syncing
        logger.info('P2P', 'Waiting for authentication to complete before network sync...');
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds for authentication
        // Start network synchronization after successful seed node connections
        await this.networkSync.syncWithNetwork();
      } catch (error) {
        console.error(`❌ Failed to establish network connectivity: ${error.message}`);
        throw error;
      }
    }
    
    return true;
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

    // Stop seed node reconnection
    this.seedNodeManager.stopSeedNodeReconnection();

    // Stop periodic sync
    this.networkSync.stopPeriodicSync();

    // Save reputation data before stopping
    this.peerReputation.savePeerReputation();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.peerManager.clearPeers();
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
    if (this.peerReputation.isPeerBanned(peerAddress)) {
      logger.warn('P2P', `[REPUTATION] Rejecting banned peer: ${peerAddress}`);
      ws.close();
      return;
    }
    
    // Check if we can accept more peers
    if (!this.peerManager.canAcceptPeers()) {
      logger.warn('P2P', `Max peers reached (${this.peerManager.maxPeers}), rejecting connection`);
      this.peerReputation.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'max_peers_reached' });
      ws.close();
      return;
    }

    // Update reputation for successful connection
    this.peerReputation.updatePeerReputation(peerAddress, 'connect');
    
    // Add peer to manager
    if (!this.peerManager.addPeer(ws, peerAddress)) {
      ws.close();
      return;
    }

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        
        // Update reputation for message received
        this.peerReputation.updatePeerReputation(peerAddress, 'message_received');
        
        // Handle message through message handler
        this.messageHandler.handleMessage(ws, message, peerAddress, this.isPeerAuthenticated(peerAddress));
      } catch (error) {
        logger.error('P2P', `Error parsing message: ${error.message}`);
        this.peerReputation.updatePeerReputation(peerAddress, 'invalid_message', { reason: 'json_parse_error' });
      }
    });

    ws.on('close', () => {
      // Update reputation for disconnect
      this.peerReputation.updatePeerReputation(peerAddress, 'disconnect');
      
      // Clean up authentication data
      this.authenticatedPeers.delete(peerAddress);
      this.pendingChallenges.delete(peerAddress);
      this.initiatedAuthentication.delete(peerAddress);
      
      // Check if this was a seed node connection
      const wasSeedNode = this.seedNodeManager.markSeedNodeAsDisconnected(peerAddress);
      
      // Remove peer from manager
      this.peerManager.removePeer(ws);
      
      if (wasSeedNode) {
        logger.info('P2P', `Seed node disconnected: ${peerAddress}`);
      } else {
        // Notify partition handler of peer disconnection
        this.partitionHandler.handlePeerDisconnection(peerAddress);
      }
      logger.info('P2P', `Peer disconnected: ${peerAddress}`);
    });

    ws.on('error', (error) => {
      logger.error('P2P', `WebSocket error from ${peerAddress}: ${error.message}`);
      this.peerReputation.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'websocket_error' });
      this.authenticatedPeers.delete(peerAddress);
      this.pendingChallenges.delete(peerAddress);
      this.initiatedAuthentication.delete(peerAddress);
    });
  }

  /**
   * Get peer address from WebSocket
   */
  getPeerAddress(ws) {
    return this.peerManager.getPeerAddress(ws);
  }

  /**
   * Connect to a peer
   */
  async connectToPeer(host, port) {
    const peerAddress = `${host}:${port}`;
    
    // Check if already connected
    if (this.peerManager.getPeerAddresses().includes(peerAddress)) {
      return null; // Already connected
    }
    
    try {
      const ws = new WebSocket(`ws://${host}:${port}`);
      
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          ws.terminate();
          resolve(false);
        }, 5000);
        
        ws.on('open', () => {
          clearTimeout(timeout);
          this.handleConnection(ws);
          resolve(true);
        });
        
        ws.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });
    } catch (error) {
      logger.error('P2P', `Failed to connect to peer ${peerAddress}: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if peer is authenticated
   */
  isPeerAuthenticated(peerAddress) {
    return this.authenticatedPeers.has(peerAddress);
  }

  /**
   * Start reputation maintenance
   */
  startReputationMaintenance() {
    // Apply score decay every hour
    setInterval(() => {
      this.peerReputation.applyScoreDecay();
    }, 60 * 60 * 1000);
    
    // Save reputation data every 5 minutes
    setInterval(() => {
      this.peerReputation.savePeerReputation();
    }, 5 * 60 * 1000);
    
    // Clean up old data every day
    setInterval(() => {
      this.peerReputation.cleanupOldData();
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * Stop reputation maintenance
   */
  stopReputationMaintenance() {
    // Save reputation data before stopping
    this.peerReputation.savePeerReputation();
  }

  /**
   * Get network status
   */
  getNetworkStatus() {
    return {
      isRunning: this.isRunning,
      port: this.port,
      peerCount: this.peerManager.getPeerCount(),
      maxPeers: this.peerManager.maxPeers,
      seedNodeConnections: this.seedNodeManager.getSeedNodeStatus(),
      networkSync: this.networkSync.getNetworkSyncStatus(),
      nodeIdentity: this.nodeIdentity.getIdentityInfo()
    };
  }

  /**
   * CRITICAL: Get reputation status for API
   */
  getReputationStatus() {
    try {
      return this.peerReputation.getReputationStatus();
    } catch (error) {
      logger.error('P2P_NETWORK', `Failed to get reputation status: ${error.message}`);
      return { error: 'Failed to get reputation status' };
    }
  }

  /**
   * CRITICAL: Get reputation statistics for API
   */
  getReputationStats() {
    try {
      return this.peerReputation.getReputationStats();
    } catch (error) {
      logger.error('P2P_NETWORK', `Failed to get reputation stats: ${error.message}`);
      return { error: 'Failed to get reputation stats' };
    }
  }

  /**
   * Broadcast new block to all peers
   */
  broadcastNewBlock(block) {
    return this.networkSync.broadcastNewBlock(block);
  }

  /**
   * Broadcast new transaction to all peers
   */
  broadcastNewTransaction(transaction) {
    return this.networkSync.broadcastNewTransaction(transaction);
  }

  /**
   * Get peer list
   */
  getPeerList() {
    return this.peerManager.getPeerList();
  }

  /**
   * Get peer count
   */
  getPeerCount() {
    return this.peerManager.getPeerCount();
  }

  /**
   * Get all peers
   */
  getAllPeers() {
    return this.peerManager.getAllPeers();
  }

  /**
   * Check if peer exists
   */
  hasPeer(ws) {
    return this.peerManager.hasPeer(ws);
  }

  /**
   * Get peer reputation
   */
  getPeerReputation(peerAddress) {
    return this.peerReputation.getPeerReputation(peerAddress);
  }

  /**
   * Get peer score
   */
  getPeerScore(peerAddress) {
    return this.peerReputation.getPeerScore(peerAddress);
  }

  /**
   * Ban peer
   */
  banPeer(peerAddress, duration = null) {
    return this.peerReputation.banPeer(peerAddress, duration);
  }

  /**
   * Unban peer
   */
  unbanPeer(peerAddress) {
    return this.peerReputation.unbanPeer(peerAddress);
  }

  /**
   * Reset peer reputation
   */
  resetPeerReputation(peerAddress) {
    return this.peerReputation.resetPeerReputation(peerAddress);
  }

  /**
   * Get banned peers
   */
  getBannedPeers() {
    return this.peerReputation.getBannedPeers();
  }

  /**
   * Start periodic sync
   */
  startPeriodicSync(intervalMs = 30000) {
    this.networkSync.startPeriodicSync(intervalMs);
  }

  /**
   * Stop periodic sync
   */
  stopPeriodicSync() {
    this.networkSync.stopPeriodicSync();
  }

  /**
   * Sync with network
   */
  async syncWithNetwork() {
    return await this.networkSync.syncWithNetwork();
  }

  /**
   * Get sync stats
   */
  getSyncStats() {
    return this.networkSync.getSyncStats();
  }

  /**
   * Check if network is synced
   */
  isNetworkSynced() {
    return this.networkSync.isNetworkSynced();
  }

  /**
   * Reset sync status
   */
  resetSyncStatus() {
    this.networkSync.resetSyncStatus();
  }

  /**
   * Get message validation stats
   */
  getMessageValidationStats() {
    return this.messageHandler.getMessageValidationStats();
  }

  /**
   * Reset message validation stats
   */
  resetMessageValidationStats() {
    this.messageHandler.resetMessageValidationStats();
  }
}

module.exports = P2PNetwork; 