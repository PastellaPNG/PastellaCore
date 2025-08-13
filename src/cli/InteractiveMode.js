const inquirer = require('inquirer');
const chalk = require('chalk');
const { generatePrompt } = require('./utils');

class InteractiveMode {
  constructor(cli) {
    this.cli = cli;
  }

  async start() {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                       PASTELLA CLI                       ║'));
    console.log(chalk.blue.bold('║              NodeJS Cryptocurrency Interface             ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════╝'));
    console.log('');
    console.log(chalk.cyan(`🔌 Connecting to daemon at ${this.cli.apiBaseUrl}...`));
    
    const connected = await this.cli.checkDaemonConnection();
    if (!connected) {
      console.log(chalk.red('❌ Cannot connect to daemon. Make sure the daemon is running.'));
      console.log(chalk.yellow('💡 Start the daemon with: node src/index.js'));
      process.exit(1);
    }
    
    console.log(chalk.green('✅ Connected to daemon!'));
    console.log(chalk.cyan('💡 Type "help" for available commands or "quit" to exit'));
    console.log('');
    
    const askQuestion = async () => {
      const questions = [
                 {
           type: 'input',
           name: 'command',
           message: generatePrompt(this.cli.walletLoaded, this.cli.walletName, this.cli.miningManager?.isMining || false),
           prefix: '',
           transformer: (input) => input.trim()
         }
      ];

      try {
        const answer = await inquirer.prompt(questions);
        if (answer.command.trim()) {
          await this.handleInteractiveCommand(answer.command);
        }
        askQuestion();
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
        askQuestion();
      }
    };

    askQuestion();
  }

  async handleInteractiveCommand(command) {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      return; // Skip empty commands
    }
    
    const args = trimmedCommand.split(' ');
    const cmd = args[0].toLowerCase();

    switch (cmd) {
      case 'help':
        this.showInteractiveHelp();
        break;
      case 'wallet':
        await this.cli.walletManager.handleCommand(args.slice(1));
        break;
      // CPU mining removed - only KawPow GPU mining available
      case 'gpu-mine':
        await this.cli.gpuMiningManager.handleCommand(args.slice(1));
        break;
      case 'chain':
        await this.cli.networkManager.handleChainCommand(args.slice(1));
        break;
      case 'network':
        await this.cli.networkManager.handleNetworkCommand(args.slice(1));
        break;
      case 'daemon':
        await this.cli.networkManager.handleDaemonCommand(args.slice(1));
        break;
      case 'quit':
      case 'exit':
        console.log(chalk.green('👋 Goodbye!'));
        process.exit(0);
        break;
      case 'spam-protection':
        await this.handleSpamProtectionCommand(args.slice(1));
        break;
      case 'replay-protection':
        await this.handleReplayProtectionCommand(args.slice(1));
        break;
      default:
        console.log(chalk.red(`❌ Unknown command: ${cmd}`));
        console.log(chalk.cyan('Type "help" for available commands'));
    }
    
