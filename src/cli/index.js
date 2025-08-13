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
      // Force IPv4 by using 127.0.0.1 instead of localhost
      let url = `${this.apiBaseUrl}${endpoint}`;

      // If the URL contains localhost, replace it with 127.0.0.1 to force IPv4
      if (url.includes('localhost')) {
        url = url.replace('localhost', '127.0.0.1');
      }

      const options = {
        method: method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      // Add authentication headers for sensitive endpoints
      if (this.apiKey) {
        const sensitiveEndpoints = [
          '/api/blocks/submit',
          '/api/network/connect',
          '/api/network/message-validation/reset',
          '/api/network/partition-reset',
          '/api/rate-limits/stats',
          '/api/rate-limits/reset',
          '/api/blockchain/reset',
        ];

        if (sensitiveEndpoints.includes(endpoint)) {
          options.headers['X-API-Key'] = this.apiKey;
        }
      }

      if (data && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(data);
      }

      const response = await fetch(url, options);

      if (response.status !== 200) {
        if (response.status === 404 && endpoint.includes(`/api/blockchain/blocks/`)) {
          // Do nothing
        } else {
          console.log(`[ERROR] ${url} ${method} ${response.status}`);
          console.log(await response.text());
        }
      }

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
      .description(
        'Pastella Cryptocurrency CLI (KawPow GPU Mining Only)\n\nExamples:\n  pastella --host 192.168.1.100 --port 22001 wallet balance\n  pastella --port 22002 chain status\n  pastella --host localhost --port 22003 mine start'
      )
      .version('1.0.0')
      .option('--host <host>', 'API server host (default: localhost)', 'localhost')
      .option('--port <port>', 'API server port (default: 22000)', config.api.port.toString())
      .option('--data-dir <path>', 'Data directory path')
      .option('--api-key <key>', 'API key for authenticated endpoints')
      .hook('preAction', thisCommand => {
        // Update API URL based on options
        const options = thisCommand.opts();
        if (options.host || options.port) {
          this.updateApiUrl(options.host, parseInt(options.port));
        }

        // Update data directory if specified
        if (options.dataDir) {
          this.localBlockchain.dataDir = options.dataDir;
        }

        // Store API key if provided
        if (options.apiKey) {
          this.apiKey = options.apiKey;
        }
      });

    // Wallet commands
    this.program
      .command('wallet')
      .description('Wallet management commands')
      .argument('[command]', 'Wallet command to execute')
      .action(async command => {
        await this.walletManager.handleCommand(command);
      });

    // CPU mining removed - only KawPow GPU mining available

    // KawPow GPU Mining commands (Main mining system)
    this.program
      .command('mine')
      .description('KawPow GPU Mining - Memory-hard, ASIC-resistant mining algorithm')
      .argument('[command]', 'GPU mining command to execute')
      .action(async command => {
        await this.gpuMiningManager.handleCommand(command);
      });

    // Chain commands
    this.program
      .command('chain')
      .description('Blockchain commands (status, blocks, validation, checkpoints)')
      .argument('[command]', 'Chain command to execute')
      .action(async command => {
        await this.networkManager.handleChainCommand(command);
      });

    // Network commands
    this.program
      .command('network')
      .description('Network commands')
      .argument('[command]', 'Network command to execute')
      .action(async command => {
        await this.networkManager.handleNetworkCommand(command);
      });

    // Daemon commands
    this.program
      .command('daemon')
      .description('Daemon commands')
      .argument('[command]', 'Daemon command to execute')
      .action(async command => {
        await this.networkManager.handleDaemonCommand(command);
      });

    // Help command
    this.program
      .command('help')
      .description('Show detailed help information')
      .action(async () => {
        console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════╗'));
        console.log(chalk.blue.bold('║                    PASTELLA CLI HELP                     ║'));
        console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════╝'));
        console.log('');
        console.log(chalk.yellow.bold('📖 AVAILABLE COMMANDS:'));
        console.log(chalk.cyan('  wallet <command>                                             - Wallet management'));
        console.log(chalk.cyan('  mine <command>                                           - KawPow GPU mining'));
        console.log(
          chalk.cyan('  chain <command>                                              - Blockchain operations')
        );
        console.log(chalk.cyan('  network <command>                                            - Network management'));
        console.log(chalk.cyan('  daemon <command>                                             - Daemon control'));
        console.log(
          chalk.cyan('  connection                                                   - Show connection info')
        );
        console.log(chalk.cyan('  help                                                         - Show this help'));
        console.log('');
        console.log(chalk.yellow.bold('💡 CHECKPOINT SYSTEM:'));
        console.log(
          chalk.cyan(
            '  chain validate checkpoint                                    - Fast validation using checkpoints'
          )
        );
        console.log(chalk.cyan('  chain validate full                                          - Complete validation'));
        console.log(
          chalk.cyan('  chain checkpoints list                                       - Show all checkpoints')
        );
        console.log(chalk.cyan('  chain checkpoints add                                        - Add new checkpoint'));
        console.log(
          chalk.cyan('  chain checkpoints update                                     - Update all checkpoints')
        );
        console.log(
          chalk.cyan('  chain security                                               - Show security report')
        );
        console.log(
          chalk.cyan('  chain replay-protection                                      - Show replay protection status')
        );
        console.log(
          chalk.cyan('  chain rate-limits                                            - Show rate limiting statistics')
        );
        console.log(
          chalk.cyan(
            '  chain rate-limits reset <ip>                                 - Reset rate limits for specific IP'
          )
        );
        console.log(
          chalk.cyan('  chain rate-limits reset-all                                  - Reset all rate limits')
        );
        console.log(
          chalk.cyan(
            '  chain reset                                                  - Reset blockchain (WARNING: DESTRUCTIVE)'
          )
        );
        console.log('');
        console.log(chalk.yellow.bold('🔐 AUTHENTICATION:'));
        console.log(chalk.cyan('  Use --api-key <key> for authenticated endpoints'));
        console.log(chalk.cyan('  Sensitive endpoints automatically authenticated when key provided'));
        console.log(chalk.cyan('  Check API_AUTHENTICATION.md for details'));
        console.log('');
        console.log(chalk.yellow.bold('🔧 EXAMPLES:'));
        console.log(
          chalk.cyan('  pastella wallet balance                                      - Check wallet balance')
        );
        console.log(
          chalk.cyan(
            '  pastella wallet send <address> <amount>                        - Send coins with replay protection'
          )
        );
        console.log(
          chalk.cyan(
            '  pastella wallet transaction-info <tx-id>                       - Show transaction details & protection'
          )
        );
        console.log(chalk.cyan('  pastella mine start                                      - Start GPU mining'));
        console.log(chalk.cyan('  pastella chain validate checkpoint                           - Fast validation'));
        console.log(
          chalk.cyan('  pastella chain checkpoints add 100                           - Add checkpoint at height 100')
        );
        console.log(
          chalk.cyan('  pastella --host 192.168.1.100 chain status                   - Remote blockchain status')
        );
        console.log(chalk.cyan('  pastella --api-key my-key network message-validation-reset   - Reset with auth'));
        console.log('');
        console.log(chalk.yellow.bold('📚 FOR MORE HELP:'));
        console.log(chalk.cyan('  Run without arguments for interactive mode'));
        console.log(chalk.cyan('  Type "help" in interactive mode for detailed commands'));
        console.log(chalk.cyan('  Check CHECKPOINTS_README.md for checkpoint system details'));
        console.log('');
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
      url: this.apiBaseUrl,
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
        const hasCommand = args.some(arg =>
          ['wallet', 'mine', 'chain', 'network', 'daemon', 'connection', 'help'].includes(arg)
        );

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
      } else if (arg === '--api-key' && i + 1 < args.length) {
        this.apiKey = args[i + 1];
        i++; // Skip the next argument since we consumed it
      }
    }
  }
}

// Create and run CLI
const cli = new PastellaCLI();
cli.run();
