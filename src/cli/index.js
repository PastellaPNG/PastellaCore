const { Command } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Increase max listeners to prevent warnings
process.stdout.setMaxListeners(20);
process.stderr.setMaxListeners(20);

const config = require('../../config');
const Blockchain = require('../models/Blockchain');
const Wallet = require('../models/Wallet');
const Block = require('../models/Block');
const { Transaction } = require('../models/Transaction');

const AdvancedGPUMiner = require('./AdvancedGPUMiner');
const WalletManager = require('./WalletManager');
const NetworkManager = require('./NetworkManager');
const InteractiveMode = require('./InteractiveMode');
const { validateAddress } = require('./utils');

class PastellaCLI {
  constructor() {
    this.apiBaseUrl = `http://localhost:${config.api.port}`;
    this.program = new Command();
    this.isConnected = false;
    this.config = config; // Add config reference
    
    // Initialize managers (CPU mining removed)
    this.gpuMiningManager = new AdvancedGPUMiner(this);
    this.walletManager = new WalletManager(this);
    this.networkManager = new NetworkManager(this);
    this.interactiveMode = new InteractiveMode(this);
    
    // Local components
    this.localBlockchain = new Blockchain();
    this.localWallet = new Wallet();
    
    // Add references for GPU mining manager
    this.Block = Block;
    this.Transaction = Transaction;
    this.inquirer = inquirer;
    
    // State tracking
    this.walletLoaded = false;
    this.walletName = null;
    this.walletPath = null;
    this.walletPassword = null;
    this.lastSyncHeight = 0;
    this.syncInterval = null;
    
    this.setupCommands();
  }

  // API and connection methods
  updateApiUrl(host = 'localhost', port = config.api.port) {
    this.apiBaseUrl = `http://${host}:${port}`;
  }

  parseConnectionArgs() {
    const args = process.argv.slice(2);
    
    // Parse legacy arguments for backward compatibility
    const hostIndex = args.indexOf('--host');
    const portIndex = args.indexOf('--port');
    const dataDirIndex = args.indexOf('--data-dir');
    
    if (hostIndex !== -1 && args[hostIndex + 1]) {
      this.updateApiUrl(args[hostIndex + 1]);
    }
    
    if (portIndex !== -1 && args[portIndex + 1]) {
      const port = parseInt(args[portIndex + 1]);
      if (!isNaN(port)) {
        this.updateApiUrl('localhost', port);
      }
    }
    
    if (dataDirIndex !== -1 && args[dataDirIndex + 1]) {
      const dataDir = args[dataDirIndex + 1];
      this.localBlockchain.dataDir = dataDir;
    }
  }

  async makeApiRequest(endpoint, method = 'GET', data = null) {
    try {
      const url = `${this.apiBaseUrl}${endpoint}`;
      const options = {
        method: method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      if (data && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(data);
      }

      const response = await fetch(url, options);
      
      //console.log(await response.text());

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error) {
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        throw new Error('Network error: Unable to connect to daemon');
      }
      throw error;
    }
  }

  async checkDaemonConnection() {
    try {
      await this.makeApiRequest('/api/daemon/status');
      this.isConnected = true;
      return true;
    } catch (error) {
      this.isConnected = false;
      return false;
    }
  }

