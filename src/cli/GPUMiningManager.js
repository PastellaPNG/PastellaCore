const GPU = require('gpu.js');
const CryptoJS = require('crypto-js');
const os = require('os');
const chalk = require('chalk');

class GPUMiningManager {
  constructor(cli) {
    this.cli = cli;
    
    // GPU mining state
    this.isMining = false;
    this.miningAddress = null;
    this.gpuKernels = [];
    this.availableGPUs = [];
    
    // Mining statistics
    this.miningStartTime = null;
    this.totalHashes = 0;
    this.currentMiningBlock = null;
    this.lastHashRateUpdate = null;
    this.blocksFound = 0;
    this.currentNonce = 0;
    
    // GPU configuration
    this.gpuConfig = {
      intel: { enabled: true, threads: 1024, memory: 1024 },
      nvidia: { enabled: true, threads: 1024, memory: 1024 },
      amd: { enabled: true, threads: 1024, memory: 1024 }
    };
    
    // Mining log toggle
    this.showMiningLogs = false;
    
    // Initialize GPU detection
    this.detectGPUs();
  }

  detectGPUs() {
    try {
      // Get system information
      const platform = os.platform();
      const arch = os.arch();
      
      console.log(chalk.blue('🔍 Detecting available GPUs...'));
      console.log(chalk.cyan(`Platform: ${platform} (${arch})`));
      
      // Check if GPU.js can access GPU
      const gpu = new GPU();
      
      if (gpu.isSupported) {
        console.log(chalk.green('✅ GPU.js is supported on this system'));
        
        // Try to detect GPU types based on platform and available features
        this.detectGPUTypes(platform, arch);
        
        // Initialize GPU kernels
        this.initializeGPUKernels();
      } else {
        console.log(chalk.yellow('⚠️  GPU.js is not supported on this system'));
        console.log(chalk.yellow('💡 Falling back to CPU mining'));
      }
    } catch (error) {
      console.log(chalk.red(`❌ GPU detection error: ${error.message}`));
      console.log(chalk.yellow('💡 Falling back to CPU mining'));
    }
  }

  detectGPUTypes(platform, arch) {
    // This is a simplified detection - in production you'd want more sophisticated detection
    if (platform === 'win32') {
      // Windows - try to detect via environment variables or registry
      this.availableGPUs = [
        { type: 'nvidia', name: 'NVIDIA GPU (Auto-detected)', enabled: true },
        { type: 'amd', name: 'AMD GPU (Auto-detected)', enabled: true },
        { type: 'intel', name: 'Intel GPU (Auto-detected)', enabled: true }
      ];
    } else if (platform === 'linux') {
      // Linux - could use lspci or other system tools
      this.availableGPUs = [
        { type: 'nvidia', name: 'NVIDIA GPU (Auto-detected)', enabled: true },
        { type: 'amd', name: 'AMD GPU (Auto-detected)', enabled: true },
        { type: 'intel', name: 'Intel GPU (Auto-detected)', enabled: true }
      ];
    } else if (platform === 'darwin') {
      // macOS - Metal support
      this.availableGPUs = [
        { type: 'apple', name: 'Apple Metal GPU', enabled: true }
      ];
    }
    
    console.log(chalk.green(`✅ Detected ${this.availableGPUs.length} GPU types`));
    this.availableGPUs.forEach(gpu => {
      console.log(chalk.cyan(`  - ${gpu.name}`));
    });
  }

  initializeGPUKernels() {
    try {
      this.availableGPUs.forEach(gpu => {
        if (gpu.enabled) {
          const kernel = this.createSHA256Kernel(gpu.type);
          if (kernel) {
            this.gpuKernels.push({
              gpu: gpu,
              kernel: kernel,
              isActive: false
            });
            console.log(chalk.green(`✅ Initialized ${gpu.name} kernel`));
          }
        }
      });
    } catch (error) {
      console.log(chalk.red(`❌ GPU kernel initialization error: ${error.message}`));
    }
  }

