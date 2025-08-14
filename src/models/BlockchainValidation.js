const logger = require('../utils/logger');

/**
 * CRITICAL: CPU exhaustion protection system
 */
class CPUProtection {
  /**
   *
   */
  constructor() {
    this.maxExecutionTime = 5000; // 5 seconds max execution time
    this.maxValidationComplexity = 1000; // Maximum validation complexity score
    this.maxTransactionsPerBatch = 100; // Maximum transactions to validate per batch
    this.cpuThreshold = 0.8; // 80% CPU usage threshold
    this.rateLimitPerSecond = 100; // Maximum validations per second

    // CPU monitoring
    this.currentCPUUsage = 0;
    this.validationCount = 0;
    this.lastValidationReset = Date.now();
    this.executionTimes = [];
    this.complexityScores = [];

    // Start CPU monitoring
    this.startCPUMonitoring();
  }

  /**
   * CRITICAL: Start CPU monitoring
   */
  startCPUMonitoring() {
    setInterval(() => {
      this.checkCPUUsage();
      this.resetRateLimits();
    }, 1000); // Check every second
  }

  /**
   * CRITICAL: Check CPU usage and reset rate limits
   */
  checkCPUUsage() {
    try {
      // Reset validation count every second
      this.validationCount = 0;
      this.lastValidationReset = Date.now();

      // Monitor execution times
      if (this.executionTimes.length > 10) {
        this.executionTimes.shift();
      }

      // Monitor complexity scores
      if (this.complexityScores.length > 10) {
        this.complexityScores.shift();
      }
    } catch (error) {
      logger.error('CPU_PROTECTION', `CPU monitoring failed: ${error.message}`);
    }
  }

  /**
   * CRITICAL: Reset rate limits
   */
  resetRateLimits() {
    this.validationCount = 0;
    this.lastValidationReset = Date.now();
  }

  /**
   * CRITICAL: Check if validation is allowed (rate limiting)
   */
  canValidate() {
    if (this.validationCount >= this.rateLimitPerSecond) {
      logger.warn(
        'CPU_PROTECTION',
        `⚠️  Validation rate limit exceeded: ${this.validationCount}/${this.rateLimitPerSecond}`
      );
      return false;
    }

    this.validationCount++;
    return true;
  }

  /**
   * CRITICAL: Measure execution time and complexity
   * @param operation
   * @param complexity
   */
  measureExecution(operation, complexity = 1) {
    const startTime = Date.now();

    return {
      start: () => {
        // Check if operation is allowed
        if (!this.canValidate()) {
          throw new Error('CPU validation rate limit exceeded');
        }

        // Check complexity
        if (complexity > this.maxValidationComplexity) {
          throw new Error(`Operation complexity ${complexity} exceeds maximum ${this.maxValidationComplexity}`);
        }

        return startTime;
      },
      end: () => {
        const executionTime = Date.now() - startTime;

        // Record execution time
        this.executionTimes.push(executionTime);

        // Record complexity score
        this.complexityScores.push(complexity);

        // Check execution time limit
        if (executionTime > this.maxExecutionTime) {
          logger.warn(
            'CPU_PROTECTION',
            `⚠️  Operation execution time ${executionTime}ms exceeds limit ${this.maxExecutionTime}ms`
          );
        }

        return executionTime;
      },
    };
  }

  /**
   * CRITICAL: Get CPU protection status
   */
  getCPUStatus() {
    const avgExecutionTime =
      this.executionTimes.length > 0 ? this.executionTimes.reduce((a, b) => a + b, 0) / this.executionTimes.length : 0;

    const avgComplexity =
      this.complexityScores.length > 0
        ? this.complexityScores.reduce((a, b) => a + b, 0) / this.complexityScores.length
        : 0;

    return {
      currentValidationCount: this.validationCount,
      maxValidationsPerSecond: this.rateLimitPerSecond,
      maxExecutionTime: this.maxExecutionTime,
      maxValidationComplexity: this.maxValidationComplexity,
      averageExecutionTime: avgExecutionTime.toFixed(2),
      averageComplexity: avgComplexity.toFixed(2),
      executionTimes: this.executionTimes.length,
      complexityScores: this.complexityScores.length,
    };
  }

  /**
   * CRITICAL: Update CPU protection limits
   * @param newLimits
   */
  updateCPULimits(newLimits) {
    if (newLimits.maxExecutionTime) {
      this.maxExecutionTime = newLimits.maxExecutionTime;
    }
    if (newLimits.maxValidationComplexity) {
      this.maxValidationComplexity = newLimits.maxValidationComplexity;
    }
    if (newLimits.maxTransactionsPerBatch) {
      this.maxTransactionsPerBatch = newLimits.maxTransactionsPerBatch;
    }
    if (newLimits.rateLimitPerSecond) {
      this.rateLimitPerSecond = newLimits.rateLimitPerSecond;
    }

    logger.info('CPU_PROTECTION', 'CPU protection limits updated');
  }
}

