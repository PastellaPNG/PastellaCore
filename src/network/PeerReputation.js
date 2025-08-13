const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Peer Reputation System - Handles peer reputation tracking and banning
 */
class PeerReputation {
  constructor(dataDir = './data') {
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
    
    this.loadPeerReputation();
  }

  /**
   * Load peer reputation from file
   */
  loadPeerReputation() {
    try {
      if (fs.existsSync(this.peerReputationFile)) {
        const data = JSON.parse(fs.readFileSync(this.peerReputationFile, 'utf8'));
        this.peerReputation = new Map(data.peerReputation || []);
        logger.info('PEER_REPUTATION', `Loaded reputation data for ${this.peerReputation.size} peers`);
      }
    } catch (error) {
      logger.error('PEER_REPUTATION', `Failed to load peer reputation: ${error.message}`);
    }
  }

  /**
   * Save peer reputation to file
   */
  savePeerReputation() {
    try {
      const data = {
        peerReputation: Array.from(this.peerReputation.entries()),
        lastUpdated: Date.now()
      };
      
      // Ensure directory exists
      const dir = path.dirname(this.peerReputationFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.peerReputationFile, JSON.stringify(data, null, 2));
      logger.debug('PEER_REPUTATION', 'Peer reputation data saved');
    } catch (error) {
      logger.error('PEER_REPUTATION', `Failed to save peer reputation: ${error.message}`);
    }
  }

  /**
   * Get or create reputation data for a peer
   */
  getReputationData(peerAddress) {
    if (!this.peerReputation.has(peerAddress)) {
      this.peerReputation.set(peerAddress, {
        score: this.reputationConfig.initialScore,
        lastUpdated: Date.now(),
        behaviors: [],
        bannedUntil: null
      });
    }
    return this.peerReputation.get(peerAddress);
  }

  /**
   * Update peer reputation based on behavior
   */
  updatePeerReputation(peerAddress, behavior, details = {}) {
    const reputationData = this.getReputationData(peerAddress);
    const now = Date.now();
    
    // Apply score change based on behavior
    let scoreChange = 0;
    let behaviorType = 'neutral';
    
    switch (behavior) {
      case 'connect':
        scoreChange = this.reputationConfig.goodBehaviorBonus;
        behaviorType = 'good';
        break;
      case 'disconnect':
        scoreChange = -5; // Small penalty for disconnection
        behaviorType = 'neutral';
        break;
      case 'message_received':
        scoreChange = 1; // Small bonus for communication
        behaviorType = 'good';
        break;
      case 'good_behavior':
        scoreChange = this.reputationConfig.goodBehaviorBonus;
        behaviorType = 'good';
        break;
      case 'bad_behavior':
        scoreChange = -this.reputationConfig.badBehaviorPenalty;
        behaviorType = 'bad';
        break;
      case 'invalid_message':
        scoreChange = -20; // Penalty for invalid messages
        behaviorType = 'bad';
        break;
      default:
        scoreChange = 0;
        behaviorType = 'neutral';
    }
    
    // Update score
    reputationData.score = Math.max(
      this.reputationConfig.minScore,
      Math.min(this.reputationConfig.maxScore, reputationData.score + scoreChange)
    );
    
    // Record behavior
    reputationData.behaviors.push({
      type: behaviorType,
      behavior: behavior,
      scoreChange: scoreChange,
      details: details,
      timestamp: now
    });
    
    // Keep only last 100 behaviors to prevent memory bloat
    if (reputationData.behaviors.length > 100) {
      reputationData.behaviors = reputationData.behaviors.slice(-100);
    }
    
    reputationData.lastUpdated = now;
    
    // Check if peer should be banned
    if (reputationData.score <= this.reputationConfig.banThreshold && !reputationData.bannedUntil) {
      reputationData.bannedUntil = now + this.reputationConfig.banDuration;
      logger.warn('PEER_REPUTATION', `Peer ${peerAddress} banned due to low reputation (${reputationData.score})`);
    }
    
    // Log significant reputation changes
    if (Math.abs(scoreChange) >= 20) {
      logger.info('PEER_REPUTATION', `Peer ${peerAddress} reputation ${scoreChange > 0 ? '+' : ''}${scoreChange} (${behavior}) - New score: ${reputationData.score}`);
    }
    
    return reputationData;
  }

  /**
   * Check if peer is banned
   */
  isPeerBanned(peerAddress) {
    const reputationData = this.peerReputation.get(peerAddress);
    if (!reputationData) {
      return false;
    }
    
    if (reputationData.bannedUntil && Date.now() < reputationData.bannedUntil) {
      return true;
    }
    
    // Check if score is below ban threshold
    if (reputationData.score <= this.reputationConfig.banThreshold) {
      return true;
    }
    
    return false;
  }