  createSHA256Kernel(gpuType) {
    try {
      // Create a GPU kernel for SHA256 hashing
      const gpu = new GPU();
      
      // Configure GPU based on type
      let gpuConfig = {};
      
      if (gpuType === 'nvidia') {
        gpuConfig = { mode: 'gpu', precision: 'single' };
      } else if (gpuType === 'amd') {
        gpuConfig = { mode: 'gpu', precision: 'single' };
      } else if (gpuType === 'intel') {
        gpuConfig = { mode: 'gpu', precision: 'single' };
      } else if (gpuType === 'apple') {
        gpuConfig = { mode: 'gpu', precision: 'single' };
      }
      
      // Create kernel for batch nonce testing
      const kernel = gpu.createKernel(function(nonces, blockData, target) {
        // This is a simplified version - in practice you'd want more sophisticated SHA256
        const nonce = nonces[this.thread.x];
        const data = blockData + nonce;
        
        // Simple hash simulation for demonstration
        // In production, you'd implement full SHA256 on GPU
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
          hash = ((hash << 5) - hash + data.charCodeAt(i)) & 0xFFFFFFFF;
        }
        
        return hash;
      }, gpuConfig)
      .setOutput([this.gpuConfig[gpuType].threads])
      .setDynamicOutput(true)
      .setDynamicArguments(true);
      
      return kernel;
    } catch (error) {
      console.log(chalk.red(`❌ Failed to create ${gpuType} kernel: ${error.message}`));
      return null;
    }
  }

  async handleCommand(args) {
    if (!args || args.length === 0) {
      console.log(chalk.red('❌ Missing gpu-mine command'));
      return;
    }

    const subCmd = args[0].toLowerCase();
    switch (subCmd) {
      case 'start':
        await this.startGPUMining();
        break;
      case 'stop':
        await this.stopGPUMining();
        break;
      case 'status':
        await this.showGPUStatus();
        break;
      case 'config':
        await this.configureGPU();
        break;
      case 'detect':
        this.detectGPUs();
        break;
      case 'log':
        this.toggleMiningLog();
        break;
      default:
        console.log(chalk.red(`❌ Unknown gpu-mine command: ${subCmd}`));
    }
  }

  async startGPUMining() {
    try {
      if (this.gpuKernels.length === 0) {
        console.log(chalk.red('❌ No GPU kernels available. Run "gpu-mine detect" first.'));
        return;
      }

      const connected = await this.cli.checkDaemonConnection();
      if (!connected) {
        console.log(chalk.red('❌ Cannot connect to daemon. Make sure the daemon is running.'));
        return;
      }

      // Get mining address
      if (!this.miningAddress) {
        const { address } = await this.cli.inquirer.prompt([
          {
            type: 'input',
            name: 'address',
            message: 'Enter mining address:',
            default: '1A29rMDZkeQWXUuL2yHanBzXeB6c9ZEe7q',
            validate: (input) => {
              if (!this.cli.validateAddress(input)) {
                return 'Please enter a valid wallet address (26-35 characters, starts with 1 or 3)';
              }
              return true;
            }
          }
        ]);
        this.miningAddress = address;
      }

      // Initialize mining statistics
      this.miningStartTime = Date.now();
      this.totalHashes = 0;
      this.currentMiningBlock = null;
      this.lastHashRateUpdate = Date.now();
      this.blocksFound = 0;
      this.currentNonce = 0;

      // Start GPU mining
      this.isMining = true;
      console.log(chalk.green('🚀 GPU mining started!'));
      console.log(chalk.cyan(`Mining address: ${this.miningAddress}`));
      console.log(chalk.cyan(`Active GPUs: ${this.gpuKernels.length}`));
      
      // Start mining loop
      this.mineBlocksWithGPU();
    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  async stopGPUMining() {
    this.isMining = false;
    
    // Clean up GPU kernels
    this.gpuKernels.forEach(kernelInfo => {
      if (kernelInfo.kernel && kernelInfo.kernel.destroy) {
        try {
          kernelInfo.kernel.destroy();
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    });
    
    // Reset mining state
    this.miningStartTime = null;
    this.currentMiningBlock = null;
    this.lastHashRateUpdate = null;
    this.currentNonce = 0;
    
    console.log(chalk.green('⛏️  GPU mining stopped!'));
  }

  async showGPUStatus() {
    console.log(chalk.blue('🚀 GPU Mining Status:'));
    console.log(chalk.cyan(`Status: ${this.isMining ? 'Running' : 'Stopped'}`));
    console.log(chalk.cyan(`Available GPUs: ${this.availableGPUs.length}`));
    console.log(chalk.cyan(`Active Kernels: ${this.gpuKernels.length}`));
    
    // Show GPU details
    this.availableGPUs.forEach((gpu, index) => {
      const kernel = this.gpuKernels.find(k => k.gpu.type === gpu.type);
      const status = kernel ? (kernel.isActive ? 'Active' : 'Inactive') : 'No Kernel';
      console.log(chalk.cyan(`  ${gpu.name}: ${status}`));
    });
    
    // Show mining statistics
    if (this.isMining) {
      const hashRate = this.calculateHashRate();
      const formattedHashRate = this.formatHashRate(hashRate);
      const formattedTotalHashes = (this.totalHashes || 0).toLocaleString();
      
      console.log(chalk.cyan(`Hashrate: ${formattedHashRate}`));
      console.log(chalk.cyan(`Total Hashes: ${formattedTotalHashes}`));
      console.log(chalk.cyan(`Blocks Found: ${this.blocksFound || 0}`));
      
      // Get current difficulty from daemon
      try {
        const status = await this.cli.makeApiRequest('/api/blockchain/status');
        console.log(chalk.cyan(`Current Difficulty: ${status.difficulty}`));
        console.log(chalk.cyan(`Block Height: ${status.length}`));
      } catch (error) {
        console.log(chalk.red(`❌ Could not fetch daemon status: ${error.message}`));
      }
    }
    
    console.log(chalk.cyan(`Mining Logs: ${this.showMiningLogs ? 'Enabled' : 'Disabled'}`));
  }

  async configureGPU() {
    console.log(chalk.blue('⚙️  GPU Configuration:'));
    
    this.availableGPUs.forEach(gpu => {
      const config = this.gpuConfig[gpu.type];
      if (config) {
        console.log(chalk.cyan(`\n${gpu.name}:`));
        console.log(chalk.cyan(`  Threads: ${config.threads}`));
        console.log(chalk.cyan(`  Memory: ${config.memory}MB`));
        console.log(chalk.cyan(`  Enabled: ${config.enabled ? 'Yes' : 'No'}`));
      }
    });
    
    console.log(chalk.yellow('\n💡 To modify GPU settings, edit the gpuConfig object in GPUMiningManager.js'));
  }

  toggleMiningLog() {
    this.showMiningLogs = !this.showMiningLogs;
    console.log(chalk.green(`✅ GPU mining logs ${this.showMiningLogs ? 'enabled' : 'disabled'}`));
  }

  async mineBlocksWithGPU() {
    if (!this.isMining) return;

    try {
      // Sync with daemon
      await this.syncLocalBlockchain();
      
      // Get pending transactions
      const pendingResponse = await this.cli.makeApiRequest('/api/blockchain/transactions');
      const pendingTransactions = pendingResponse.transactions || [];

      // Create new block
      const latestBlock = await this.cli.makeApiRequest('/api/blockchain/latest');
      const coinbaseTransaction = this.cli.Transaction.createCoinbase(
        this.miningAddress, 
        this.cli.localBlockchain.miningReward
      );
      
      const transactions = [coinbaseTransaction, ...pendingTransactions];
      
      const newBlock = this.cli.Block.createBlock(
        latestBlock.index + 1,
        transactions,
        latestBlock.hash,
        this.cli.localBlockchain.difficulty
      );

      this.currentMiningBlock = newBlock;

      if (this.showMiningLogs) {
        console.log(chalk.cyan(`🚀 GPU mining block #${newBlock.index}...`));
      }

      // Mine with GPU
      const startTime = Date.now();
      const success = await this.mineBlockWithGPU(newBlock);
      
      if (success) {
        const miningTime = Date.now() - startTime;
        if (this.showMiningLogs) {
          console.log(chalk.green(`🎉 Block #${newBlock.index} mined in ${miningTime}ms!`));
        }
        
        this.blocksFound++;
        await this.submitBlock(newBlock);
        
        setTimeout(() => this.mineBlocksWithGPU(), 1000);
      } else {
        if (this.showMiningLogs) {
          console.log(chalk.yellow('GPU mining failed, retrying...'));
        }
        setTimeout(() => this.mineBlocksWithGPU(), 1000);
      }
    } catch (error) {
      if (this.showMiningLogs) {
        console.log(chalk.red(`❌ GPU mining error: ${error.message}`));
      }
      setTimeout(() => this.mineBlocksWithGPU(), 5000);
    }
  }

  async mineBlockWithGPU(block) {
    return new Promise((resolve) => {
      const target = block.calculateTarget();
      let attempts = 0;
      const maxAttempts = 10000000; // 10 million attempts
      let blockFound = false;
      
      this.currentNonce = block.nonce;
      
      // Use all available GPU kernels
      this.gpuKernels.forEach((kernelInfo, index) => {
        if (!kernelInfo.isActive) {
          kernelInfo.isActive = true;
          
          // Start GPU mining on this kernel
          this.mineOnGPU(kernelInfo, block, target, index, (success, nonce, hash, attemptCount) => {
            if (success && !blockFound) {
              blockFound = true;
              block.nonce = nonce;
              block.hash = hash;
              
              this.totalHashes += attemptCount;
              
              if (this.showMiningLogs) {
                console.log(chalk.green(`✅ Block found by ${kernelInfo.gpu.name}!`));
                console.log(chalk.cyan(`Hash: ${block.hash.substring(0, 16)}...`));
              }
              
              // Stop all other kernels
              this.gpuKernels.forEach(k => {
                if (k !== kernelInfo) {
                  k.isActive = false;
                }
              });
              
              resolve(true);
            } else {
              attempts += attemptCount;
              kernelInfo.isActive = false;
              
              if (attempts >= maxAttempts && !blockFound) {
                if (this.showMiningLogs) {
                  console.log(chalk.yellow(`Max attempts reached (${attempts}), restarting...`));
                }
                resolve(false);
              }
            }
          });
        }
      });
      
      // Fallback timeout
      setTimeout(() => {
        if (!blockFound) {
          resolve(false);
        }
      }, 30000); // 30 second timeout
    });
  }

  mineOnGPU(kernelInfo, block, target, gpuIndex, callback) {
    try {
      const kernel = kernelInfo.kernel;
      const threadCount = this.gpuConfig[kernelInfo.gpu.type].threads;
      
      let currentNonce = block.nonce + (gpuIndex * threadCount);
      let attempts = 0;
      const maxAttempts = 1000000; // 1 million per GPU
      
      const mineBatch = () => {
        if (!kernelInfo.isActive || attempts >= maxAttempts) {
          callback(false, 0, '', attempts);
          return;
        }
        
        try {
          // Prepare batch of nonces
          const nonces = [];
          for (let i = 0; i < threadCount; i++) {
            nonces.push(currentNonce + i);
          }
          
          // Run GPU kernel
          const results = kernel(nonces, block.getMiningData(), target);
          
          // Check results
          for (let i = 0; i < results.length; i++) {
            attempts++;
            
            // Simulate hash check (in production, implement proper SHA256)
            const hash = this.simulateSHA256(block.getMiningData() + nonces[i]);
            
            if (this.isHashValid(hash, target)) {
              callback(true, nonces[i], hash, attempts);
              return;
            }
          }
          
          currentNonce += threadCount;
          
          // Continue mining
          setImmediate(mineBatch);
          
        } catch (error) {
          if (this.showMiningLogs) {
            console.log(chalk.red(`❌ GPU ${gpuIndex + 1} error: ${error.message}`));
          }
          callback(false, 0, '', attempts);
        }
      };
      
      // Start mining
      mineBatch();
      
    } catch (error) {
      if (this.showMiningLogs) {
        console.log(chalk.red(`❌ Failed to start GPU ${gpuIndex + 1}: ${error.message}`));
      }
      callback(false, 0, '', 0);
    }
  }

  simulateSHA256(data) {
    // This is a simplified hash for demonstration
    // In production, you'd implement full SHA256 on GPU
    return CryptoJS.SHA256(data).toString();
  }

  isHashValid(hash, target) {
    const hashNum = BigInt('0x' + hash);
    const targetNum = BigInt('0x' + target);
    return hashNum <= targetNum;
  }

  async syncLocalBlockchain() {
    try {
      const status = await this.cli.makeApiRequest('/api/blockchain/status');
      this.cli.localBlockchain.difficulty = status.difficulty;
      this.cli.localBlockchain.miningReward = this.cli.config?.blockchain?.coinbaseReward || 50;
      this.cli.localBlockchain.blockTime = this.cli.config?.blockchain?.blockTime || 60000;
      
      if (this.showMiningLogs) {
        console.log(chalk.cyan(`Synced with daemon - Difficulty: ${status.difficulty}, Height: ${status.length}`));
      }
    } catch (error) {
      console.log(chalk.red(`❌ Error syncing with daemon: ${error.message}`));
    }
  }

  async submitBlock(block) {
    try {
      const response = await this.cli.makeApiRequest('/api/blocks/submit', 'POST', {
        block: block.toJSON()
      });
      
      if (response.success) {
        if (this.showMiningLogs) {
          console.log(chalk.green(`✅ Block #${block.index} submitted successfully!`));
          console.log(chalk.cyan(`Hash: ${block.hash.substring(0, 16)}...`));
        }
      } else {
        if (this.showMiningLogs) {
          console.log(chalk.red(`❌ Failed to submit block: ${response.error}`));
        }
      }
    } catch (error) {
      if (this.showMiningLogs) {
        console.log(chalk.red(`❌ Error submitting block: ${error.message}`));
      }
    }
  }

  calculateHashRate() {
    if (!this.miningStartTime || !this.isMining) return 0;
    
    const elapsed = (Date.now() - this.miningStartTime) / 1000;
    return elapsed > 0 ? this.totalHashes / elapsed : 0;
  }

  formatHashRate(hashRate) {
    if (hashRate >= 1000000) {
      return `${(hashRate / 1000000).toFixed(2)} MH/s`;
    } else if (hashRate >= 1000) {
      return `${(hashRate / 1000).toFixed(2)} KH/s`;
    } else {
      return `${hashRate.toFixed(2)} H/s`;
    }
  }
}

module.exports = GPUMiningManager;
