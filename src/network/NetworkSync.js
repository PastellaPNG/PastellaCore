const logger = require('../utils/logger');

/**
 * Network Synchronization - Handles network synchronization and peer discovery
 */
class NetworkSync {
  constructor(blockchain, peerManager, seedNodeManager) {
    this.blockchain = blockchain;
    this.peerManager = peerManager;
    this.seedNodeManager = seedNodeManager;
    this.networkSyncStatus = {
      isSyncing: false,
      lastSyncTime: null,
      syncAttempts: 0,
      maxSyncAttempts: 5,
    };
    this.periodicSyncInterval = null;
  }

  /**
   * Start network synchronization
   */
  async syncWithNetwork() {
    if (this.networkSyncStatus.isSyncing) {
      logger.debug('NETWORK_SYNC', 'Network sync already in progress');
      return false;
    }

    this.networkSyncStatus.isSyncing = true;
    this.networkSyncStatus.syncAttempts++;

    try {
      logger.info('NETWORK_SYNC', 'Starting network synchronization...');

      // Query latest block from all peers
      const peers = this.peerManager.getAllPeers();
      if (peers.length === 0) {
        logger.warn('NETWORK_SYNC', 'No peers available for synchronization');
        this.networkSyncStatus.isSyncing = false;
        return false;
      }

      // Send query to all peers
      for (const peer of peers) {
        try {
          this.sendMessage(peer, { type: 'QUERY_LATEST' });
        } catch (error) {
          logger.debug('NETWORK_SYNC', `Failed to query peer: ${error.message}`);
        }
      }

      // Wait a bit for responses
      await new Promise(resolve => setTimeout(resolve, 2000));

      this.networkSyncStatus.lastSyncTime = Date.now();
      logger.info('NETWORK_SYNC', 'Network synchronization completed');

      return true;
    } catch (error) {
      logger.error('NETWORK_SYNC', `Network synchronization failed: ${error.message}`);
      return false;
    } finally {
      this.networkSyncStatus.isSyncing = false;
    }
  }

