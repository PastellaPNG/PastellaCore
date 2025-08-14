const WebSocket = require('ws');

const logger = require('../utils/logger.js');
const MessageValidator = require('../utils/MessageValidator.js');

/**
 * Message Handler - Handles all message processing and routing
 */
class MessageHandler {
  /**
   *
   * @param blockchain
   * @param peerReputation
   * @param config
   */
  constructor(blockchain, peerReputation, config) {
    logger.debug('MESSAGE_HANDLER', `Initializing MessageHandler...`);
    logger.debug(
      'MESSAGE_HANDLER',
      `Blockchain instance: ${blockchain ? 'present' : 'null'}, type: ${typeof blockchain}`
    );
    logger.debug(
      'MESSAGE_HANDLER',
      `PeerReputation instance: ${peerReputation ? 'present' : 'null'}, type: ${typeof peerReputation}`
    );
    logger.debug(
      'MESSAGE_HANDLER',
      `Config instance: ${config ? 'present' : 'null'}, networkId: ${config?.networkId || 'undefined'}`
    );

    this.blockchain = blockchain;
    this.peerReputation = peerReputation;
    this.config = config;
    this.p2pNetwork = null; // Will be set by P2PNetwork after initialization
    this.messageHandlers = new Map();
    this.messageValidator = new MessageValidator();
    this.messageValidationStats = {
      totalMessages: 0,
      validMessages: 0,
      invalidMessages: 0,
      validationErrors: new Map(), // Map<errorType, count>
    };

    logger.debug('MESSAGE_HANDLER', `MessageHandler components initialized:`);
    logger.debug('MESSAGE_HANDLER', `  MessageHandlers Map: ${this.messageHandlers.size} handlers`);
    logger.debug('MESSAGE_HANDLER', `  MessageValidator: ${this.messageValidator ? 'present' : 'null'}`);
    logger.debug(
      'MESSAGE_HANDLER',
      `  MessageValidationStats: initialized with ${this.messageValidationStats.totalMessages} total messages`
    );

    logger.debug('MESSAGE_HANDLER', `Setting up message handlers...`);
    this.setupMessageHandlers();
    logger.debug('MESSAGE_HANDLER', `MessageHandler initialized successfully`);
  }

  /**
   * Set P2PNetwork reference for cross-component communication
   * @param p2pNetwork
   */
  setP2PNetworkReference(p2pNetwork) {
    this.p2pNetwork = p2pNetwork;
    logger.debug('MESSAGE_HANDLER', `P2PNetwork reference set`);
  }

  /**
   * Setup message handlers
   */
  setupMessageHandlers() {
    logger.debug('MESSAGE_HANDLER', `Setting up message handlers...`);

    // Core blockchain message handlers
    logger.debug('MESSAGE_HANDLER', `Setting up core blockchain message handlers...`);
    this.messageHandlers.set('QUERY_LATEST', this.handleQueryLatest.bind(this));
    this.messageHandlers.set('QUERY_ALL', this.handleQueryAll.bind(this));
    this.messageHandlers.set('RESPONSE_BLOCKCHAIN', this.handleResponseBlockchain.bind(this));
    this.messageHandlers.set('QUERY_TRANSACTION_POOL', this.handleQueryTransactionPool.bind(this));
    this.messageHandlers.set('RESPONSE_TRANSACTION_POOL', this.handleResponseTransactionPool.bind(this));
    this.messageHandlers.set('NEW_BLOCK', this.handleNewBlock.bind(this));
    this.messageHandlers.set('NEW_TRANSACTION', this.handleNewTransaction.bind(this));
    this.messageHandlers.set('SEED_NODE_INFO', this.handleSeedNodeInfo.bind(this));
    logger.debug('MESSAGE_HANDLER', `Core blockchain handlers configured: ${this.messageHandlers.size} handlers`);

    // Authentication message handlers
    logger.debug('MESSAGE_HANDLER', `Setting up authentication message handlers...`);
    this.messageHandlers.set('HANDSHAKE', this.handleHandshake.bind(this));
    this.messageHandlers.set('HANDSHAKE_ACCEPTED', this.handleHandshakeAccepted.bind(this));
    this.messageHandlers.set('HANDSHAKE_REJECTED', this.handleHandshakeRejected.bind(this));
    this.messageHandlers.set('HANDSHAKE_ERROR', this.handleHandshakeError.bind(this));
    this.messageHandlers.set('AUTH_CHALLENGE', this.handleAuthChallenge.bind(this));
    this.messageHandlers.set('AUTH_RESPONSE', this.handleAuthResponse.bind(this));
    this.messageHandlers.set('AUTH_SUCCESS', this.handleAuthSuccess.bind(this));
    this.messageHandlers.set('AUTH_FAILURE', this.handleAuthFailure.bind(this));
    logger.debug('MESSAGE_HANDLER', `Authentication handlers configured: ${this.messageHandlers.size} total handlers`);

    // Partition handling message handlers
    logger.debug('MESSAGE_HANDLER', `Setting up partition handling message handlers...`);
    this.messageHandlers.set('HEALTH_STATUS', this.handleHealthStatus.bind(this));
    this.messageHandlers.set('REQUEST_PEER_LIST', this.handleRequestPeerList.bind(this));
    this.messageHandlers.set('HEARTBEAT', this.handleHeartbeat.bind(this));
    logger.debug(
      'MESSAGE_HANDLER',
      `Partition handling handlers configured: ${this.messageHandlers.size} total handlers`
    );

    logger.debug(
      'MESSAGE_HANDLER',
      `All message handlers configured successfully: ${this.messageHandlers.size} total handlers`
    );
  }

