const Block = require('../models/Block');
const { Transaction } = require('../models/Transaction');

/**
 *
 */
class Miner {
  /**
   *
   * @param blockchain
   * @param wallet
   */
  constructor(blockchain, wallet) {
    this.blockchain = blockchain;
    this.wallet = wallet;
    this.miningAddress = null; // Custom mining address
    this.isMining = false;
    this.currentBlock = null;
    this.hashRate = 0;
    this.totalHashes = 0;
    this.startTime = null;
    this.miningInterval = null;
    this.difficulty = blockchain.difficulty || 4;
    this.maxNonce = 4294967295;
    this.debugMode = false;
  }

  /**
   * Set custom mining address
   * @param address
   */
  setMiningAddress(address) {
    this.miningAddress = address;
    console.log(`Mining address set to: ${address}`);
  }

  /**
   * Get current mining address
   */
  getMiningAddress() {
    return this.miningAddress || this.wallet.getAddress();
  }

  /**
   * Toggle debug mode
   */
  toggleDebugMode() {
    this.debugMode = !this.debugMode;
    return this.debugMode;
  }

  /**
   * Set debug mode
   * @param enabled
   */
  setDebugMode(enabled) {
    this.debugMode = enabled;
    return this.debugMode;
  }

  /**
   * Verify block validity
   * @param block
   */
  verifyBlock(block) {
    try {
      // Verify block structure
      if (!block || typeof block !== 'object') {
        console.log('Invalid block structure');
        return false;
      }

      // Verify required fields
      const requiredFields = [
        'index',
        'timestamp',
        'previousHash',
        'hash',
        'nonce',
        'difficulty',
        'merkleRoot',
        'transactions',
      ];
      for (const field of requiredFields) {
        if (!(field in block)) {
          console.log(`Missing required field: ${field}`);
          return false;
        }
      }

      // Verify hash
      const calculatedHash = block.calculateHash();
      if (calculatedHash !== block.hash) {
        console.log('Block hash verification failed');
        return false;
      }

      // Verify difficulty
      const target = block.calculateTarget();
      const hashNum = BigInt(`0x${block.hash}`);
      const targetNum = BigInt(`0x${target}`);
      if (hashNum > targetNum) {
        console.log('Block does not meet difficulty requirement');
        return false;
      }

      // Verify transactions
      if (!Array.isArray(block.transactions) || block.transactions.length === 0) {
        console.log('Block must contain at least one transaction');
        return false;
      }

      // Verify first transaction is coinbase
      const coinbaseTx = block.transactions[0];
      if (!coinbaseTx || !coinbaseTx.isCoinbase) {
        console.log('First transaction must be coinbase');
        return false;
      }

      // Verify Merkle root
      const calculatedMerkleRoot = block.calculateMerkleRoot();
      if (calculatedMerkleRoot !== block.merkleRoot) {
        console.log('Merkle root verification failed');
        return false;
      }

      console.log(`Block ${block.index} verification passed`);
      return true;
    } catch (error) {
      console.error('Error verifying block:', error.message);
      return false;
    }
  }

  /**
   * Start mining
   */
  startMining() {
    if (this.isMining) {
      console.log('Mining is already running');
      return false;
    }

    const miningAddress = this.getMiningAddress();
    if (!miningAddress) {
      console.log('No mining address available');
      return false;
    }

    this.isMining = true;
    this.startTime = Date.now();
    this.totalHashes = 0;
    console.log(`Mining started with address: ${miningAddress}`);

    // Start mining loop
    this.mineNextBlock();

    return true;
  }

  /**
   * Stop mining
   */
  stopMining() {
    if (!this.isMining) {
      return false;
    }

    this.isMining = false;
    this.currentBlock = null;

    if (this.miningInterval) {
      clearInterval(this.miningInterval);
      this.miningInterval = null;
    }

    console.log('Mining stopped');
    return true;
  }

  /**
   * Mine the next block
   */
  mineNextBlock() {
    if (!this.isMining) return;

    try {
      // Create new block with pending transactions
      const latestBlock = this.blockchain.getLatestBlock();
      const pendingTransactions = this.blockchain.pendingTransactions.slice(0, 100);

      // Add coinbase transaction with custom mining address
      const coinbaseTransaction = Transaction.createCoinbase(this.getMiningAddress(), this.blockchain.miningReward);

      const transactions = [coinbaseTransaction, ...pendingTransactions];

      this.currentBlock = Block.createBlock(
        latestBlock.index + 1,
        transactions,
        latestBlock.hash,
        this.blockchain.difficulty
      );

      if (this.debugMode) {
        console.log(`\n⛏️  Starting to mine block #${this.currentBlock.index}`);
        console.log(`📊 Transactions: ${transactions.length}`);
        console.log(`🎯 Target: ${this.currentBlock.calculateTarget()}...`);
        console.log(`💰 Mining reward: ${this.blockchain.miningReward} PAS`);
        console.log(`📍 Mining address: ${this.getMiningAddress()}`);
      } else {
        console.log(`⛏️  Mining block #${this.currentBlock.index}...`);
      }

      // Start mining process
      this.mineBlock();
    } catch (error) {
      console.log('Error creating mining block:', error.message);
      this.stopMining();
    }
  }

