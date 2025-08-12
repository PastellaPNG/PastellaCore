const logger = require('../utils/logger');

class NetworkPartitionHandler {
  constructor(p2pNetwork) {
    this.p2pNetwork = p2pNetwork;
    this.partitionDetectionEnabled = true;
    this.partitionStats = {
      totalPartitions: 0,
      currentPartitions: 0,
      lastPartitionTime: null,
      partitionDuration: 0,
      recoveryAttempts: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0
    };
    
    // Partition detection configuration
    this.config = {
      healthCheckInterval: 30000, // 30 seconds
      partitionThreshold: 0.5, // 50% of peers disconnected = partition
      recoveryTimeout: 120000, // 2 minutes
      maxRecoveryAttempts: 5,
      heartbeatInterval: 15000, // 15 seconds
      connectionTimeout: 10000 // 10 seconds
    };
    
    // Partition state tracking
    this.partitionState = {
      isPartitioned: false,
      partitionStartTime: null,
      disconnectedPeers: new Set(),
      partitionGroups: new Map(), // Map<partitionId, Set<peerAddress>>
      recoveryInProgress: false,
      lastHealthCheck: Date.now()
    };
    
    // Health check intervals
    this.healthCheckInterval = null;
    this.heartbeatInterval = null;
    
    // Recovery strategies
    this.recoveryStrategies = [
      'reconnect_seed_nodes',
      'broadcast_health_status',
      'request_peer_list',
      'force_sync'
    ];
  }