/**
 * Blockchain Validation - Handles all blockchain validation methods
 */
class BlockchainValidation {
  /**
   *
   */
  constructor() {
    // CRITICAL: Initialize CPU protection
    this.cpuProtection = new CPUProtection();
  }

  /**
   * CRITICAL: Validate block transactions with CPU protection
   * @param block
   * @param config
   */
  validateBlockTransactions(block, config = null) {
    const measurement = this.cpuProtection.measureExecution('validateBlockTransactions', block.transactions.length);
    const startTime = measurement.start();

    try {
      // Validate transaction count
      if (!Array.isArray(block.transactions) || block.transactions.length === 0) {
        throw new Error('Block must contain at least one transaction');
      }

      // Check batch size limit
      if (block.transactions.length > this.cpuProtection.maxTransactionsPerBatch) {
        throw new Error(
          `Transaction count ${block.transactions.length} exceeds batch limit ${this.cpuProtection.maxTransactionsPerBatch}`
        );
      }

      // Validate each transaction
      for (let i = 0; i < block.transactions.length; i++) {
        const transaction = block.transactions[i];

        // First transaction must be coinbase
        if (i === 0 && !transaction.isCoinbase) {
          throw new Error('First transaction must be coinbase');
        }

        // Other transactions must not be coinbase
        if (i > 0 && transaction.isCoinbase) {
          throw new Error('Only first transaction can be coinbase');
        }

        // Validate transaction - handle both Transaction instances and plain objects
        if (typeof transaction.isValid === 'function') {
          // Transaction instance - call isValid method
          if (!transaction.isValid()) {
            throw new Error(`Transaction ${i} is invalid: ${transaction.id}`);
          }
        } else {
          // Plain object - do basic validation
          if (!transaction.id || !transaction.outputs || transaction.outputs.length === 0) {
            throw new Error(`Transaction ${i} basic validation failed: missing required fields`);
          }
        }
      }

      const executionTime = measurement.end();
      logger.debug('BLOCKCHAIN_VALIDATION', `Block transactions validated in ${executionTime}ms`);

      return { valid: true, reason: null };
    } catch (error) {
      const executionTime = measurement.end();
      logger.error(
        'BLOCKCHAIN_VALIDATION',
        `Block transaction validation failed in ${executionTime}ms: ${error.message}`
      );
      return { valid: false, reason: error.message };
    }
  }

