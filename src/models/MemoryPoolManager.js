const logger = require('../utils/logger');

/**
 * CRITICAL: Memory exhaustion protection system
 */
class MemoryProtection {
  constructor() {
    this.maxMemoryUsage = 100 * 1024 * 1024; // 100MB default limit
    this.maxTransactionSize = 1024 * 1024; // 1MB per transaction
    this.maxPoolSize = 10000; // Maximum transactions in pool
    this.memoryThreshold = 0.8; // 80% memory usage threshold
    this.cleanupInterval = 60000; // 1 minute cleanup interval
    this.lastCleanup = Date.now();
    
    // Memory monitoring
    this.currentMemoryUsage = 0;
    this.transactionSizes = new Map(); // Track transaction memory usage
    this.memoryWarnings = [];
    
    // Start memory monitoring
    this.startMemoryMonitoring();
  }

  /**
   * CRITICAL: Start memory monitoring
   */
  startMemoryMonitoring() {
    setInterval(() => {
      this.checkMemoryUsage();
    }, 10000); // Check every 10 seconds
  }

  /**
   * CRITICAL: Check current memory usage
   */
  checkMemoryUsage() {
    try {
      const used = process.memoryUsage();
      this.currentMemoryUsage = used.heapUsed;
      
      const memoryUsagePercent = this.currentMemoryUsage / this.maxMemoryUsage;
      
      if (memoryUsagePercent > this.memoryThreshold) {
        logger.warn('MEMORY_PROTECTION', `⚠️  High memory usage: ${(memoryUsagePercent * 100).toFixed(2)}%`);
        this.triggerMemoryCleanup();
      }
      
      // Log memory status every minute
      if (Date.now() - this.lastCleanup > 60000) {
        logger.debug('MEMORY_PROTECTION', `Memory usage: ${(this.currentMemoryUsage / 1024 / 1024).toFixed(2)}MB / ${(this.maxMemoryUsage / 1024 / 1024).toFixed(2)}MB`);
        this.lastCleanup = Date.now();
      }
    } catch (error) {
      logger.error('MEMORY_PROTECTION', `Memory check failed: ${error.message}`);
    }
  }

  /**
   * CRITICAL: Trigger memory cleanup
   */
  triggerMemoryCleanup() {
    try {
      logger.info('MEMORY_PROTECTION', '🚨 Memory threshold exceeded, triggering cleanup');
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        logger.info('MEMORY_PROTECTION', 'Garbage collection triggered');
      }
      
      // Clear old transaction size tracking
      this.transactionSizes.clear();
      
      // Add memory warning
      this.memoryWarnings.push({
        timestamp: Date.now(),
        usage: this.currentMemoryUsage,
        threshold: this.maxMemoryUsage
      });
      
      // Keep only last 10 warnings
      if (this.memoryWarnings.length > 10) {
        this.memoryWarnings.shift();
      }
      
    } catch (error) {
      logger.error('MEMORY_PROTECTION', `Memory cleanup failed: ${error.message}`);
    }
  }

  /**
   * CRITICAL: Check if transaction size is acceptable
   */
  validateTransactionSize(transaction) {
    try {
      const transactionSize = JSON.stringify(transaction).length;
      
      if (transactionSize > this.maxTransactionSize) {
        throw new Error(`Transaction size ${transactionSize} bytes exceeds limit ${this.maxTransactionSize} bytes`);
      }
      
      return transactionSize;
    } catch (error) {
      throw new Error(`Transaction size validation failed: ${error.message}`);
    }
  }

  /**
   * CRITICAL: Check if adding transaction would exceed memory limits
   */
  canAddTransaction(transaction) {
    try {
      const transactionSize = this.validateTransactionSize(transaction);
      const estimatedNewUsage = this.currentMemoryUsage + transactionSize;
      
      if (estimatedNewUsage > this.maxMemoryUsage) {
        logger.warn('MEMORY_PROTECTION', `⚠️  Cannot add transaction: would exceed memory limit`);
        return false;
      }
      
      return true;
    } catch (error) {
      logger.error('MEMORY_PROTECTION', `Transaction validation failed: ${error.message}`);
      return false;
    }
  }

  /**
   * CRITICAL: Get memory protection status
   */
  getMemoryStatus() {
    return {
      currentUsage: this.currentMemoryUsage,
      maxUsage: this.maxMemoryUsage,
      usagePercent: (this.currentMemoryUsage / this.maxMemoryUsage * 100).toFixed(2),
      maxTransactionSize: this.maxTransactionSize,
      maxPoolSize: this.maxPoolSize,
      memoryThreshold: this.memoryThreshold,
      warnings: this.memoryWarnings.length,
      lastCleanup: this.lastCleanup
    };
  }

  /**
   * CRITICAL: Update memory limits
   */
  updateMemoryLimits(newLimits) {
    if (newLimits.maxMemoryUsage) {
      this.maxMemoryUsage = newLimits.maxMemoryUsage;
    }
    if (newLimits.maxTransactionSize) {
      this.maxTransactionSize = newLimits.maxTransactionSize;
    }
    if (newLimits.maxPoolSize) {
      this.maxPoolSize = newLimits.maxPoolSize;
    }
    if (newLimits.memoryThreshold) {
      this.memoryThreshold = newLimits.memoryThreshold;
    }
    
    logger.info('MEMORY_PROTECTION', 'Memory protection limits updated');
  }
}

