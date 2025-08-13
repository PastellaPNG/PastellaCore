const logger = require('../utils/logger');

/**
 * UTXO Manager - Handles all UTXO operations and validation
 */
class UTXOManager {
  constructor() {
    this.utxos = [];
    this.utxoSet = new Map(); // Map of UTXO: txHash:outputIndex -> {address, amount}
  }

  /**
   * Find a specific UTXO by transaction hash and output index
   */
  findUTXO(txHash, outputIndex) {
    for (const utxo of this.utxos) {
      if (utxo.txHash === txHash && utxo.outputIndex === outputIndex) {
        return utxo;
      }
    }
    return null;
  }

  /**
   * Check if a UTXO is already spent
   */
  isUTXOSpent(txHash, outputIndex) {
    // Check if this UTXO exists in our current UTXO set
    return !this.findUTXO(txHash, outputIndex);
  }

  /**
   * Update UTXO set when adding a block
   */
  updateUTXOSet(block) {
    block.transactions.forEach(transaction => {
      // Remove spent UTXOs
      transaction.inputs.forEach(input => {
        const utxoKey = `${input.txHash}:${input.outputIndex}`;
        this.utxoSet.delete(utxoKey);
      });

      // Add new UTXOs
      transaction.outputs.forEach((output, index) => {
        const utxoKey = `${transaction.id}:${index}`;
        this.utxoSet.set(utxoKey, {
          address: output.address,
          amount: output.amount,
          scriptPubKey: output.scriptPubKey
        });
      });
    });
  }

  /**
   * Rebuild UTXO set from entire chain
   */
  rebuildUTXOSet(chain) {
    this.utxoSet.clear();
    chain.forEach(block => {
      this.updateUTXOSet(block);
    });
  }

  /**
   * Clear all UTXOs (for testing/reset purposes)
   */
  clearUTXOs() {
    this.utxos = [];
    this.utxoSet.clear();
    logger.info('UTXO_MANAGER', 'All UTXOs cleared');
  }

  /**
   * Get balance for an address
   */
  getBalance(address) {
    let balance = 0;

    this.utxoSet.forEach(utxo => {
      if (utxo.address === address) {
        balance += utxo.amount;
      }
    });

    return balance;
  }

  /**
   * Get UTXOs for an address
   */
  getUTXOsForAddress(address) {
    const utxos = [];

    this.utxoSet.forEach((utxo, key) => {
      if (utxo.address === address) {
        const [txHash, outputIndex] = key.split(':');
        utxos.push({
          txHash,
          outputIndex: parseInt(outputIndex),
          amount: utxo.amount,
          scriptPubKey: utxo.scriptPubKey
        });
      }
    });

    return utxos;
  }

  /**
   * Clean up orphaned UTXOs that are no longer referenced
   */
  cleanupOrphanedUTXOs(chain) {
    const initialCount = this.utxos.length;
    let cleanedCount = 0;

    // Find orphaned UTXOs by checking if they're still referenced in the chain
    this.utxos = this.utxos.filter(utxo => {
      // Check if this UTXO is still valid by looking for the transaction in the chain
      const blockIndex = this.findBlockContainingTransaction(utxo.txHash, chain);
      if (blockIndex === -1) {
        // UTXO references a transaction that's not in the chain - orphaned
        logger.debug('UTXO_MANAGER', `Removing orphaned UTXO ${utxo.txHash}:${utxo.outputIndex}`);
        cleanedCount++;
        return false;
      }
      return true;
    });

    if (cleanedCount > 0) {
      logger.info('UTXO_MANAGER', `Cleaned up ${cleanedCount} orphaned UTXOs`);
    }

    return { cleaned: cleanedCount, remaining: this.utxos.length };
  }

  /**
   * Find block index containing a specific transaction
   */
  findBlockContainingTransaction(txHash, chain) {
    for (let i = 0; i < chain.length; i++) {
      const block = chain[i];
      if (block.transactions.some(tx => tx.id === txHash)) {
        return i;
      }
    }
    return -1; // Transaction not found in any block
  }

  /**
   * Get UTXO count
   */
  getUTXOCount() {
    return this.utxos.length;
  }

  /**
   * Add UTXO to the set
   */
  addUTXO(utxo) {
    this.utxos.push(utxo);
  }

  /**
   * Remove UTXO from the set
   */
  removeUTXO(txHash, outputIndex) {
    this.utxos = this.utxos.filter(utxo => 
      !(utxo.txHash === txHash && utxo.outputIndex === outputIndex)
    );
  }

  /**
   * Clear all UTXOs
   */
  clear() {
    this.utxos = [];
    this.utxoSet.clear();
  }
}

module.exports = UTXOManager;
