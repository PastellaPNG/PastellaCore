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
      case 'security':
        await this.handleSecurityCommand(args.slice(1));
        break;
      case 'consensus':
        await this.handleConsensusCommand(args.slice(1));
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

  async handleSecurityCommand(args) {
    if (args.length === 0 || args[0] === 'status') {
      try {
        const response = await this.cli.makeApiRequest('/api/blockchain/security-analysis', 'GET');
        if (response) {
          console.log(chalk.blue.bold('🛡️  COMPREHENSIVE SECURITY ANALYSIS:'));
          console.log(chalk.cyan('  Timestamp:'), chalk.white(response.timestamp));
          console.log('');
          
          console.log(chalk.cyan('  Blockchain Status:'));
          console.log(chalk.white(`    Height: ${response.blockchain.height}`));
          console.log(chalk.white(`    Difficulty: ${response.blockchain.difficulty}`));
          console.log(chalk.white(`    Last Block: ${response.blockchain.lastBlockHash.substring(0, 16)}...`));
          console.log('');
          
          console.log(chalk.cyan('  Consensus Status:'));
          console.log(chalk.white(`    Security Level: ${response.consensus.securityLevel}/100`));
          console.log(chalk.white(`    Network Partition: ${response.consensus.networkPartition ? '⚠️  YES' : '✅ NO'}`));
          console.log(chalk.white(`    Suspicious Miners: ${response.consensus.suspiciousMiners.length}`));
          console.log('');
          
          if (response.threats.length > 0) {
            console.log(chalk.red('  🚨 ACTIVE THREATS:'));
            response.threats.forEach((threat, index) => {
              const severityColor = threat.severity === 'HIGH' ? chalk.red : 
                                  threat.severity === 'MEDIUM' ? chalk.yellow : chalk.blue;
              console.log(severityColor(`    ${index + 1}. [${threat.severity}] ${threat.type}`));
              console.log(chalk.white(`       ${threat.description}`));
              console.log(chalk.gray(`       Recommendation: ${threat.recommendation}`));
              console.log('');
            });
          } else {
            console.log(chalk.green('  ✅ No active threats detected'));
            console.log('');
          }
          
          if (response.recommendations.length > 0) {
            console.log(chalk.cyan('  📋 SECURITY RECOMMENDATIONS:'));
            response.recommendations.forEach((rec, index) => {
              const priorityColor = rec.priority === 'HIGH' ? chalk.red : 
                                  rec.priority === 'MEDIUM' ? chalk.yellow : chalk.blue;
              console.log(priorityColor(`    ${index + 1}. [${rec.priority}] ${rec.action}`));
              console.log(chalk.white(`       ${rec.description}`));
            });
          }
        }
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
      }
    } else if (args[0] === 'threats') {
      try {
        const response = await this.cli.makeApiRequest('/api/blockchain/security-analysis', 'GET');
        if (response && response.threats.length > 0) {
          console.log(chalk.red.bold('🚨 SECURITY THREATS DETECTED:'));
          response.threats.forEach((threat, index) => {
            const severityColor = threat.severity === 'HIGH' ? chalk.red : 
                                threat.severity === 'MEDIUM' ? chalk.yellow : chalk.blue;
            console.log(severityColor(`  ${index + 1}. [${threat.severity}] ${threat.type}`));
            console.log(chalk.white(`     Description: ${threat.description}`));
            console.log(chalk.gray(`     Recommendation: ${threat.recommendation}`));
            console.log('');
          });
        } else {
          console.log(chalk.green('✅ No security threats detected'));
        }
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
      }
    } else {
      console.log(chalk.yellow('Usage: security [status|threats]'));
    }
  }

  async handleConsensusCommand(args) {
    if (args.length === 0 || args[0] === 'status') {
      try {
        const response = await this.cli.makeApiRequest('/api/blockchain/consensus', 'GET');
        if (response) {
          console.log(chalk.blue.bold('🔗 CONSENSUS & MINING STATUS:'));
          console.log(chalk.cyan('  Security Level:'), chalk.white(`${response.securityLevel}/100`));
          console.log(chalk.cyan('  Total Network Hash Rate:'), chalk.white(`${(response.totalNetworkHashRate / 1000000).toFixed(2)} MH/s`));
          console.log(chalk.cyan('  Validator Count:'), chalk.white(response.validatorCount));
          console.log(chalk.cyan('  Total Stake:'), chalk.white(`${response.totalStake} PAS`));
          console.log(chalk.cyan('  Consensus Threshold:'), chalk.white(`${response.consensusThreshold * 100}%`));
          console.log('');
          
          console.log(chalk.cyan('  Network Status:'));
          console.log(chalk.white(`    Partitioned: ${response.networkPartition ? '⚠️  YES' : '✅ NO'}`));
          console.log(chalk.white(`    Consecutive Late Blocks: ${response.consecutiveLateBlocks}`));
          console.log('');
          
          if (response.miningPowerDistribution.length > 0) {
            console.log(chalk.cyan('  Top Miners:'));
            response.miningPowerDistribution.slice(0, 5).forEach((miner, index) => {
              const riskColor = parseFloat(miner.share) > 30 ? chalk.red : 
                              parseFloat(miner.share) > 20 ? chalk.yellow : chalk.green;
              console.log(riskColor(`    ${index + 1}. ${miner.address.substring(0, 16)}... - ${miner.share}%`));
            });
            console.log('');
          }
          
          if (response.suspiciousMiners.length > 0) {
            console.log(chalk.red('  ⚠️  Suspicious Miners:'));
            response.suspiciousMiners.forEach((miner, index) => {
              console.log(chalk.red(`    ${index + 1}. ${miner}`));
            });
            console.log('');
          }
          
          // Security recommendations based on consensus status
          if (response.securityLevel < 70) {
            console.log(chalk.red('  🚨 IMMEDIATE ACTION REQUIRED:'));
            console.log(chalk.red('     - Security level is critically low'));
            console.log(chalk.red('     - Review all mining operations'));
            console.log(chalk.red('     - Check for network attacks'));
          } else if (response.securityLevel < 80) {
            console.log(chalk.yellow('  ⚠️  ATTENTION REQUIRED:'));
            console.log(chalk.yellow('     - Security level below recommended threshold'));
            console.log(chalk.yellow('     - Consider adding more validators'));
          } else {
            console.log(chalk.green('  ✅ Security status is good'));
          }
        }
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
      }
    } else if (args[0] === 'miners') {
      try {
        const response = await this.cli.makeApiRequest('/api/blockchain/consensus', 'GET');
        if (response && response.miningPowerDistribution.length > 0) {
          console.log(chalk.blue.bold('⛏️  MINING POWER DISTRIBUTION:'));
          response.miningPowerDistribution.forEach((miner, index) => {
            const riskColor = parseFloat(miner.share) > 30 ? chalk.red : 
                            parseFloat(miner.share) > 20 ? chalk.yellow : chalk.green;
            const riskLevel = parseFloat(miner.share) > 30 ? 'HIGH RISK' : 
                            parseFloat(miner.share) > 20 ? 'MEDIUM RISK' : 'LOW RISK';
            
            console.log(riskColor(`  ${index + 1}. ${miner.address.substring(0, 16)}...`));
            console.log(chalk.white(`     Hash Rate: ${(miner.hashRate / 1000000).toFixed(2)} MH/s`));
            console.log(chalk.white(`     Network Share: ${miner.share}%`));
            console.log(riskColor(`     Risk Level: ${riskLevel}`));
            console.log('');
          });
        } else {
          console.log(chalk.gray('No mining data available'));
        }
      } catch (error) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
      }
    } else {
      console.log(chalk.yellow('Usage: consensus [status|miners]'));
    }
  }

  showInteractiveHelp() {
    console.log(chalk.blue.bold('╔══════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue.bold('║                      📖 COMMANDS 📖                      ║'));
    console.log(chalk.blue.bold('║  mempool status     - Show memory pool status            ║'));
    console.log(chalk.blue.bold('║  spam-protection    - Manage spam protection system      ║'));
    console.log(chalk.blue.bold('║  replay-protection  - Show replay attack protection status ║'));
    console.log(chalk.blue.bold('║  security           - Show comprehensive security analysis ║'));
    console.log(chalk.blue.bold('║  consensus          - Show consensus and mining status    ║'));
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
