const logger = require('../utils/logger');

/**
 * Memory Pool Manager - Handles transaction pool management and batch processing
 */
class MemoryPoolManager {
  constructor() {
    this.pendingTransactions = [];
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
   * Add transaction to pending pool
   */
  addTransaction(transaction) {
    this.pendingTransactions.push(transaction);
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