  /**
   * Start partition detection and handling
   */
  start() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckInterval);

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);

    logger.info('P2P', 'Network partition handling started');
  }

  /**
   * Stop partition detection and handling
   */
  stop() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    logger.info('P2P', 'Network partition handling stopped');
  }

  /**
   * Perform network health check
   */
  performHealthCheck() {
    const now = Date.now();
    const totalPeers = this.p2pNetwork.peers.size;
    const connectedPeers = this.getConnectedPeerCount();
    const connectionRatio = totalPeers > 0 ? connectedPeers / totalPeers : 1;

    this.partitionState.lastHealthCheck = now;

    // Check for partition conditions
    if (connectionRatio < this.config.partitionThreshold && totalPeers > 0) {
      this.detectPartition(connectedPeers, totalPeers);
    } else if (this.partitionState.isPartitioned) {
      this.resolvePartition();
    }

    // Update partition duration if currently partitioned
    if (this.partitionState.isPartitioned && this.partitionState.partitionStartTime) {
      this.partitionStats.partitionDuration = now - this.partitionState.partitionStartTime;
    }

    logger.debug('P2P', `Health check: ${connectedPeers}/${totalPeers} peers connected (${Math.round(connectionRatio * 100)}%)`);
  }

  /**
   * Get count of connected peers
   */
  getConnectedPeerCount() {
    let connectedCount = 0;
    this.p2pNetwork.peers.forEach(peer => {
      if (peer.readyState === 1) { // WebSocket.OPEN
        connectedCount++;
      }
    });
    return connectedCount;
  }

  /**
   * Detect network partition
   */
  detectPartition(connectedPeers, totalPeers) {
    if (this.partitionState.isPartitioned) {
      return; // Already partitioned
    }

    this.partitionState.isPartitioned = true;
    this.partitionState.partitionStartTime = Date.now();
    this.partitionStats.totalPartitions++;
    this.partitionStats.currentPartitions++;

    // Identify disconnected peers
    this.identifyDisconnectedPeers();

    // Log partition detection
    logger.warn('P2P', `Network partition detected: ${connectedPeers}/${totalPeers} peers connected`);
    logger.warn('P2P', `Disconnected peers: ${this.partitionState.disconnectedPeers.size}`);

    // Start recovery process
    this.startRecovery();
  }

  /**
   * Identify which peers are disconnected
   */
  identifyDisconnectedPeers() {
    this.partitionState.disconnectedPeers.clear();
    
    this.p2pNetwork.peers.forEach(peer => {
      if (peer.readyState !== 1) { // Not WebSocket.OPEN
        const peerAddress = this.p2pNetwork.getPeerAddress(peer);
        if (peerAddress) {
          this.partitionState.disconnectedPeers.add(peerAddress);
        }
      }
    });
  }

  /**
   * Start partition recovery process
   */
  async startRecovery() {
    if (this.partitionState.recoveryInProgress) {
      return;
    }

    this.partitionState.recoveryInProgress = true;
    this.partitionStats.recoveryAttempts++;

    logger.info('P2P', 'Starting network partition recovery...');

    try {
      // Try recovery strategies in order
      for (const strategy of this.recoveryStrategies) {
        const success = await this.executeRecoveryStrategy(strategy);
        if (success) {
          logger.info('P2P', `Recovery strategy '${strategy}' successful`);
          this.partitionStats.successfulRecoveries++;
          break;
        }
      }

      // If all strategies fail, schedule retry
      if (this.partitionState.isPartitioned && this.partitionStats.recoveryAttempts < this.config.maxRecoveryAttempts) {
        setTimeout(() => {
          this.partitionState.recoveryInProgress = false;
          this.startRecovery();
        }, this.config.recoveryTimeout);
      } else if (this.partitionState.isPartitioned) {
        this.partitionStats.failedRecoveries++;
        logger.error('P2P', 'All recovery strategies failed, network remains partitioned');
      }

    } catch (error) {
      logger.error('P2P', `Recovery error: ${error.message}`);
      this.partitionStats.failedRecoveries++;
    } finally {
      this.partitionState.recoveryInProgress = false;
    }
  }

  /**
   * Execute a specific recovery strategy
   */
  async executeRecoveryStrategy(strategy) {
    try {
      switch (strategy) {
        case 'reconnect_seed_nodes':
          return await this.reconnectSeedNodes();
        case 'broadcast_health_status':
          return await this.broadcastHealthStatus();
        case 'request_peer_list':
          return await this.requestPeerList();
        case 'force_sync':
          return await this.forceSync();
        default:
          return false;
      }
    } catch (error) {
      logger.error('P2P', `Recovery strategy '${strategy}' failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Reconnect to seed nodes
   */
  async reconnectSeedNodes() {
    logger.info('P2P', 'Attempting to reconnect to seed nodes...');
    
    const originalSeedCount = this.p2pNetwork.connectedSeedNodes;
    await this.p2pNetwork.connectToSeedNodes();
    
    // Check if we gained new seed connections
    const newSeedCount = this.p2pNetwork.connectedSeedNodes;
    const improvement = newSeedCount > originalSeedCount;
    
    if (improvement) {
      logger.info('P2P', `Seed node reconnection successful: ${originalSeedCount} → ${newSeedCount}`);
    }
    
    return improvement;
  }

  /**
   * Broadcast health status to connected peers
   */
  async broadcastHealthStatus() {
    logger.info('P2P', 'Broadcasting health status to peers...');
    
    const healthMessage = {
      type: 'HEALTH_STATUS',
      data: {
        nodeId: this.p2pNetwork.nodeIdentity.nodeId,
        timestamp: Date.now(),
        peerCount: this.p2pNetwork.peers.size,
        connectedCount: this.getConnectedPeerCount(),
        isPartitioned: this.partitionState.isPartitioned,
        blockchainHeight: this.p2pNetwork.blockchain.getLatestBlock().index
      }
    };

    this.p2pNetwork.broadcast(healthMessage);
    return true; // Consider it successful if we can broadcast
  }

  /**
   * Request peer list from connected peers
   */
  async requestPeerList() {
    logger.info('P2P', 'Requesting peer lists from connected peers...');
    
    const peerListMessage = {
      type: 'REQUEST_PEER_LIST',
      data: {
        timestamp: Date.now(),
        requester: this.p2pNetwork.nodeIdentity.nodeId
      }
    };

    this.p2pNetwork.broadcast(peerListMessage);
    return true;
  }

  /**
   * Force blockchain synchronization
   */
  async forceSync() {
    logger.info('P2P', 'Forcing blockchain synchronization...');
    
    try {
      await this.p2pNetwork.syncBlockchain();
      await this.p2pNetwork.syncTransactionPool();
      return true;
    } catch (error) {
      logger.error('P2P', `Force sync failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Resolve partition when network connectivity is restored
   */
  resolvePartition() {
    if (!this.partitionState.isPartitioned) {
      return;
    }

    const partitionDuration = Date.now() - this.partitionState.partitionStartTime;
    
    this.partitionState.isPartitioned = false;
    this.partitionState.partitionStartTime = null;
    this.partitionState.disconnectedPeers.clear();
    this.partitionState.recoveryInProgress = false;
    this.partitionStats.currentPartitions--;

    logger.info('P2P', `Network partition resolved after ${Math.round(partitionDuration / 1000)}s`);
    logger.info('P2P', `Total partitions: ${this.partitionStats.totalPartitions}, Current: ${this.partitionStats.currentPartitions}`);
  }

  /**
   * Send heartbeat to connected peers
   */
  sendHeartbeat() {
    if (this.p2pNetwork.peers.size === 0) {
      return;
    }

    const heartbeatMessage = {
      type: 'HEARTBEAT',
      data: {
        nodeId: this.p2pNetwork.nodeIdentity.nodeId,
        timestamp: Date.now(),
        sequence: Math.floor(Date.now() / this.config.heartbeatInterval)
      }
    };

    this.p2pNetwork.broadcast(heartbeatMessage);
  }

  /**
   * Handle peer disconnection
   */
  handlePeerDisconnection(peerAddress) {
    if (this.partitionState.isPartitioned) {
      this.partitionState.disconnectedPeers.add(peerAddress);
      logger.debug('P2P', `Peer disconnected during partition: ${peerAddress}`);
    }
  }

  /**
   * Handle peer reconnection
   */
  handlePeerReconnection(peerAddress) {
    if (this.partitionState.disconnectedPeers.has(peerAddress)) {
      this.partitionState.disconnectedPeers.delete(peerAddress);
      logger.debug('P2P', `Peer reconnected: ${peerAddress}`);
      
      // Check if partition is resolved
      if (this.partitionState.disconnectedPeers.size === 0 && this.partitionState.isPartitioned) {
        this.resolvePartition();
      }
    }
  }

  /**
   * Get partition statistics
   */
  getPartitionStats() {
    return {
      ...this.partitionStats,
      isPartitioned: this.partitionState.isPartitioned,
      partitionDuration: this.partitionState.isPartitioned && this.partitionState.partitionStartTime 
        ? Date.now() - this.partitionState.partitionStartTime 
        : 0,
      disconnectedPeers: this.partitionState.disconnectedPeers.size,
      recoveryInProgress: this.partitionState.recoveryInProgress,
      lastHealthCheck: this.partitionState.lastHealthCheck
    };
  }

  /**
   * Reset partition statistics
   */
  resetPartitionStats() {
    this.partitionStats = {
      totalPartitions: 0,
      currentPartitions: 0,
      lastPartitionTime: null,
      partitionDuration: 0,
      recoveryAttempts: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0
    };
    
    this.partitionState = {
      isPartitioned: false,
      partitionStartTime: null,
      disconnectedPeers: new Set(),
      partitionGroups: new Map(),
      recoveryInProgress: false,
      lastHealthCheck: Date.now()
    };
    
    logger.info('P2P', 'Partition statistics reset');
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    logger.info('P2P', 'Partition handler configuration updated');
  }

  /**
   * Get current partition state
   */
  getPartitionState() {
    return {
      ...this.partitionState,
      config: this.config,
      stats: this.partitionStats
    };
  }
}

module.exports = NetworkPartitionHandler;