    // Add a newline for better readability before the next prompt
    console.log('');
  }

  async handleSpamProtectionCommand(args) {
    if (args.length === 0 || args[0] === 'status') {
      try {
        const response = await this.cli.makeApiRequest('/api/spam-protection/status', 'GET');
        if (response) {
          console.log(chalk.blue.bold('🛡️  SPAM PROTECTION STATUS:'));
          console.log(chalk.cyan('  Rate Limiting:'), response.rateLimiting ? chalk.green('Enabled') : chalk.red('Disabled'));
          console.log(chalk.cyan('  Global Rate Limit:'), chalk.white(`${response.globalRateLimit} requests per minute`));
          console.log(chalk.cyan('  Address Rate Limit:'), chalk.white(`${response.addressRateLimit} requests per minute`));
          console.log(chalk.cyan('  Banned Addresses:'), chalk.white(response.bannedAddresses.length));
          console.log(chalk.cyan('  Rate Limited Addresses:'), chalk.white(response.rateLimitedAddresses.length));
        }
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
      }
    } else if (args[0] === 'reset') {
      try {
        const response = await this.cli.makeApiRequest('/api/spam-protection/reset', 'POST');
        if (response) {
          console.log(chalk.green('✅ Spam protection reset successfully'));
        }
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
      }
    } else {
      console.log(chalk.yellow('Usage: spam-protection [status|reset]'));
    }
  }

  async handleReplayProtectionCommand(args) {
    if (args.length === 0 || args[0] === 'status') {
      try {
        const response = await this.cli.makeApiRequest('/api/blockchain/replay-protection', 'GET');
        if (response) {
          console.log(chalk.blue.bold('🛡️  REPLAY ATTACK PROTECTION STATUS:'));
          console.log(chalk.cyan('  Summary:'), chalk.white(response.summary));
          console.log('');
          
          console.log(chalk.cyan('  Protection Mechanisms:'));
          response.protectionMechanisms.forEach((mechanism, index) => {
            console.log(chalk.white(`    ${index + 1}. ${mechanism}`));
          });
          console.log('');
          
          console.log(chalk.cyan('  Database Statistics:'));
          console.log(chalk.white(`    Historical Transactions: ${response.databaseStats.totalHistoricalTransactions}`));
          console.log(chalk.white(`    Transaction IDs: ${response.databaseStats.totalTransactionIds}`));
          console.log(chalk.white(`    Database Size: ${(response.databaseStats.databaseSize / 1024).toFixed(2)} KB`));
          console.log('');
          
          if (response.recentActivity.length > 0) {
            console.log(chalk.cyan('  Recent Transactions:'));
            response.recentActivity.slice(-5).forEach((tx, index) => {
              console.log(chalk.white(`    ${index + 1}. Nonce: ${tx.nonce}, Sender: ${tx.sender}, Block: ${tx.blockHeight}`));
            });
            console.log('');
          }
          
          if (response.threats.length > 0) {
            console.log(chalk.yellow('  ⚠️  Potential Threats:'));
            response.threats.forEach((threat, index) => {
              console.log(chalk.yellow(`    ${index + 1}. ${threat.type} - ${threat.description}`));
            });
          } else {
            console.log(chalk.green('  ✅ No threats detected'));
          }
        }
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
      }
    } else if (args[0] === 'stats') {
      try {
        const response = await this.cli.makeApiRequest('/api/blockchain/mempool', 'GET');
        if (response) {
          console.log(chalk.blue.bold('📊 REPLAY PROTECTION STATISTICS:'));
          console.log(chalk.cyan('  Pending Transactions:'), chalk.white(response.pendingTransactions));
          console.log(chalk.cyan('  Memory Usage:'), chalk.white(`${(response.memoryUsage / 1024 / 1024).toFixed(2)} MB`));
          console.log(chalk.cyan('  Pool Size:'), chalk.white(response.poolSize));
        }
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
      }
    } else if (args[0] === 'test') {
      try {
        const response = await this.cli.makeApiRequest('/api/blockchain/test-replay-protection', 'POST');
        if (response) {
          console.log(chalk.blue.bold('🧪 REPLAY PROTECTION TEST RESULTS:'));
          console.log(chalk.cyan('  Message:'), chalk.white(response.message));
          console.log('');
          
          console.log(chalk.cyan('  Test Transaction:'));
          console.log(chalk.white(`    ID: ${response.testTransaction.id}`));
          console.log(chalk.white(`    Nonce: ${response.testTransaction.nonce}`));
          console.log(chalk.white(`    Expires: ${new Date(response.testTransaction.expiresAt).toISOString()}`));
          console.log(chalk.white(`    Expired: ${response.testTransaction.isExpired ? 'Yes' : 'No'}`));
          console.log('');
          
          console.log(chalk.cyan('  Test Results:'));
          response.testResults.tests.forEach((test, index) => {
            const statusIcon = test.result === 'PASSED' ? '✅' : '❌';
            const statusColor = test.result === 'PASSED' ? chalk.green : chalk.red;
            console.log(statusColor(`    ${statusIcon} ${test.test}: ${test.result}`));
            console.log(chalk.white(`       ${test.description}`));
          });
          console.log('');
          
          if (response.testResults.threats.length > 0) {
            console.log(chalk.yellow('  ⚠️  Threats Detected:'));
            response.testResults.threats.forEach((threat, index) => {
              console.log(chalk.yellow(`    ${index + 1}. ${threat}`));
            });
          } else {
            console.log(chalk.green('  ✅ No threats detected - replay protection working correctly'));
          }
          
          console.log('');
          console.log(chalk.cyan('  Overall Result:'), 
            response.testResults.passed ? chalk.green('PASSED') : chalk.red('FAILED'));
        }
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
      }
    } else {
      console.log(chalk.yellow('Usage: replay-protection [status|stats|test]'));
    }
  }

  showInteractiveHelp() {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                      📖 COMMANDS 📖                      ║'));
    console.log(chalk.blue.bold('║  mempool status     - Show memory pool status            ║'));
    console.log(chalk.blue.bold('║  spam-protection    - Manage spam protection system      ║'));
    console.log(chalk.blue.bold('║  replay-protection  - Show replay attack protection status ║'));
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════╝'));
    console.log('');
    
    console.log(chalk.yellow.bold('💼 WALLET COMMANDS:'));
    console.log(chalk.cyan('  wallet create                      - Create new wallet (local)'));
    console.log(chalk.cyan('  wallet load                        - Load existing wallet (local)'));
    console.log(chalk.cyan('  wallet unload                      - Unload current wallet (local)'));
    console.log(chalk.cyan('  wallet balance                     - Check balance (syncs with daemon)'));
    console.log(chalk.cyan('  wallet send <addr> <amt>           - Send PAS (syncs with daemon)'));
    console.log(chalk.cyan('  wallet info                        - Show wallet info (syncs with daemon)'));
    console.log(chalk.cyan('  wallet transactions                - Show transaction history (paginated)'));
    console.log(chalk.cyan('  wallet sync                        - Manually sync wallet with daemon'));
    console.log(chalk.cyan('  wallet resync                      - Force resync wallet from beginning'));
    console.log(chalk.cyan('  wallet save                        - Manually save wallet with current data'));
    console.log('');
    
    console.log(chalk.yellow.bold('⛏️  KAW POW GPU MINING COMMANDS:'));
    console.log(chalk.cyan('  gpu-mine start                     - Start KawPow GPU mining (Memory-hard, ASIC-resistant)'));
    console.log(chalk.cyan('  gpu-mine stop                      - Stop GPU mining'));
    console.log(chalk.cyan('  gpu-mine status                    - Show GPU mining status and performance'));
    console.log(chalk.cyan('  gpu-mine config                    - Configure GPU mining settings'));
    console.log(chalk.cyan('  gpu-mine detect                    - Detect available GPUs and initialize kernels'));
    console.log(chalk.cyan('  gpu-mine benchmark                 - Run GPU mining benchmark'));
    console.log(chalk.cyan('  gpu-mine log                       - Toggle GPU mining logs'));
    console.log('');
    

    
    console.log(chalk.yellow.bold('🔗 BLOCKCHAIN COMMANDS:'));
    console.log(chalk.cyan('  chain status                       - Show blockchain status'));
    console.log(chalk.cyan('  chain blocks                       - Show recent blocks'));
    console.log(chalk.cyan('  chain block <index>                - Show specific block'));
    console.log(chalk.cyan('  chain transactions                 - Show pending transactions'));
    console.log(chalk.cyan('  chain validate <mode>              - Validate blockchain (checkpoint/full)'));
    console.log(chalk.cyan('  chain checkpoints list             - Show all checkpoints'));
    console.log(chalk.cyan('  chain checkpoints add <height>     - Add checkpoint at height'));
    console.log(chalk.cyan('  chain checkpoints update           - Update all checkpoints'));
    console.log(chalk.cyan('  chain checkpoints clear            - Clear all checkpoints'));
    console.log(chalk.cyan('  chain security                     - Show security report'));
    console.log('');
    
    console.log(chalk.yellow.bold('🌐 NETWORK COMMANDS:'));
    console.log(chalk.cyan('  network status                     - Show network status'));
    console.log(chalk.cyan('  network peers                      - Show connected peers'));
    console.log(chalk.cyan('  network connect <host> <port>      - Connect to peer (Unstable, do not use)'));
    console.log(chalk.cyan('  network reputation                 - Show network reputation statistics'));
    console.log(chalk.cyan('  network peer-reputation <addr>     - Show specific peer reputation'));
    console.log(chalk.cyan('  network identity                   - Show node identity and authentication status'));
    console.log(chalk.cyan('  network authenticated              - List all authenticated peers'));
    console.log(chalk.cyan('  network message-validation         - Show message validation statistics'));
    console.log(chalk.cyan('  network message-validation-reset   - Reset validation statistics'));
    console.log(chalk.cyan('  network partition-stats            - Show network partition statistics'));
    console.log(chalk.cyan('  network partition-reset            - Reset partition statistics'));
    console.log('');
    
    console.log(chalk.yellow.bold('⚙️  DAEMON COMMANDS:'));
    console.log(chalk.cyan('  daemon status                      - Show daemon status'));
    console.log('');
    
    console.log(chalk.yellow.bold('🔧 UTILITY COMMANDS:'));
    console.log(chalk.cyan('  help                               - Show this help'));
    console.log(chalk.cyan('  quit                               - Exit interactive mode'));
    console.log('');
    
    if (this.cli.walletLoaded) {
      console.log(chalk.green.bold('💡 WALLET STATUS:'));
      console.log(chalk.green(`  Loaded: ${this.cli.walletName}`));
      console.log(chalk.green(`  Address: ${this.cli.localWallet.getAddress()}`));
      console.log(chalk.green(`  Balance: ${this.cli.localWallet.getBalance()} PAS`));
      console.log(chalk.green(`  Auto Sync: ${this.cli.syncInterval ? 'Enabled' : 'Disabled'}`));
      console.log('');
    }
  }
}

module.exports = InteractiveMode;