  // Command setup
  setupCommands() {
    this.program
      .name('pastella')
      .description('Pastella Cryptocurrency CLI (KawPow GPU Mining Only)\n\nExamples:\n  pastella --host 192.168.1.100 --port 22001 wallet balance\n  pastella --port 22002 chain status\n  pastella --host localhost --port 22003 gpu-mine start')
      .version('1.0.0')
      .option('--host <host>', 'API server host (default: localhost)', 'localhost')
      .option('--port <port>', 'API server port (default: 22000)', config.api.port.toString())
      .option('--data-dir <path>', 'Data directory path')
      .hook('preAction', (thisCommand) => {
        // Update API URL based on options
        const options = thisCommand.opts();
        if (options.host || options.port) {
          this.updateApiUrl(options.host, parseInt(options.port));
        }
        
        // Update data directory if specified
        if (options.dataDir) {
          this.localBlockchain.dataDir = options.dataDir;
        }
      });

    // Wallet commands
    this.program
      .command('wallet')
      .description('Wallet management commands')
      .argument('[command]', 'Wallet command to execute')
      .action(async (command) => {
        await this.walletManager.handleCommand(command);
      });

    // CPU mining removed - only KawPow GPU mining available

    // KawPow GPU Mining commands (Main mining system)
    this.program
      .command('gpu-mine')
      .description('KawPow GPU Mining - Memory-hard, ASIC-resistant mining algorithm')
      .argument('[command]', 'GPU mining command to execute')
      .action(async (command) => {
        await this.gpuMiningManager.handleCommand(command);
      });

    // Chain commands
    this.program
      .command('chain')
      .description('Blockchain commands')
      .argument('[command]', 'Chain command to execute')
      .action(async (command) => {
        await this.networkManager.handleChainCommand(command);
      });

    // Network commands
    this.program
      .command('network')
      .description('Network commands')
      .argument('[command]', 'Network command to execute')
      .action(async (command) => {
        await this.networkManager.handleNetworkCommand(command);
      });

    // Daemon commands
    this.program
      .command('daemon')
      .description('Daemon commands')
      .argument('[command]', 'Daemon command to execute')
      .action(async (command) => {
        await this.networkManager.handleDaemonCommand(command);
      });

    // Connection info command
    this.program
      .command('connection')
      .description('Show connection information')
      .action(async () => {
        const options = this.program.opts();
        console.log(chalk.cyan('🔗 Connection Information:'));
        console.log(chalk.white(`  Host: ${options.host}`));
        console.log(chalk.white(`  Port: ${options.port}`));
        if (options.dataDir) {
          console.log(chalk.white(`  Data Directory: ${options.dataDir}`));
        }
        console.log(chalk.white(`  API URL: http://${options.host}:${options.port}`));
      });
  }

  // Utility methods
  validateAddress(address) {
    return validateAddress(address);
  }

  getConnectionInfo() {
    return {
      host: this.apiBaseUrl.split('://')[1].split(':')[0],
      port: parseInt(this.apiBaseUrl.split(':')[2]),
      url: this.apiBaseUrl
    };
  }

  /**
   * Run the CLI
   */
  async run() {
    try {
      // Check if any command-line arguments were provided
      const args = process.argv.slice(2);
      
      if (args.length === 0) {
        // No arguments provided, start interactive mode
        await this.interactiveMode.start();
      } else {
        // Check if only global options are provided (no command)
        const hasCommand = args.some(arg => ['wallet', 'mine', 'chain', 'network', 'daemon', 'connection'].includes(arg));
        
        if (!hasCommand) {
          // Only global options provided, parse them manually and start interactive mode
          this.parseGlobalOptions(args);
          await this.interactiveMode.start();
        } else {
          // Command provided, use command-line interface
          await this.program.parseAsync();
        }
      }
    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  }

  /**
   * Parse global options manually for interactive mode
   */
  parseGlobalOptions(args) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      
      if (arg === '--host' && i + 1 < args.length) {
        this.updateApiUrl(args[i + 1]);
        i++; // Skip the next argument since we consumed it
      } else if (arg === '--port' && i + 1 < args.length) {
        const port = parseInt(args[i + 1]);
        if (!isNaN(port)) {
          this.updateApiUrl('localhost', port);
        }
        i++; // Skip the next argument since we consumed it
      } else if (arg === '--data-dir' && i + 1 < args.length) {
        this.localBlockchain.dataDir = args[i + 1];
        i++; // Skip the next argument since we consumed it
      }
    }
  }
}

// Create and run CLI
const cli = new PastellaCLI();
cli.run();
