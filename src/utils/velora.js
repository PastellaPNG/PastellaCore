const crypto = require('crypto');

/**
 * Velora Algorithm - GPU-Optimized Memory Walker
 * ASIC-resistant algorithm using random memory access patterns
 */
class VeloraUtils {
  constructor() {
    // Velora parameters
    this.SCRATCHPAD_SIZE = 64 * 1024 * 1024; // 64MB
    this.MEMORY_READS = 1000;
    this.EPOCH_LENGTH = 10000; // Change pattern every 10000 blocks

    // GPU.js configuration
    this.GPU_CONFIG = {
      threads: 4096,
      batchSize: 100000,
      precision: 'single'
    };

    // Epoch scratchpad cache
    this._epochCache = new Map();
  }

  /** Fast 32-bit PRNG (xorshift32) */
  xorshift32(state) {
    state ^= (state << 13) >>> 0;
    state ^= (state >>> 17) >>> 0;
    state ^= (state << 5) >>> 0;
    return state >>> 0;
  }

  /** Derive 32-bit seed from a hex string */
  seedFromHex(hex) {
    const buf = Buffer.from(hex, 'hex');
    // Mix 4 words if available
    let s = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const v = buf.readUInt32LE(i % (buf.length - (buf.length % 4 || 4)));
      s = (s ^ v) >>> 0;
      s = this.xorshift32(s);
    }
    // Ensure non-zero
    return (s || 0x9e3779b9) >>> 0;
  }

  /**
   * Generate epoch seed for pattern generation
   * @param {number} blockNumber
   * @returns {string} hex seed
   */
  generateEpochSeed(blockNumber) {
    const epoch = Math.floor(blockNumber / this.EPOCH_LENGTH);
    const seed = `velora-epoch-${epoch}`;
    return crypto.createHash('sha256').update(seed).digest('hex');
  }

  /**
   * Generate scratchpad for the current epoch (PRNG-based, fast)
   * @param {string} epochSeed
   * @returns {Uint32Array} scratchpad data
   */
  generateScratchpad(epochSeed) {
    // Cache per-epoch
    if (this._epochCache.has(epochSeed)) {
      return this._epochCache.get(epochSeed);
    }

    const scratchpad = new Uint32Array(this.SCRATCHPAD_SIZE / 4);

    // Seed PRNG from epochSeed
    let state = this.seedFromHex(epochSeed);

    // Fast fill using xorshift32
    for (let i = 0; i < scratchpad.length; i++) {
      state = this.xorshift32(state);
      scratchpad[i] = state;
    }

    // Light mixing passes for extra diffusion
    this.mixScratchpad(scratchpad, epochSeed);

    // Cache
    this._epochCache.set(epochSeed, scratchpad);
    return scratchpad;
  }

  /**
   * Mix the scratchpad to increase entropy
   * @param {Uint32Array} scratchpad
   * @param {string} seed
   */
  mixScratchpad(scratchpad, seed) {
    const seedNum = parseInt(seed.substring(0, 8), 16) >>> 0;

    for (let round = 0; round < 2; round++) { // fewer rounds now that fill is random
      for (let i = 0; i < scratchpad.length; i++) {
        const mixIndex = (i + seedNum + round) % scratchpad.length;
        const mixValue = scratchpad[mixIndex];

        // 32-bit mixing
        let x = scratchpad[i] >>> 0;
        x = (x ^ mixValue) >>> 0;
        x = (x + ((mixValue << 13) >>> 0)) >>> 0;
        x = (x ^ (x >>> 17)) >>> 0;
        x = Math.imul(x, 0x5bd1e995) >>> 0;
        scratchpad[i] = x >>> 0;
      }
    }
  }

  /**
   * Generate memory access pattern for the current block (ENHANCED - PRNG-based, fast)
   * @param {string} headerHash - Hash of the block header
   * @param {number} nonce - Mining nonce for proof-of-work
   * @param {number} timestamp - Block creation timestamp in milliseconds
   * @param {string} previousHash - Hash of the previous block
   * @param {string} merkleRoot - Merkle root of all transactions
   * @param {number} difficulty - Current network difficulty target
   * @returns {number[]} array of memory indices
   */
  generateMemoryPattern(headerHash, nonce, timestamp, previousHash, merkleRoot, difficulty) {
    const pattern = new Array(this.MEMORY_READS);

    // ENHANCED: Seed PRNG from ALL input parameters as specified in VELORA_ALGO.md
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce), 0);

    const timestampBuf = Buffer.alloc(8);
    timestampBuf.writeBigUInt64LE(BigInt(timestamp), 0);

    const difficultyBuf = Buffer.alloc(4);
    difficultyBuf.writeUInt32LE(difficulty, 0);

    // ENHANCED: Include all parameters in seed data as per specification
    const seedData = Buffer.concat([
      Buffer.from(headerHash, 'hex'),
      nonceBuf,
      timestampBuf,
      Buffer.from(previousHash, 'hex'),
      Buffer.from(merkleRoot, 'hex'),
      difficultyBuf
    ]);

    const seedHex = crypto.createHash('sha256').update(seedData).digest('hex');
    let state = this.seedFromHex(seedHex);

    const words = this.SCRATCHPAD_SIZE >>> 2;
    for (let i = 0; i < this.MEMORY_READS; i++) {
      state = this.xorshift32(state);
      pattern[i] = state % words;
    }

    return pattern;
  }

  /**
   * Execute memory walk and generate hash (ENHANCED)
   * @param {Uint32Array} scratchpad
   * @param {number[]} pattern
   * @param {string} headerHash
   * @param {number} nonce
   * @param {number} timestamp
   * @returns {string} final hash
   */
  executeMemoryWalk(scratchpad, pattern, headerHash, nonce, timestamp) {
    let accumulator = 0 >>> 0;
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(BigInt(nonce), 0);

    // ENHANCED: Add timestamp buffer for mixing
    const timestampBuffer = Buffer.alloc(8);
    timestampBuffer.writeBigUInt64LE(BigInt(timestamp), 0);

    // Walk through memory according to pattern
    for (let i = 0; i < pattern.length; i++) {
      const index = pattern[i];
      const value = scratchpad[index] >>> 0;

      // Mix operations with 32-bit unsigned arithmetic
      accumulator = (accumulator ^ value) >>> 0;
      accumulator = (accumulator + ((value << (i % 32)) >>> 0)) >>> 0;
      accumulator = (accumulator ^ (accumulator >>> 13)) >>> 0;
      accumulator = Math.imul(accumulator, 0x5bd1e995) >>> 0;

      // ENHANCED: Add nonce influence (two 32-bit words of the 64-bit nonce)
      const nonceWord = nonceBuffer.readUInt32LE((i % 2) * 4);
      accumulator = (accumulator ^ nonceWord) >>> 0;

      // ENHANCED: Add timestamp influence (two 32-bit words of the 64-bit timestamp)
      const timestampWord = timestampBuffer.readUInt32LE((i % 2) * 4);
      accumulator = (accumulator ^ timestampWord) >>> 0;
    }

    return accumulator;
  }

  /**
   * Main Velora hash function (ENHANCED - matches VELORA_ALGO.md specification)
   * @param {number} blockNumber - Block height in the blockchain
   * @param {string} headerHash - Hash of the block header
   * @param {number} nonce - Mining nonce for proof-of-work
   * @param {number} timestamp - Block creation timestamp in milliseconds
   * @param {string} previousHash - Hash of the previous block
   * @param {string} merkleRoot - Merkle root of all transactions
   * @param {number} difficulty - Current network difficulty target
   * @param {Uint32Array} cache - optional, will generate if not provided
   * @returns {string} final hash
   */
  veloraHash(blockNumber, headerHash, nonce, timestamp, previousHash, merkleRoot, difficulty, cache = null) {
    try {
      // Generate epoch seed
      const epochSeed = this.generateEpochSeed(blockNumber);

      // Generate or use provided scratchpad (cached per-epoch)
      const scratchpad = cache || this.generateScratchpad(epochSeed);

      // ENHANCED: Generate memory access pattern with ALL parameters
      const pattern = this.generateMemoryPattern(headerHash, nonce, timestamp, previousHash, merkleRoot, difficulty);

      // ENHANCED: Execute memory walk with timestamp parameter
      const accumulator = this.executeMemoryWalk(scratchpad, pattern, headerHash, nonce, timestamp);

      // ENHANCED: Final hash with ALL parameters as per specification
      const finalHash = this.generateFinalHash(headerHash, nonce, timestamp, previousHash, merkleRoot, difficulty, accumulator);

      return finalHash;
    } catch (error) {
      throw new Error(`Velora hash generation failed: ${error.message}`);
    }
  }

  /**
   * ENHANCED: Generate final hash with all parameters as specified in VELORA_ALGO.md
   * @param {string} headerHash
   * @param {number} nonce
   * @param {number} timestamp
   * @param {string} previousHash
   * @param {string} merkleRoot
   * @param {number} difficulty
   * @param {number} accumulator
   * @returns {string} final hash
   */
  generateFinalHash(headerHash, nonce, timestamp, previousHash, merkleRoot, difficulty, accumulator) {
    // ENHANCED: Include ALL parameters in final hash as per specification
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(BigInt(nonce), 0);

    const timestampBuffer = Buffer.alloc(8);
    timestampBuffer.writeBigUInt64LE(BigInt(timestamp), 0);

    const difficultyBuffer = Buffer.alloc(4);
    difficultyBuffer.writeUInt32LE(difficulty, 0);

    const accumulatorBuffer = Buffer.alloc(4);
    accumulatorBuffer.writeUInt32LE(accumulator >>> 0, 0);

    // ENHANCED: Final data includes ALL parameters as specified
    const finalData = Buffer.concat([
      Buffer.from(headerHash, 'hex'),
      nonceBuffer,
      timestampBuffer,
      Buffer.from(previousHash, 'hex'),
      Buffer.from(merkleRoot, 'hex'),
      difficultyBuffer,
      accumulatorBuffer
    ]);

    const finalHash = crypto.createHash('sha256').update(finalData).digest();
    return finalHash.toString('hex');
  }

  /**
   * Verify a Velora hash (ENHANCED - matches new signature)
   * @param {number} blockNumber
   * @param {string} headerHash
   * @param {number} nonce
   * @param {number} timestamp
   * @param {string} previousHash
   * @param {string} merkleRoot
   * @param {number} difficulty
   * @param {string} targetHash
   * @param {Uint32Array} cache - optional
   * @returns {boolean} true if valid
   */
  verifyHash(blockNumber, headerHash, nonce, timestamp, previousHash, merkleRoot, difficulty, targetHash, cache = null) {
    try {
      const calculatedHash = this.veloraHash(blockNumber, headerHash, nonce, timestamp, previousHash, merkleRoot, difficulty, cache);
      return calculatedHash === targetHash;
    } catch (error) {
      return false;
    }
  }

  /**
   * Calculate target from difficulty
   * @param {number} difficulty
   * @returns {string} target hash
   */
  calculateTarget(difficulty) {
    const maxTarget = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const target = maxTarget / BigInt(difficulty);
    return target.toString(16).padStart(64, '0');
  }

  /**
   * Check if hash meets difficulty
   * @param {string} hash
   * @param {number} difficulty
   * @returns {boolean} true if meets difficulty
   */
  meetsDifficulty(hash, difficulty) {
    const target = this.calculateTarget(difficulty);
    return BigInt(`0x${hash}`) <= BigInt(`0x${target}`);
  }

  /**
   * Get algorithm info
   * @returns {object} algorithm information
   */
  getAlgorithmInfo() {
    return {
      name: 'Velora',
      version: '1.0.0',
      scratchpadSize: this.SCRATCHPAD_SIZE,
      memoryReads: this.MEMORY_READS,
      epochLength: this.EPOCH_LENGTH,
      description: 'GPU-Optimized Memory Walker - ASIC Resistant (Enhanced Security)',
      enhancedFeatures: [
        'Timestamp validation',
        'Previous hash validation',
        'Merkle root validation',
        'Difficulty validation',
        'Enhanced input parameter security'
      ]
    };
  }

  /**
   * ENHANCED: Backward compatibility wrapper for existing code
   * @param {number} blockNumber
   * @param {string} headerHash
   * @param {number} nonce
   * @param {Uint32Array} cache
   * @returns {string} final hash
   * @deprecated Use veloraHash with all parameters for enhanced security
   */
  veloraHashLegacy(blockNumber, headerHash, nonce, cache = null) {
    console.warn('WARNING: Using legacy Velora hash function. For enhanced security, use veloraHash with all parameters.');

    // Use default values for missing parameters (less secure)
    const timestamp = Date.now();
    const previousHash = '0'.repeat(64); // Genesis-like default
    const merkleRoot = '0'.repeat(64);   // Genesis-like default
    const difficulty = 1000;              // Default difficulty

    return this.veloraHash(blockNumber, headerHash, nonce, timestamp, previousHash, merkleRoot, difficulty, cache);
  }
}

module.exports = VeloraUtils;
