const WebSocket = require('ws');
const logger = require('../utils/logger');

/**
 * Peer Manager - Handles all peer connection management
 */
class PeerManager {
  constructor(maxPeers = 10) {
    this.peers = new Set();
    this.maxPeers = maxPeers;
    this.peerAddresses = new Map(); // Map<WebSocket, string> for address tracking
  }

  /**
   * Add a new peer connection
   */
  addPeer(ws, peerAddress) {
    if (this.peers.size >= this.maxPeers) {
      logger.warn('PEER_MANAGER', `Max peers reached (${this.maxPeers}), rejecting connection`);
      return false;
    }

    this.peers.add(ws);
    this.peerAddresses.set(ws, peerAddress);
    logger.info('PEER_MANAGER', `Peer added: ${peerAddress} (${this.peers.size}/${this.maxPeers})`);
    return true;
  }

  /**
   * Remove a peer connection
   */
  removePeer(ws) {
    const peerAddress = this.peerAddresses.get(ws);
    this.peers.delete(ws);
    this.peerAddresses.delete(ws);
    
    if (peerAddress) {
      logger.info('PEER_MANAGER', `Peer removed: ${peerAddress} (${this.peers.size}/${this.maxPeers})`);
      return peerAddress;
    }
    return null;
  }

  /**
   * Get peer address from WebSocket
   */
  getPeerAddress(ws) {
    return this.peerAddresses.get(ws) || 'unknown';
  }

  /**
   * Check if peer exists
   */
  hasPeer(ws) {
    return this.peers.has(ws);
  }

  /**
   * Get current peer count
   */
  getPeerCount() {
    return this.peers.size;
  }

  /**
   * Get all peers
   */
  getAllPeers() {
    return Array.from(this.peers);
  }

  /**
   * Get peer list for network sharing
   */
  getPeerList() {
    return Array.from(this.peerAddresses.values()).map(address => ({
      url: `ws://${address}`,
      address: address
    }));
  }

  /**
   * Check if we can accept more peers
   */
  canAcceptPeers() {
    return this.peers.size < this.maxPeers;
  }

  /**
   * Get peer addresses
   */
  getPeerAddresses() {
    return Array.from(this.peerAddresses.values());
  }

  /**
   * Clear all peers
   */
  clearPeers() {
    this.peers.clear();
    this.peerAddresses.clear();
    logger.info('PEER_MANAGER', 'All peers cleared');
  }

  /**
   * Set maximum peer limit
   */
  setMaxPeers(maxPeers) {
    this.maxPeers = maxPeers;
    logger.info('PEER_MANAGER', `Max peers set to: ${maxPeers}`);
  }

  /**
   * Get peer statistics
   */
  getPeerStats() {
    return {
      currentPeers: this.peers.size,
      maxPeers: this.maxPeers,
      availableSlots: this.maxPeers - this.peers.size,
      peerAddresses: this.getPeerAddresses()
    };
  }
}

module.exports = PeerManager;