  /**
   * Get peer reputation score
   */
  getPeerScore(peerAddress) {
    const reputationData = this.peerReputation.get(peerAddress);
    return reputationData ? reputationData.score : this.reputationConfig.initialScore;
  }

  /**
   * Get peer reputation data
   */
  getPeerReputation(peerAddress) {
    return this.peerReputation.get(peerAddress);
  }

  /**
   * Unban a peer
   */
  unbanPeer(peerAddress) {
    const reputationData = this.peerReputation.get(peerAddress);
    if (reputationData) {
      reputationData.bannedUntil = null;
      reputationData.score = Math.max(this.reputationConfig.initialScore, reputationData.score);
      logger.info('PEER_REPUTATION', `Peer ${peerAddress} unbanned`);
      return true;
    }
    return false;
  }

  /**
   * Ban a peer manually
   */
  banPeer(peerAddress, duration = null) {
    const reputationData = this.getReputationData(peerAddress);
    const banDuration = duration || this.reputationConfig.banDuration;
    
    reputationData.bannedUntil = Date.now() + banDuration;
    reputationData.score = this.reputationConfig.minScore;
    
    logger.warn('PEER_REPUTATION', `Peer ${peerAddress} manually banned for ${banDuration / 1000 / 60} minutes`);
    return true;
  }

  /**
   * Apply score decay to all peers
   */
  applyScoreDecay() {
    const now = Date.now();
    const hoursSinceLastDecay = (now - this.reputationConfig.lastDecayTime) / (1000 * 60 * 60);
    
    if (hoursSinceLastDecay < 1) {
      return; // Only decay once per hour
    }
    
    let decayedCount = 0;
    for (const [peerAddress, reputationData] of this.peerReputation.entries()) {
      // Apply decay to scores above initial
      if (reputationData.score > this.reputationConfig.initialScore) {
        const decayFactor = Math.pow(this.reputationConfig.scoreDecayRate, hoursSinceLastDecay);
        reputationData.score = Math.max(
          this.reputationConfig.initialScore,
          Math.floor(reputationData.score * decayFactor)
        );
        decayedCount++;
      }
    }
    
    if (decayedCount > 0) {
      logger.debug('PEER_REPUTATION', `Applied score decay to ${decayedCount} peers`);
    }
    
    this.reputationConfig.lastDecayTime = now;
  }

  /**
   * Get reputation statistics
   */
  getReputationStats() {
    const stats = {
      totalPeers: this.peerReputation.size,
      bannedPeers: 0,
      goodPeers: 0,
      neutralPeers: 0,
      badPeers: 0,
      averageScore: 0
    };
    
    let totalScore = 0;
    
    for (const reputationData of this.peerReputation.values()) {
      totalScore += reputationData.score;
      
      if (this.isPeerBanned(reputationData)) {
        stats.bannedPeers++;
      } else if (reputationData.score > 150) {
        stats.goodPeers++;
      } else if (reputationData.score < 50) {
        stats.badPeers++;
      } else {
        stats.neutralPeers++;
      }
    }
    
    stats.averageScore = this.peerReputation.size > 0 ? Math.round(totalScore / this.peerReputation.size) : 0;
    
    return stats;
  }

  /**
   * Clean up old reputation data
   */
  cleanupOldData(maxAge = 30 * 24 * 60 * 60 * 1000) { // 30 days
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [peerAddress, reputationData] of this.peerReputation.entries()) {
      if (now - reputationData.lastUpdated > maxAge) {
        this.peerReputation.delete(peerAddress);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.info('PEER_REPUTATION', `Cleaned up ${cleanedCount} old peer reputation records`);
    }
    
    return cleanedCount;
  }

  /**
   * Reset reputation for a peer
   */
  resetPeerReputation(peerAddress) {
    this.peerReputation.delete(peerAddress);
    logger.info('PEER_REPUTATION', `Reputation reset for peer: ${peerAddress}`);
  }

  /**
   * Get all banned peers
   */
  getBannedPeers() {
    const banned = [];
    for (const [peerAddress, reputationData] of this.peerReputation.entries()) {
      if (this.isPeerBanned(peerAddress)) {
        banned.push({
          address: peerAddress,
          score: reputationData.score,
          bannedUntil: reputationData.bannedUntil,
          lastUpdated: reputationData.lastUpdated
        });
      }
    }
    return banned;
  }
}

module.exports = PeerReputation;
