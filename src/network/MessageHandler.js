const logger = require('../utils/logger');
const MessageValidator = require('../utils/MessageValidator');

/**
 * Message Handler - Handles all message processing and routing
 */
class MessageHandler {
  constructor(blockchain, peerReputation) {
    this.blockchain = blockchain;
    this.peerReputation = peerReputation;
    this.messageHandlers = new Map();
    this.messageValidator = new MessageValidator();
    this.messageValidationStats = {
      totalMessages: 0,
      validMessages: 0,
      invalidMessages: 0,
      validationErrors: new Map() // Map<errorType, count>
    };
    
    this.setupMessageHandlers();
  }

  /**
   * Setup message handlers
   */
  setupMessageHandlers() {
    // Core blockchain message handlers
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
   * Handle incoming message
   */
  handleMessage(ws, message, peerAddress, isPeerAuthenticated) {
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
      
      logger.warn('MESSAGE_HANDLER', `[MESSAGE_VALIDATION] Invalid message from ${peerAddress}: ${validation.error}`);
      if (validation.details) {
        logger.debug('MESSAGE_HANDLER', `[MESSAGE_VALIDATION] Details: ${validation.details}`);
      }
      logger.debug('MESSAGE_HANDLER', `[MESSAGE_VALIDATION] Invalid message content: ${JSON.stringify(message)}`);
      
      this.peerReputation.updatePeerReputation(peerAddress, 'invalid_message', { 
        reason: 'message_validation_failed',
        error: validation.error,
        details: validation.details
      });
      return false;
    }
    
    this.messageValidationStats.validMessages++;

    // Check authentication for sensitive operations
    const sensitiveOperations = ['NEW_BLOCK', 'NEW_TRANSACTION', 'RESPONSE_BLOCKCHAIN', 'RESPONSE_TRANSACTION_POOL'];
    if (sensitiveOperations.includes(message.type) && !isPeerAuthenticated) {
      logger.warn('MESSAGE_HANDLER', `[AUTH] Unauthenticated peer ${peerAddress} attempted sensitive operation: ${message.type}`);
      this.peerReputation.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'unauthorized_operation' });
      return false;
    }
    
    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      try {
        handler(ws, message, peerAddress);
        // Update reputation for successful message handling
        this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'message_handled_successfully' });
        return true;
      } catch (error) {
        logger.error('MESSAGE_HANDLER', `[MESSAGE_HANDLER] Error handling message from ${peerAddress}: ${error.message}`);
        this.peerReputation.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'message_handler_error', error: error.message });
        return false;
      }
    } else {
      logger.warn('MESSAGE_HANDLER', `Unknown message type: ${message.type} from ${peerAddress}`);
      this.peerReputation.updatePeerReputation(peerAddress, 'invalid_message', { reason: 'unknown_message_type' });
      return false;
    }
  }

  /**
   * Handle query latest block
   */
  handleQueryLatest(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Latest block queried by ${peerAddress}`);
    const latestBlock = this.blockchain.getLatestBlock();
    const response = {
      type: 'RESPONSE_BLOCKCHAIN',
      data: [latestBlock]
    };
    this.sendMessage(ws, response);
  }

  /**
   * Handle query all blocks
   */
  handleQueryAll(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `All blocks queried by ${peerAddress}`);
    const response = {
      type: 'RESPONSE_BLOCKCHAIN',
      data: this.blockchain.chain
    };
    this.sendMessage(ws, response);
  }

  /**
   * Handle blockchain response
   */
  handleResponseBlockchain(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Blockchain response received from ${peerAddress} with ${message.data.length} blocks`);
    
    const receivedChain = message.data;
    if (receivedChain.length === 0) {
      logger.warn('MESSAGE_HANDLER', 'Received empty blockchain from peer');
      return;
    }

    const latestBlockReceived = receivedChain[receivedChain.length - 1];
    const latestBlockHeld = this.blockchain.getLatestBlock();

    if (latestBlockReceived.index > latestBlockHeld.index) {
      logger.info('MESSAGE_HANDLER', `Received longer blockchain from ${peerAddress}. New length: ${receivedChain.length}`);
      
      if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
        // We can append the new block to our chain
        if (this.blockchain.addBlock(latestBlockReceived)) {
          logger.info('MESSAGE_HANDLER', 'New block added to blockchain');
        }
      } else if (receivedChain.length === 1) {
        // We have to query the chain from our peer
        this.sendMessage(ws, { type: 'QUERY_ALL' });
      } else {
        // We have to query the chain from our peer
        this.sendMessage(ws, { type: 'QUERY_ALL' });
      }
    } else {
      logger.debug('MESSAGE_HANDLER', 'Received blockchain is not longer than current blockchain');
    }
  }

  /**
   * Handle transaction pool query
   */
  handleQueryTransactionPool(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Transaction pool queried by ${peerAddress}`);
    const response = {
      type: 'RESPONSE_TRANSACTION_POOL',
      data: this.blockchain.getPendingTransactions()
    };
    this.sendMessage(ws, response);
  }

  /**
   * Handle transaction pool response
   */
  handleResponseTransactionPool(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Transaction pool response received from ${peerAddress} with ${message.data.length} transactions`);
    
    const receivedTransactions = message.data;
    receivedTransactions.forEach(transaction => {
      try {
        this.blockchain.addPendingTransaction(transaction);
      } catch (error) {
        logger.warn('MESSAGE_HANDLER', `Failed to add transaction from peer: ${error.message}`);
      }
    });
  }

  /**
   * Handle new block announcement
   */
  handleNewBlock(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `New block announced by ${peerAddress}: ${message.data.index}`);
    
    const newBlock = message.data;
    if (this.blockchain.addBlock(newBlock)) {
      logger.info('MESSAGE_HANDLER', `New block added from peer: ${newBlock.index}`);
    }
  }

  /**
   * Handle new transaction announcement
   */
  handleNewTransaction(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `New transaction announced by ${peerAddress}`);
    
    const newTransaction = message.data;
    if (this.blockchain.addPendingTransaction(newTransaction)) {
      logger.info('MESSAGE_HANDLER', 'New transaction added from peer');
    }
  }

  /**
   * Handle seed node info
   */
  handleSeedNodeInfo(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Seed node info received from ${peerAddress}`);
    // Handle seed node information if needed
  }

  /**
   * Handle handshake
   */
  handleHandshake(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Handshake received from ${peerAddress}`);
    // Handle handshake authentication
  }

  /**
   * Handle authentication challenge
   */
  handleAuthChallenge(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Auth challenge received from ${peerAddress}`);
    // Handle authentication challenge
  }

  /**
   * Handle authentication response
   */
  handleAuthResponse(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Auth response received from ${peerAddress}`);
    // Handle authentication response
  }

  /**
   * Handle authentication success
   */
  handleAuthSuccess(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Auth success received from ${peerAddress}`);
    // Handle authentication success
  }

  /**
   * Handle authentication failure
   */
  handleAuthFailure(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Auth failure received from ${peerAddress}`);
    // Handle authentication failure
  }

  /**
   * Handle health status
   */
  handleHealthStatus(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Health status received from ${peerAddress}: ${JSON.stringify(message.data)}`);
    
    // Update peer reputation for good communication
    this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'health_status_received' });
  }

  /**
   * Handle peer list request
   */
  handleRequestPeerList(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Peer list requested by ${peerAddress}`);
    
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
    this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'peer_list_provided' });
  }

  /**
   * Handle heartbeat
   */
  handleHeartbeat(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Heartbeat received from ${peerAddress}, sequence: ${message.data.sequence}`);
    
    // Update peer reputation for maintaining connection
    this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'heartbeat_received' });
  }

  /**
   * Send message to peer
   */
  sendMessage(ws, message) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
        return true;
      }
    } catch (error) {
      logger.error('MESSAGE_HANDLER', `Failed to send message: ${error.message}`);
    }
    return false;
  }

  /**
   * Get peer list (placeholder - should be implemented by main network)
   */
  getPeerList() {
    // This should be implemented by the main P2PNetwork class
    // For now, return empty array - the main P2PNetwork class will override this
    return [];
  }

  /**
   * Get message validation statistics
   */
  getMessageValidationStats() {
    return {
      ...this.messageValidationStats,
      validationErrors: Object.fromEntries(this.messageValidationStats.validationErrors)
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
  }
}

module.exports = MessageHandler;