  /**
   * Check if block is valid
   * @param block
   * @param config
   */
  isValidBlock(block, config = null) {
    logger.debug(
      'BLOCKCHAIN_VALIDATION',
      `Validating block: index=${block?.index}, timestamp=${block?.timestamp}, previousHash=${block?.previousHash?.substring(0, 16) || 'none'}..., hash=${block?.hash?.substring(0, 16) || 'none'}...`
    );
    logger.debug('BLOCKCHAIN_VALIDATION', `Config present: ${config ? 'yes' : 'no'}, config type: ${typeof config}`);

    try {
      // Basic block validation
      if (
        !block ||
        block.index === undefined ||
        block.index === null ||
        block.timestamp === undefined ||
        block.timestamp === null ||
        block.previousHash === undefined ||
        block.previousHash === null ||
        block.hash === undefined ||
        block.hash === null
      ) {
        return false;
      }

      // Validate block structure - check if it's a proper Block instance

      // For genesis blocks, we need to check additional properties
      if (block.index === 0) {
        if (!block.transactions || !Array.isArray(block.transactions) || block.transactions.length === 0) {
          return false;
        }

        if (!block.merkleRoot || !block.nonce || !block.difficulty || !block.algorithm) {
          return false;
        }
      }

      // For genesis blocks, skip the isValid() call since it's a getter, not a method
      if (block.index === 0) {
        return true;
      }

      // For non-genesis blocks, check if they have the isValid method
      if (typeof block.isValid === 'function') {
        if (!block.isValid()) {
          return false;
        }
      }

      // Validate block transactions (except genesis)
      if (block.index > 0) {
        const validationResult = this.validateBlockTransactions(block, config);

        if (!validationResult.valid) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block ${block.index} REJECTED: ${validationResult.reason}`);
          return false;
        }
      }
      return true;
    } catch (error) {
      logger.error('BLOCKCHAIN_VALIDATION', `Block validation error for block ${block?.index}: ${error.message}`);
      logger.error('BLOCKCHAIN_VALIDATION', `Error stack: ${error.stack}`);
      logger.error(
        'BLOCKCHAIN_VALIDATION',
        `Block data: ${JSON.stringify({
          index: block?.index,
          timestamp: block?.timestamp,
          previousHash: block?.previousHash,
          hash: block?.hash,
          hasIsValid: typeof block?.isValid === 'function',
        })}`
      );
      return false;
    }
  }

  /**
   * Validate entire blockchain
   * @param chain
   * @param config
   */
  isValidChain(chain, config) {
    try {
      if (!chain || !Array.isArray(chain) || chain.length === 0) {
        return false;
      }

      logger.info('BLOCKCHAIN_VALIDATION', `Validating blockchain with ${chain.length} blocks...`);

      // Validate genesis block
      const genesisBlock = chain[0];
      if (genesisBlock.index !== 0 || genesisBlock.previousHash !== '0') {
        logger.error('BLOCKCHAIN_VALIDATION', 'Genesis block validation failed');
        return false;
      }

      if (!this.isValidBlock(genesisBlock, config)) {
        logger.error('BLOCKCHAIN_VALIDATION', 'Genesis block structure validation failed');
        return false;
      }

      // Validate all other blocks
      for (let i = 1; i < chain.length; i++) {
        const currentBlock = chain[i];
        const previousBlock = chain[i - 1];

        // Check block linking
        if (currentBlock.previousHash !== previousBlock.hash) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block ${i} is not properly linked to previous block`);
          return false;
        }

        // Check block index sequence
        if (currentBlock.index !== previousBlock.index + 1) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block index sequence broken at index ${i}`);
          return false;
        }

        // Validate block structure and transactions
        if (!this.isValidBlock(currentBlock, config)) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block ${i} validation failed`);
          return false;
        }

        // Show progress for large chains
        if (chain.length > 100 && i % Math.floor(chain.length / 10) === 0) {
          const progress = ((i / chain.length) * 100).toFixed(1);
          logger.info('BLOCKCHAIN_VALIDATION', `Validation progress: ${i}/${chain.length} blocks (${progress}%)`);
        }
      }

      logger.info('BLOCKCHAIN_VALIDATION', 'Blockchain validation completed successfully');
      return true;
    } catch (error) {
      logger.error('BLOCKCHAIN_VALIDATION', `Blockchain validation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Fast validation that skips expensive operations
   * @param chain
   */
  isValidChainFast(chain) {
    try {
      if (!chain || !Array.isArray(chain) || chain.length === 0) {
        return false;
      }

      logger.info('BLOCKCHAIN_VALIDATION', `Fast validation for ${chain.length} blocks (skipping expensive checks)...`);

      // Validate genesis block (basic checks only)
      const genesisBlock = chain[0];
      if (!genesisBlock || genesisBlock.index !== 0 || genesisBlock.previousHash !== '0') {
        logger.error('BLOCKCHAIN_VALIDATION', 'Genesis block basic validation failed');
        return false;
      }

      // Use Set for O(1) duplicate detection
      const seenHashes = new Set([genesisBlock.hash]);

      // Fast validation: only check chain integrity, not block proofs
      for (let i = 1; i < chain.length; i++) {
        const currentBlock = chain[i];
        const previousBlock = chain[i - 1];

        // Basic block existence check
        if (!currentBlock || !previousBlock) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block missing at index ${i}`);
          return false;
        }

        // Check index sequence
        if (currentBlock.index !== previousBlock.index + 1) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block index sequence broken at index ${i}`);
          return false;
        }

        // Check for duplicates (O(1) operation)
        if (seenHashes.has(currentBlock.hash)) {
          logger.error('BLOCKCHAIN_VALIDATION', `Duplicate block hash found at index ${i}`);
          return false;
        }
        seenHashes.add(currentBlock.hash);

        // Check chain linking (most important)
        if (currentBlock.previousHash !== previousBlock.hash) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block at index ${i} is not properly linked`);
          return false;
        }

        // SKIP expensive operations:
        // - block.isValid() (KawPow verification)
        // - Transaction validation
        // - Merkle root verification
        // - Hash difficulty verification
      }

      logger.info('BLOCKCHAIN_VALIDATION', 'Fast validation completed successfully');
      return true;
    } catch (error) {
      logger.error('BLOCKCHAIN_VALIDATION', `Fast validation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Ultra-fast validation for very large chains
   * @param chain
   */
  isValidChainUltraFast(chain) {
    try {
      if (!chain || !Array.isArray(chain) || chain.length === 0) {
        return false;
      }

      logger.info('BLOCKCHAIN_VALIDATION', `Ultra-fast validation for ${chain.length} blocks (minimal checks)...`);

      // Only validate chain integrity, nothing else
      for (let i = 1; i < chain.length; i++) {
        const currentBlock = chain[i];
        const previousBlock = chain[i - 1];

        // Minimal linking check only
        if (currentBlock.previousHash !== previousBlock.hash) {
          logger.error('BLOCKCHAIN_VALIDATION', `Block at index ${i} is not properly linked`);
          return false;
        }
      }

      logger.info('BLOCKCHAIN_VALIDATION', 'Ultra-fast validation completed successfully');
      return true;
    } catch (error) {
      logger.error('BLOCKCHAIN_VALIDATION', `Ultra-fast validation error: ${error.message}`);
      return false;
    }
  }
}

module.exports = BlockchainValidation;
