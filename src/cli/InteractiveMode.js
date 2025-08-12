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
      default:
        console.log(chalk.red(`❌ Unknown command: ${cmd}`));
        console.log(chalk.cyan('Type "help" for available commands'));
    }
    
    // Add a newline for better readability before the next prompt
    console.log('');
  }

  showInteractiveHelp() {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                      📖 COMMANDS 📖                      ║'));
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