  /**
   * Mine the current block
   */
  mineBlock() {
    if (!this.isMining || !this.currentBlock) return;

    const target = this.currentBlock.calculateTarget();
    const attempts = 0;
    const batchSize = 1000; // Process in batches for better performance

    const mineBatch = () => {
      if (!this.isMining || !this.currentBlock) return;

      for (let i = 0; i < batchSize; i++) {
        this.currentBlock.nonce++;
        this.currentBlock.calculateHash();
        this.totalHashes++;

        // Compare hash as hex number with target
        const hashNum = BigInt(`0x${this.currentBlock.hash}`);
        const targetNum = BigInt(`0x${target}`);

        if (hashNum <= targetNum) {
          // Block found!
          console.log('\n🎉 BLOCK MINED! 🎉');
          console.log('═══════════════════════════════════════════════════════════════');
          console.log(`📦 Block #${this.currentBlock.index}`);
          console.log(`🔗 Hash: ${this.currentBlock.hash}`);
          console.log(`🔢 Nonce: ${this.currentBlock.nonce}`);
          console.log(`⚡ Total Attempts: ${this.totalHashes.toLocaleString()}`);
          console.log(`⏱️  Time: ${new Date().toLocaleTimeString()}`);
          console.log(`🔍 Hash as number: ${hashNum}`);
          console.log(`🔍 Target as number: ${targetNum}`);
          console.log(`🔍 Hash <= Target: ${hashNum <= targetNum}`);
          console.log('═══════════════════════════════════════════════════════════════\n');

          // Verify block before adding
          if (this.verifyBlock(this.currentBlock)) {
            // Add block to blockchain
            if (this.blockchain.addBlock(this.currentBlock)) {
              console.log('✅ Block added to blockchain');

              // Update wallet balance
              this.wallet.updateBalance(this.blockchain);

              // Update miner difficulty to match blockchain
              this.difficulty = this.blockchain.difficulty;

              // Start mining next block
              setTimeout(() => this.mineNextBlock(), 1000);
            } else {
              console.log('❌ Failed to add block to blockchain');
              this.stopMining();
            }
          } else {
            console.log('❌ Block verification failed, restarting mining');
            setTimeout(() => this.mineNextBlock(), 1000);
          }
          return;
        }

        // Prevent nonce overflow
        if (this.currentBlock.nonce >= this.maxNonce) {
          console.log('Nonce overflow, restarting with new timestamp');
          this.currentBlock.timestamp = Date.now();
          this.currentBlock.nonce = 0;
        }
      }

      // Continue mining with a small delay to prevent overwhelming the system
      setTimeout(mineBatch, 1);
    };

    mineBatch();
  }

  /**
   * Get current hashrate
   */
  getHashRate() {
    if (!this.startTime) return 0;

    const elapsed = (Date.now() - this.startTime) / 1000; // seconds
    return elapsed > 0 ? Math.round(this.totalHashes / elapsed) : 0;
  }

  /**
   * Get mining statistics
   */
  getMiningStats() {
    const hashrate = this.getHashRate();
    const elapsed = this.startTime ? (Date.now() - this.startTime) / 1000 : 0;

    return {
      isMining: this.isMining,
      miningAddress: this.getMiningAddress(),
      currentBlock: this.currentBlock
        ? {
            index: this.currentBlock.index,
            nonce: this.currentBlock.nonce,
            hash: this.currentBlock.hash,
          }
        : null,
      hashrate,
      totalHashes: this.totalHashes,
      elapsed: Math.round(elapsed),
      difficulty: this.blockchain.difficulty,
      target: this.currentBlock
        ? this.currentBlock.calculateTarget()
        : this.blockchain.difficulty
          ? new (require('../models/Block'))(0, Date.now(), [], '0', 0, this.blockchain.difficulty).calculateTarget()
          : '0'.repeat(this.difficulty),
    };
  }

  /**
   * Set mining difficulty
   * @param difficulty
   */
  setDifficulty(difficulty) {
    this.difficulty = Math.max(1, difficulty);
    console.log(`Mining difficulty set to ${this.difficulty}`);
  }

  /**
   * Get estimated time to find block
   */
  getEstimatedBlockTime() {
    const hashrate = this.getHashRate();
    if (hashrate === 0) return 'Unknown';

    // Use the new difficulty calculation
    const maxTarget = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const targetNum = maxTarget / BigInt(this.difficulty);
    const estimatedAttempts = Number(targetNum) / 2; // Average attempts needed
    const estimatedSeconds = estimatedAttempts / hashrate;

    if (estimatedSeconds < 60) {
      return `${Math.round(estimatedSeconds)} seconds`;
    }
    if (estimatedSeconds < 3600) {
      return `${Math.round(estimatedSeconds / 60)} minutes`;
    }
    return `${Math.round(estimatedSeconds / 3600)} hours`;
  }

  /**
   * Get mining profitability estimate
   */
  getProfitabilityEstimate() {
    const hashrate = this.getHashRate();
    const blockReward = this.blockchain.miningReward;
    const estimatedBlockTime = this.getEstimatedBlockTime();

    if (hashrate === 0) return 'Unknown';

    // Very rough estimate - in reality would need to consider network difficulty
    const blocksPerDay = 24 * 60; // Assuming 1 minute block time
    const dailyReward = blocksPerDay * blockReward;

    return {
      hashrate,
      estimatedBlockTime,
      dailyReward,
      blockReward,
    };
  }

  /**
   * Pause mining temporarily
   */
  pauseMining() {
    if (this.isMining) {
      this.isMining = false;
      console.log('Mining paused');
    }
  }

  /**
   * Resume mining
   */
  resumeMining() {
    if (!this.isMining && this.currentBlock) {
      this.isMining = true;
      console.log('Mining resumed');
      this.mineBlock();
    }
  }
}

module.exports = Miner;