  /**
   * Start periodic network synchronization
   */
  startPeriodicSync(intervalMs = 30000) {
    // 30 seconds default
    if (this.periodicSyncInterval) {
      clearInterval(this.periodicSyncInterval);
    }

    this.periodicSyncInterval = setInterval(async () => {
      if (this.peerManager.getPeerCount() > 0) {
        await this.syncWithNetwork();
      }
    }, intervalMs);

    logger.info('NETWORK_SYNC', `Periodic network sync started (every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop periodic network synchronization
   */
  stopPeriodicSync() {
    if (this.periodicSyncInterval) {
      clearInterval(this.periodicSyncInterval);
      this.periodicSyncInterval = null;
      logger.info('NETWORK_SYNC', 'Periodic network sync stopped');
    }
  }

  /**
   * Connect to seed nodes with minimum connection requirement
   */
  async connectToSeedNodes(connectToPeerFunction) {
    if (this.seedNodeManager.minSeedConnections === 0) {
      logger.info('NETWORK_SYNC', 'P2P Network: Standalone mode (no seed connections required)');
      return 0;
    }

    logger.info('NETWORK_SYNC', 'P2P Network: Attempting to connect to seed nodes...');

    const filteredSeedNodes = this.seedNodeManager.getFilteredSeedNodes();

    if (filteredSeedNodes.length === 0) {
      logger.info('NETWORK_SYNC', 'P2P Network: No external seed nodes available');
      this.seedNodeManager.minSeedConnections = 0;
      return 0;
    }

    // Initialize seed node connection tracking
    this.seedNodeManager.initializeConnectionTracking();

    const connectionPromises = filteredSeedNodes.map(async seedNode => {
      try {
        const url = new URL(seedNode);
        const connected = await connectToPeerFunction(url.hostname, url.port);
        if (connected) {
          this.seedNodeManager.markSeedNodeConnected(seedNode);
          return true;
        } else if (connected === null) {
          // Already connected, mark as connected
          this.seedNodeManager.markSeedNodeConnected(seedNode);
          return true;
        } else {
          this.seedNodeManager.markSeedNodeAttempt(seedNode, false);
          return false;
        }
      } catch (error) {
        this.seedNodeManager.markSeedNodeAttempt(seedNode, false);
        return false; // Fail silently
      }
    });

    const results = await Promise.all(connectionPromises);
    const successfulConnections = results.filter(result => result).length;

    if (successfulConnections >= this.seedNodeManager.minSeedConnections) {
      logger.info('NETWORK_SYNC', `P2P Network: Connected to ${successfulConnections} seed nodes`);
    } else if (this.seedNodeManager.minSeedConnections > 0) {
      logger.info(
        'NETWORK_SYNC',
        `P2P Network: Standalone mode (${successfulConnections}/${this.seedNodeManager.minSeedConnections} seed connections)`
      );
    }

    return successfulConnections;
  }

  /**
   * Broadcast new block to all peers
   */
  broadcastNewBlock(block) {
    const peers = this.peerManager.getAllPeers();
    if (peers.length === 0) {
      logger.debug('NETWORK_SYNC', 'No peers to broadcast new block to');
      return 0;
    }

    const message = {
      type: 'NEW_BLOCK',
      data: block,
    };

    let broadcastCount = 0;
    for (const peer of peers) {
      try {
        if (this.sendMessage(peer, message)) {
          broadcastCount++;
        }
      } catch (error) {
        logger.debug('NETWORK_SYNC', `Failed to broadcast block to peer: ${error.message}`);
      }
    }

    logger.info('NETWORK_SYNC', `New block broadcasted to ${broadcastCount}/${peers.length} peers`);
    return broadcastCount;
  }

  /**
   * Broadcast new transaction to all peers
   */
  broadcastNewTransaction(transaction) {
    const peers = this.peerManager.getAllPeers();
    if (peers.length === 0) {
      logger.debug('NETWORK_SYNC', 'No peers to broadcast new transaction to');
      return 0;
    }

    const message = {
      type: 'NEW_TRANSACTION',
      data: transaction,
    };

    let broadcastCount = 0;
    for (const peer of peers) {
      try {
        if (this.sendMessage(peer, message)) {
          broadcastCount++;
        }
      } catch (error) {
        logger.debug('NETWORK_SYNC', `Failed to broadcast transaction to peer: ${error.message}`);
      }
    }

    logger.debug('NETWORK_SYNC', `New transaction broadcasted to ${broadcastCount}/${peers.length} peers`);
    return broadcastCount;
  }

  /**
   * Send message to peer
   */
  sendMessage(peer, message) {
    try {
      if (peer.readyState === 1) {
        // WebSocket.OPEN
        peer.send(JSON.stringify(message));
        return true;
      }
    } catch (error) {
      logger.error('NETWORK_SYNC', `Failed to send message: ${error.message}`);
    }
    return false;
  }

  /**
   * Get network sync status
   */
  getNetworkSyncStatus() {
    return {
      ...this.networkSyncStatus,
      peerCount: this.peerManager.getPeerCount(),
      seedNodeStatus: this.seedNodeManager.getSeedNodeStatus(),
      periodicSyncActive: !!this.periodicSyncInterval,
    };
  }

  /**
   * Check if network is synced
   */
  isNetworkSynced() {
    return this.peerManager.getPeerCount() > 0 && !this.networkSyncStatus.isSyncing;
  }

  /**
   * Reset sync status
   */
  resetSyncStatus() {
    this.networkSyncStatus = {
      isSyncing: false,
      lastSyncTime: null,
      syncAttempts: 0,
      maxSyncAttempts: 5,
    };
    logger.info('NETWORK_SYNC', 'Network sync status reset');
  }

  /**
   * Get sync statistics
   */
  getSyncStats() {
    return {
      totalSyncAttempts: this.networkSyncStatus.syncAttempts,
      lastSyncTime: this.networkSyncStatus.lastSyncTime,
      isCurrentlySyncing: this.networkSyncStatus.isSyncing,
      peerCount: this.peerManager.getPeerCount(),
      seedNodeConnections: this.seedNodeManager.connectedSeedNodes,
      periodicSyncActive: !!this.periodicSyncInterval,
    };
  }
}

module.exports = NetworkSync;