/**
 * Memory Pool Manager - Handles transaction pool management and batch processing
 */
class MemoryPoolManager {
  constructor() {
    this.pendingTransactions = [];
    
    // CRITICAL: Initialize memory protection
    this.memoryProtection = new MemoryProtection();
    
    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  /**
   * Clean up expired transactions from pending pool
   */
  cleanupExpiredTransactions() {
    const initialCount = this.pendingTransactions.length;

    this.pendingTransactions = this.pendingTransactions.filter(tx => {
      if (tx.isExpired && tx.isExpired()) {
        logger.debug('MEMORY_POOL', `Removing expired transaction ${tx.id} from pending pool`);
        return false;
      }
      return true;
    });

    const removedCount = initialCount - this.pendingTransactions.length;
    if (removedCount > 0) {
      logger.info('MEMORY_POOL', `Cleaned up ${removedCount} expired transactions from pending pool`);
    }

    return { cleaned: removedCount, remaining: this.pendingTransactions.length };
  }

  /**
   * Manage memory pool with size limits and priority
   */
  manageMemoryPool() {
    const maxPoolSize = 10000; // Maximum pending transactions
    const maxMemoryUsage = 100 * 1024 * 1024; // 100MB limit
    let actions = 0;

    // Check pool size limit
    if (this.pendingTransactions.length > maxPoolSize) {
      const excess = this.pendingTransactions.length - maxPoolSize;
      // Remove lowest priority transactions (lowest fee first)
      this.pendingTransactions.sort((a, b) => (a.fee || 0) - (b.fee || 0));
      this.pendingTransactions.splice(0, excess);
      logger.warn('MEMORY_POOL', `Memory pool size limit exceeded. Removed ${excess} low-priority transactions`);
      actions++;
    }

    // Check memory usage
    const currentMemoryUsage = this.estimateMemoryUsage();
    if (currentMemoryUsage > maxMemoryUsage) {
      // Remove oldest transactions to free memory
      this.pendingTransactions.sort((a, b) => a.timestamp - b.timestamp);
      const removedCount = Math.floor(this.pendingTransactions.length * 0.1); // Remove 10%
      this.pendingTransactions.splice(0, removedCount);
      logger.warn('MEMORY_POOL', `Memory usage limit exceeded. Removed ${removedCount} old transactions`);
      actions++;
    }

    // Implement transaction priority system
    this.pendingTransactions.sort((a, b) => {
      // Sort by fee (highest first), then by age (oldest first)
      const feeComparison = (b.fee || 0) - (a.fee || 0);
      if (feeComparison !== 0) return feeComparison;
      return a.timestamp - b.timestamp;
    });

    return { actions, poolSize: this.pendingTransactions.length, memoryUsage: this.estimateMemoryUsage() };
  }

  /**
   * Estimate memory usage of pending transactions
   */
  estimateMemoryUsage() {
    let totalSize = 0;
    for (const tx of this.pendingTransactions) {
      // Rough estimation: JSON string length + overhead
      totalSize += JSON.stringify(tx).length + 100; // 100 bytes overhead per transaction
    }
    return totalSize;
  }

  /**
   * Batch transaction validation
   */
  validateTransactionBatch(transactions, maxBatchSize = 100) {
    const results = {
      valid: [],
      invalid: [],
      errors: []
    };

    // Process in batches to avoid memory issues
    for (let i = 0; i < transactions.length; i += maxBatchSize) {
      const batch = transactions.slice(i, i + maxBatchSize);
      
      for (const tx of batch) {
        try {
          // Basic validation
          if (!tx || !tx.id) {
            results.invalid.push(tx);
            results.errors.push(`Transaction missing ID: ${JSON.stringify(tx).substring(0, 100)}`);
            continue;
          }

          // Check if already in pending pool
          if (this.pendingTransactions.some(pendingTx => pendingTx.id === tx.id)) {
            results.invalid.push(tx);
            results.errors.push(`Transaction ${tx.id} already exists in pending pool`);
            continue;
          }

          // Validate transaction structure
          if (!tx.isValid || typeof tx.isValid !== 'function') {
            results.invalid.push(tx);
            results.errors.push(`Transaction ${tx.id} missing isValid method`);
            continue;
          }

          // Check if valid
          if (tx.isValid()) {
            results.valid.push(tx);
          } else {
            results.invalid.push(tx);
            results.errors.push(`Transaction ${tx.id} failed validation`);
          }

        } catch (error) {
          results.invalid.push(tx);
          results.errors.push(`Transaction ${tx.id} validation error: ${error.message}`);
        }
      }
    }

    return results;
  }

  /**
   * CRITICAL: Add transaction with memory protection
   */
  addTransaction(transaction) {
    try {
      // Check memory limits before adding
      if (!this.memoryProtection.canAddTransaction(transaction)) {
        throw new Error('Transaction would exceed memory limits');
      }
      
      // Check pool size limits
      if (this.pendingTransactions.length >= this.memoryProtection.maxPoolSize) {
        throw new Error('Transaction pool is full');
      }
      
      // Validate transaction size
      const transactionSize = this.memoryProtection.validateTransactionSize(transaction);
      
      // Add transaction
      this.pendingTransactions.push(transaction);
      
      // Track transaction size for memory monitoring
      this.memoryProtection.transactionSizes.set(transaction.id, transactionSize);
      
      logger.debug('MEMORY_POOL', `Transaction ${transaction.id} added to pool (size: ${transactionSize} bytes)`);
      return true;
      
    } catch (error) {
      logger.error('MEMORY_POOL', `Failed to add transaction: ${error.message}`);
      return false;
    }
  }

  /**
   * Start periodic cleanup of expired transactions and memory management
   */
  startPeriodicCleanup() {
    // Clean up expired transactions every 5 minutes
    setInterval(() => {
      try {
        this.cleanupExpiredTransactions();
        this.manageMemoryPool();
      } catch (error) {
        logger.error('MEMORY_POOL', `Periodic cleanup failed: ${error.message}`);
      }
    }, 5 * 60 * 1000); // 5 minutes

    logger.info('MEMORY_POOL', 'Periodic cleanup started (every 5 minutes)');
  }

  /**
   * Remove transactions from pending pool
   */
  removeTransactions(transactions) {
    const txIds = transactions.map(tx => tx.id);
    this.pendingTransactions = this.pendingTransactions.filter(tx => !txIds.includes(tx.id));
  }

  /**
   * Get pending transactions
   */
  getPendingTransactions() {
    return this.pendingTransactions;
  }

  /**
   * Get pending transaction count
   */
  getPendingTransactionCount() {
    return this.pendingTransactions.length;
  }

  /**
   * Clear all pending transactions
   */
  clear() {
    this.pendingTransactions = [];
  }

  /**
   * Check if transaction exists in pool
   */
  hasTransaction(txId) {
    return this.pendingTransactions.some(tx => tx.id === txId);
  }

  /**
   * Get transaction by ID
   */
  getTransaction(txId) {
    return this.pendingTransactions.find(tx => tx.id === txId);
  }
}

module.exports = MemoryPoolManager;