  /**
   * Handle incoming message
   * @param ws
   * @param message
   * @param peerAddress
   * @param isPeerAuthenticated
   */
  handleMessage(ws, message, peerAddress, isPeerAuthenticated) {
    logger.debug('MESSAGE_HANDLER', `Handling incoming message from peer ${peerAddress}...`);
    logger.debug(
      'MESSAGE_HANDLER',
      `Message type: ${message?.type}, WebSocket: ${ws ? 'present' : 'null'}, Authenticated: ${isPeerAuthenticated}`
    );
    logger.debug('MESSAGE_HANDLER', `Message content: ${JSON.stringify(message)}`);

    // Update message statistics
    this.messageValidationStats.totalMessages++;
    logger.debug(
      'MESSAGE_HANDLER',
      `Message statistics updated: totalMessages=${this.messageValidationStats.totalMessages}`
    );

    // Comprehensive message validation
    logger.debug('MESSAGE_HANDLER', `Validating message from peer ${peerAddress}...`);
    const validation = this.messageValidator.validateMessage(message, peerAddress);
    logger.debug('MESSAGE_HANDLER', `Message validation result: ${JSON.stringify(validation)}`);

    if (!validation.valid) {
      this.messageValidationStats.invalidMessages++;
      logger.debug(
        'MESSAGE_HANDLER',
        `Message validation failed, updating statistics: invalidMessages=${this.messageValidationStats.invalidMessages}`
      );

      // Track validation errors
      const errorType = validation.error || 'unknown_error';
      const currentCount = this.messageValidationStats.validationErrors.get(errorType) || 0;
      this.messageValidationStats.validationErrors.set(errorType, currentCount + 1);
      logger.debug('MESSAGE_HANDLER', `Validation error tracking updated: ${errorType}=${currentCount + 1}`);

      logger.warn('MESSAGE_HANDLER', `[MESSAGE_VALIDATION] Invalid message from ${peerAddress}: ${validation.error}`);
      if (validation.details) {
        logger.debug('MESSAGE_HANDLER', `[MESSAGE_VALIDATION] Details: ${validation.details}`);
      }
      logger.debug('MESSAGE_HANDLER', `[MESSAGE_VALIDATION] Invalid message content: ${JSON.stringify(message)}`);

      logger.debug('MESSAGE_HANDLER', `Updating peer reputation for invalid message...`);
      this.peerReputation.updatePeerReputation(peerAddress, 'invalid_message', {
        reason: 'message_validation_failed',
        error: validation.error,
        details: validation.details,
      });
      logger.debug('MESSAGE_HANDLER', `Peer reputation updated for invalid message`);
      return false;
    }

    this.messageValidationStats.validMessages++;
    logger.debug(
      'MESSAGE_HANDLER',
      `Message validation passed, updating statistics: validMessages=${this.messageValidationStats.validMessages}`
    );

    // Check authentication for sensitive operations
    const sensitiveOperations = ['NEW_BLOCK', 'NEW_TRANSACTION', 'RESPONSE_BLOCKCHAIN', 'RESPONSE_TRANSACTION_POOL'];
    if (sensitiveOperations.includes(message.type) && !isPeerAuthenticated) {
      logger.warn(
        'MESSAGE_HANDLER',
        `[AUTH] Unauthenticated peer ${peerAddress} attempted sensitive operation: ${message.type}`
      );
      this.peerReputation.updatePeerReputation(peerAddress, 'bad_behavior', { reason: 'unauthorized_operation' });
      return false;
    }

    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      try {
        handler(ws, message, peerAddress);
        // Update reputation for successful message handling
        this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', {
          reason: 'message_handled_successfully',
        });
        return true;
      } catch (error) {
        logger.error(
          'MESSAGE_HANDLER',
          `[MESSAGE_HANDLER] Error handling message from ${peerAddress}: ${error.message}`
        );
        this.peerReputation.updatePeerReputation(peerAddress, 'bad_behavior', {
          reason: 'message_handler_error',
          error: error.message,
        });
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
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleQueryLatest(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Latest block queried by ${peerAddress}`);
    const latestBlock = this.blockchain.getLatestBlock();
    const response = {
      type: 'RESPONSE_BLOCKCHAIN',
      data: [latestBlock],
    };
    this.sendMessage(ws, response);
  }

  /**
   * Handle query all blocks
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleQueryAll(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `All blocks queried by ${peerAddress}`);
    const response = {
      type: 'RESPONSE_BLOCKCHAIN',
      data: this.blockchain.chain,
    };
    this.sendMessage(ws, response);
  }

  /**
   * Handle blockchain response
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleResponseBlockchain(ws, message, peerAddress) {
    logger.debug(
      'MESSAGE_HANDLER',
      `Blockchain response received from ${peerAddress} with ${message.data.length} blocks`
    );

    const receivedChain = message.data;
    if (receivedChain.length === 0) {
      logger.warn('MESSAGE_HANDLER', 'Received empty blockchain from peer');
      return;
    }

    const latestBlockReceived = receivedChain[receivedChain.length - 1];
    const latestBlockHeld = this.blockchain.getLatestBlock();

    if (latestBlockReceived.index > latestBlockHeld.index) {
      logger.info(
        'MESSAGE_HANDLER',
        `Received longer blockchain from ${peerAddress}. New length: ${receivedChain.length}`
      );

      // Check if we received a complete chain or just partial data
      if (receivedChain.length === 1 && latestBlockReceived.index > 0) {
        // We received only one block with high index, need to request full chain
        logger.info('MESSAGE_HANDLER', `Received single block ${latestBlockReceived.index}, requesting full chain`);
        this.sendMessage(ws, { type: 'QUERY_ALL' });
        return;
      }

      // Convert received JSON blocks to Block instances for validation
      try {
        const Block = require('../models/Block.js');
        const convertedChain = receivedChain.map(blockData => {
          if (blockData instanceof Block) {
            return blockData; // Already a Block instance
          }
          return Block.fromJSON(blockData); // Convert JSON to Block instance
        });

        // Check if the converted chain is valid
        const isValidChain = this.blockchain.isValidChain(convertedChain);

        if (isValidChain) {
          logger.info('MESSAGE_HANDLER', 'Received chain is valid, replacing local blockchain');

          // Clear the current chain and add all blocks from the received chain
          this.blockchain.chain = [];
          // Don't reinitialize - just add the received blocks directly

          // Add all blocks from the received chain
          for (const block of convertedChain) {
            if (this.blockchain.addBlock(block)) {
              logger.debug('MESSAGE_HANDLER', `Added block ${block.index} to blockchain`);
            } else {
              logger.error('MESSAGE_HANDLER', `Failed to add block ${block.index}`);
            }
          }

          logger.info('MESSAGE_HANDLER', `Successfully synced blockchain to ${receivedChain.length} blocks`);
        } else {
          logger.warn('MESSAGE_HANDLER', 'Received chain is invalid, rejecting sync');
          // If chain is invalid, request full chain to get correct data
          logger.info('MESSAGE_HANDLER', 'Requesting full chain due to validation failure');
          this.sendMessage(ws, { type: 'QUERY_ALL' });
        }
      } catch (error) {
        logger.error('MESSAGE_HANDLER', `Error validating received chain: ${error.message}`);
        // If validation throws error, request full chain
        logger.info('MESSAGE_HANDLER', 'Requesting full chain due to validation error');
        this.sendMessage(ws, { type: 'QUERY_ALL' });
      }
    } else {
      logger.debug('MESSAGE_HANDLER', 'Received blockchain is not longer than current blockchain');
    }
  }

  /**
   * Handle transaction pool query
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleQueryTransactionPool(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Transaction pool queried by ${peerAddress}`);
    const response = {
      type: 'RESPONSE_TRANSACTION_POOL',
      data: this.blockchain.getPendingTransactions(),
    };
    this.sendMessage(ws, response);
  }

  /**
   * Handle transaction pool response
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleResponseTransactionPool(ws, message, peerAddress) {
    logger.debug(
      'MESSAGE_HANDLER',
      `Transaction pool response received from ${peerAddress} with ${message.data.length} transactions`
    );

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
   * @param ws
   * @param message
   * @param peerAddress
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
   * @param ws
   * @param message
   * @param peerAddress
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
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleSeedNodeInfo(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Seed node info received from ${peerAddress}`);
    // Handle seed node information if needed
  }

  /**
   * Handle handshake
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleHandshake(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Handshake received from ${peerAddress}`);

    try {
      // Validate handshake message structure
      if (!message.data || !message.data.networkId) {
        logger.warn('MESSAGE_HANDLER', `Invalid handshake from ${peerAddress}: missing networkId`);
        this.sendMessage(ws, {
          type: 'HANDSHAKE_REJECTED',
          data: {
            reason: 'Invalid handshake format',
            timestamp: Date.now(),
          },
        });
        return;
      }

      const peerNetworkId = message.data.networkId;
      const localNetworkId = this.config?.networkId || 'unknown';

      // Check if network IDs match
      if (peerNetworkId !== localNetworkId) {
        logger.warn(
          'MESSAGE_HANDLER',
          `Network ID mismatch from ${peerAddress}: expected ${localNetworkId}, got ${peerNetworkId}`
        );

        // Send rejection message with network ID info
        this.sendMessage(ws, {
          type: 'HANDSHAKE_REJECTED',
          data: {
            reason: 'Network ID mismatch',
            expectedNetworkId: localNetworkId,
            receivedNetworkId: peerNetworkId,
            timestamp: Date.now(),
            message: 'This node is running on a different network. Please check your configuration.',
          },
        });

        // Close connection after sending rejection
        setTimeout(() => {
          try {
            ws.close(1000, 'Network ID mismatch');
          } catch (error) {
            logger.debug('MESSAGE_HANDLER', `Error closing connection: ${error.message}`);
          }
        }, 1000);

        return;
      }

      // Network ID matches - proceed with handshake
      logger.info('MESSAGE_HANDLER', `Network ID match with ${peerAddress}: ${peerNetworkId}`);

      // Send successful handshake response
      this.sendMessage(ws, {
        type: 'HANDSHAKE_ACCEPTED',
        data: {
          networkId: localNetworkId,
          nodeVersion: '1.0.0',
          timestamp: Date.now(),
          message: 'Network ID verified successfully',
        },
      });

      // Update peer reputation for successful handshake
      this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', {
        reason: 'successful_handshake',
        networkId: peerNetworkId,
      });

      logger.info('MESSAGE_HANDLER', `Handshake completed successfully with ${peerAddress}`);
    } catch (error) {
      logger.error('MESSAGE_HANDLER', `Error during handshake with ${peerAddress}: ${error.message}`);

      // Send error response
      this.sendMessage(ws, {
        type: 'HANDSHAKE_ERROR',
        data: {
          reason: 'Internal error during handshake',
          timestamp: Date.now(),
        },
      });
    }
  }

  /**
   * Handle handshake accepted response
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleHandshakeAccepted(ws, message, peerAddress) {
    logger.info('MESSAGE_HANDLER', `Handshake accepted by ${peerAddress}: ${message.data.networkId}`);

    // Clear any pending handshake timeout
    if (this.p2pNetwork && this.p2pNetwork.pendingHandshakes) {
      const timeout = this.p2pNetwork.pendingHandshakes.get(peerAddress);
      if (timeout) {
        clearTimeout(timeout);
        this.p2pNetwork.pendingHandshakes.delete(peerAddress);
      }
    }

    // Mark peer as authenticated
    if (this.p2pNetwork) {
      this.p2pNetwork.authenticatedPeers.set(peerAddress, {
        nodeId: message.data.nodeId || 'unknown',
        networkId: message.data.networkId,
        authenticatedAt: Date.now(),
      });
    }

    // Update peer reputation
    this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', {
      reason: 'handshake_accepted',
      networkId: message.data.networkId,
    });
  }

  /**
   * Handle handshake rejected response
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleHandshakeRejected(ws, message, peerAddress) {
    logger.warn('MESSAGE_HANDLER', `Handshake rejected by ${peerAddress}: ${message.data.reason}`);

    // Clear any pending handshake timeout
    if (this.p2pNetwork && this.p2pNetwork.pendingHandshakes) {
      const timeout = this.p2pNetwork.pendingHandshakes.get(peerAddress);
      if (timeout) {
        clearTimeout(timeout);
        this.p2pNetwork.pendingHandshakes.delete(peerAddress);
      }
    }

    // Log the rejection reason
    if (message.data.expectedNetworkId && message.data.receivedNetworkId) {
      logger.warn(
        'MESSAGE_HANDLER',
        `Network ID mismatch: expected ${message.data.expectedNetworkId}, received ${message.data.receivedNetworkId}`
      );
    }

    // Update peer reputation
    this.peerReputation.updatePeerReputation(peerAddress, 'bad_behavior', {
      reason: 'handshake_rejected',
      details: message.data.reason,
    });

    // Close connection after a short delay
    setTimeout(() => {
      try {
        ws.close(1000, 'Handshake rejected');
      } catch (error) {
        logger.debug('MESSAGE_HANDLER', `Error closing connection: ${error.message}`);
      }
    }, 1000);
  }

  /**
   * Handle handshake error response
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleHandshakeError(ws, message, peerAddress) {
    logger.error('MESSAGE_HANDLER', `Handshake error from ${peerAddress}: ${message.data.reason}`);

    // Clear any pending handshake timeout
    if (this.p2pNetwork && this.p2pNetwork.pendingHandshakes) {
      const timeout = this.p2pNetwork.pendingHandshakes.get(peerAddress);
      if (timeout) {
        clearTimeout(timeout);
        this.p2pNetwork.pendingHandshakes.delete(peerAddress);
      }
    }

    // Update peer reputation
    this.peerReputation.updatePeerReputation(peerAddress, 'bad_behavior', {
      reason: 'handshake_error',
      details: message.data.reason,
    });

    // Close connection after a short delay
    setTimeout(() => {
      try {
        ws.close(1000, 'Handshake error');
      } catch (error) {
        logger.debug('MESSAGE_HANDLER', `Error closing connection: ${error.message}`);
      }
    }, 1000);
  }

  /**
   * Handle authentication challenge
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleAuthChallenge(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Auth challenge received from ${peerAddress}`);
    // Handle authentication challenge
  }

  /**
   * Handle authentication response
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleAuthResponse(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Auth response received from ${peerAddress}`);
    // Handle authentication response
  }

  /**
   * Handle authentication success
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleAuthSuccess(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Auth success received from ${peerAddress}`);
    // Handle authentication success
  }

  /**
   * Handle authentication failure
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleAuthFailure(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Auth failure received from ${peerAddress}`);
    // Handle authentication failure
  }

  /**
   * Handle health status
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleHealthStatus(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Health status received from ${peerAddress}: ${JSON.stringify(message.data)}`);

    // Update peer reputation for good communication
    this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'health_status_received' });
  }

  /**
   * Handle peer list request
   * @param ws
   * @param message
   * @param peerAddress
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
        requester: message.data.requester,
      },
    };

    this.sendMessage(ws, response);
    this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'peer_list_provided' });
  }

  /**
   * Handle heartbeat
   * @param ws
   * @param message
   * @param peerAddress
   */
  handleHeartbeat(ws, message, peerAddress) {
    logger.debug('MESSAGE_HANDLER', `Heartbeat received from ${peerAddress}, sequence: ${message.data.sequence}`);

    // Update peer reputation for maintaining connection
    this.peerReputation.updatePeerReputation(peerAddress, 'good_behavior', { reason: 'heartbeat_received' });
  }

  /**
   * Send message to peer
   * @param ws
   * @param message
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
      validationErrors: Object.fromEntries(this.messageValidationStats.validationErrors),
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
      validationErrors: new Map(),
    };
  }
}

module.exports = MessageHandler;
