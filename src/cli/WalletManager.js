const inquirer = require('inquirer');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');

const Block = require('../models/Block');
const { Transaction } = require('../models/Transaction');

class WalletManager {
  constructor(cli) {
    this.cli = cli;
  }

  async handleCommand(args) {
    if (!args || args.length === 0) {
      console.log(chalk.red('❌ Missing wallet command'));
      return;
    }

    const command = args[0];
    
    switch (command) {
      case 'create':
        await this.createWallet();
        break;
      case 'load':
        await this.loadWallet();
        break;
      case 'unload':
        await this.unloadWallet();
        break;
      case 'balance':
        await this.checkBalance();
        break;
      case 'send':
        if (args.length < 3) {
          console.log(chalk.red('❌ Usage: wallet send <address> <amount>'));
          return;
        }
        // Use defaultFee from config, fallback to 0.001 if not configured
        const TRANSACTION_FEE = this.cli.config?.wallet?.defaultFee || 0.001;
        await this.sendTransaction(args[1], args[2], TRANSACTION_FEE);
        break;
      case 'info':
        await this.showWalletInfo();
        break;
      case 'sync':
        await this.syncWalletWithDaemon();
        break;
      case 'resync':
        await this.resyncWallet();
        break;
      case 'transactions':
        await this.showTransactionHistory();
        break;
      case 'save':
        await this.saveWallet();
        break;
      default:
        console.log(chalk.red(`❌ Unknown wallet command: ${command}`));
        console.log(chalk.cyan('Available commands: create, load, unload, balance, send, info, sync, resync, save, transactions'));
    }
  }

  async createWallet() {
    try {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'walletName',
          message: 'Enter wallet name:',
          default: 'default',
          validate: (input) => {
            if (!input.trim()) {
              return 'Wallet name cannot be empty';
            }
            return true;
          }
        },
        {
          type: 'password',
          name: 'password',
          message: 'Enter wallet password:',
          validate: (input) => {
            if (input.length < 6) {
              return 'Password must be at least 6 characters long';
            }
            return true;
          }
        },
        {
          type: 'password',
          name: 'confirmPassword',
          message: 'Confirm wallet password:',
          validate: (input, answers) => {
            if (input !== answers.password) {
              return 'Passwords do not match';
            }
            return true;
          }
        }
      ]);

      // Check if wallet file already exists
      const walletName = answers.walletName.endsWith('.wallet') ? answers.walletName : answers.walletName + '.wallet';
      const dataDir = this.cli.localBlockchain.dataDir || './data';
      const walletPath = path.join(process.cwd(), dataDir, walletName);
      
      if (fs.existsSync(walletPath)) {
        console.log(chalk.red(`❌ Wallet file "${walletName}" already exists. Please choose a different name.`));
        return;
      }

      // Create wallet
      this.cli.localWallet.generateKeyPair();
      this.cli.localWallet.saveToFile(walletPath, answers.password);

      console.log(chalk.green('✅ Wallet created successfully!'));
      console.log(chalk.cyan(`Name: ${answers.walletName}`));
      console.log(chalk.cyan(`Address: ${this.cli.localWallet.getAddress()}`));
      console.log(chalk.cyan(`File: ${walletName}`));
      console.log(chalk.yellow('💡 Use "wallet load" to load your wallet'));

    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  async checkBalance() {
    try {
      if (!this.cli.walletLoaded) {
        console.log(chalk.red('❌ No wallet loaded. Use "wallet load" first.'));
        return;
      }

      // Sync with daemon first
      const connected = await this.cli.checkDaemonConnection();
      if (!connected) {
        console.log(chalk.red('❌ Cannot connect to daemon. Make sure the daemon is running.'));
        return;
      }

      await this.syncWalletWithDaemon();

      const balance = this.cli.localWallet.getBalance();
      console.log(chalk.blue('💰 Wallet Balance:'));
      console.log(chalk.cyan(`Address: ${this.cli.localWallet.getAddress()}`));
      console.log(chalk.green(`Balance: ${balance} PAS`));

    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  async sendTransaction(address, amount, fee) {
    try {
      if (!this.cli.walletLoaded) {
        console.log(chalk.red('❌ No wallet loaded. Use "wallet load" first.'));
        return;
      }

      // Sync with daemon first
      const connected = await this.cli.checkDaemonConnection();
      if (!connected) {
        console.log(chalk.red('❌ Cannot connect to daemon. Make sure the daemon is running.'));
        return;
      }

      await this.syncWalletWithDaemon();

      // Parse amount and fee
      const amountNum = parseFloat(amount);
      const feeNum = parseFloat(fee);

      if (isNaN(amountNum) || amountNum <= 0) {
        console.log(chalk.red('❌ Invalid amount. Must be a positive number.'));
        return;
      }
      
      if (isNaN(feeNum) || feeNum < 0) {
        console.log(chalk.red('❌ Invalid fee. Must be a non-negative number.'));
        return;
      }

      // Validate recipient address
      if (!this.cli.validateAddress(address)) {
        console.log(chalk.red('❌ Invalid recipient address. Please enter a valid wallet address (26-35 characters, starts with 1 or 3).'));
        return;
      }

      // Show transaction details and ask for confirmation
      console.log(chalk.yellow('📋 Transaction Details:'));
      console.log(chalk.cyan(`From: ${this.cli.localWallet.getAddress()}`));
      console.log(chalk.cyan(`To: ${address}`));
      console.log(chalk.cyan(`Amount: ${amountNum} PAS`));
      console.log(chalk.cyan(`Fee: ${feeNum} PAS`));
      console.log(chalk.cyan(`Total: ${amountNum + feeNum} PAS`));
      console.log(chalk.cyan(`Balance: ${this.cli.localWallet.getBalance()} PAS`));
      
      const confirmQuestion = {
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to send this transaction?',
        default: false
      };

      const confirmation = await inquirer.prompt([confirmQuestion]);
      
      if (!confirmation.confirm) {
        console.log(chalk.yellow('❌ Transaction cancelled.'));
        return;
      }
      
      // Create transaction
      const transaction = this.cli.localWallet.createTransaction(address, amountNum, feeNum, this.cli.localBlockchain);
      
      if (!transaction) {
        console.log(chalk.red('❌ Failed to create transaction.'));
        return;
      }

      // Submit transaction to daemon
      const response = await this.cli.makeApiRequest('/api/blockchain/transactions', 'POST', {
        transaction: transaction.toJSON()
      });
      
      console.log(chalk.green('✅ Transaction sent successfully!'));
      console.log(chalk.cyan(`Transaction ID: ${transaction.id}`));
      console.log(chalk.cyan(`Amount: ${amountNum} PAS`));
      console.log(chalk.cyan(`Fee: ${feeNum} PAS`));
      console.log(chalk.cyan(`To: ${address}`));
      
      // Add sent transaction to history
      const sentTransactionData = {
        id: transaction.id,
        type: 'sent',
        amount: amountNum,
        fee: feeNum,
        blockHeight: null, // Will be updated when block is mined
        txHash: transaction.id,
        timestamp: Date.now(),
        isCoinbase: false,
        address: address
      };
      this.cli.localWallet.addTransactionToHistory(sentTransactionData);
      
      // Update wallet balance
      this.cli.localWallet.updateBalance(this.cli.localBlockchain);
      
    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  async showWalletInfo() {
    try {
      if (!this.cli.walletLoaded) {
        console.log(chalk.red('❌ No wallet loaded. Use "wallet load" first.'));
        return;
      }

      // Sync with daemon if connected
      const connected = await this.cli.checkDaemonConnection();
      if (connected) {
        await this.syncWalletWithDaemon();
      }
      
      const info = this.cli.localWallet.getInfo();
      const syncState = this.cli.localWallet.getSyncState();
      
      console.log(chalk.blue('👛 Wallet Information:'));
      console.log(chalk.cyan(`Name: ${this.cli.walletName}`));
      console.log(chalk.cyan(`Address: ${info.address}`));
      console.log(chalk.cyan(`Balance: ${info.balance} PAS`));
      console.log(chalk.cyan(`UTXOs: ${info.utxoCount}`));
      console.log(chalk.cyan(`Has Seed: ${info.hasSeed ? 'Yes' : 'No'}`));
      console.log(chalk.cyan(`Auto Sync: ${this.cli.syncInterval ? 'Enabled' : 'Disabled'}`));
      console.log('');
      console.log(chalk.blue('📊 Sync Information:'));
      console.log(chalk.cyan(`Last Synced Height: ${syncState.lastSyncedHeight}`));
      console.log(chalk.cyan(`Last Synced Hash: ${syncState.lastSyncedHash ? syncState.lastSyncedHash.substring(0, 16) + '...' : 'None'}`));
      console.log(chalk.cyan(`Last Sync Time: ${syncState.lastSyncTime ? new Date(syncState.lastSyncTime).toLocaleString() : 'Never'}`));
      console.log(chalk.cyan(`Total Transactions: ${syncState.totalTransactions}`));
      console.log(chalk.cyan(`Last Balance: ${syncState.lastBalance} PAS`));
      
    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  async loadWallet() {
    try {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'walletName',
          message: 'Enter wallet name:',
          default: 'default'
        },
        {
          type: 'password',
          name: 'password',
          message: 'Enter wallet password:'
        }
      ]);

      const walletName = answers.walletName.endsWith('.wallet') ? answers.walletName : answers.walletName + '.wallet';
      const dataDir = this.cli.localBlockchain.dataDir || './data';
      const walletPath = path.join(process.cwd(), dataDir, walletName);

      if (!fs.existsSync(walletPath)) {
        console.log(chalk.red(`❌ Wallet file "${walletName}" not found.`));
        return;
      }

      // Load wallet
      this.cli.localWallet.loadFromFile(walletPath, answers.password);
      
      // Set wallet state
      this.cli.walletLoaded = true;
      this.cli.walletName = answers.walletName.replace('.wallet', '');
      this.cli.walletPath = walletPath;
      this.cli.walletPassword = answers.password;

      // Sync with daemon
      await this.syncWalletWithDaemon();
      
      // Start auto-sync
      this.startWalletSync();

      console.log(chalk.green('✅ Wallet loaded successfully!'));
      console.log(chalk.cyan(`Name: ${this.cli.walletName}`));
      console.log(chalk.cyan(`Wallet File: ${walletName}`));
      console.log(chalk.cyan(`Address: ${this.cli.localWallet.getAddress()}`));
      console.log(chalk.cyan(`Balance: ${this.cli.localWallet.getBalance()} PAS`));

    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  async unloadWallet() {
    try {
      if (!this.cli.walletLoaded) {
        console.log(chalk.yellow('⚠️  No wallet loaded.'));
        return;
      }

      // Stop auto-sync
      this.stopWalletSync();

      // Unload wallet
      this.cli.localWallet.unloadWallet();
      
      // Clear wallet state
      this.cli.walletLoaded = false;
      this.cli.walletName = null;
      this.cli.walletPath = null;
      this.cli.walletPassword = null;

      console.log(chalk.green('✅ Wallet unloaded successfully!'));

    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  async syncWalletWithDaemon() {
    try {
      if (!this.cli.walletLoaded) {
        console.log(chalk.red('❌ No wallet loaded. Use "wallet load" first.'));
        return false;
      }

      // Get current blockchain height from daemon
      const blockchainStatus = await this.cli.makeApiRequest('/api/blockchain/status');
      const currentHeight = blockchainStatus.height;

      // Check if wallet is already fully synced
      if (this.cli.localWallet.isFullySynced(currentHeight)) {
        console.log(chalk.green(`✅ Wallet already synced to height ${currentHeight}`));
        return true;
      }

      const syncState = this.cli.localWallet.getSyncState();
      const startIndex = syncState.lastSyncedHeight + 1;
      
      console.log(chalk.cyan(`🔄 Syncing wallet with blockchain (${startIndex} → ${currentHeight})...`));
      if (syncState.lastSyncedHeight > 0) {
        console.log(chalk.gray(`📊 Previous sync: ${syncState.lastSyncedHeight} blocks, ${syncState.totalTransactions} transactions`));
      }

      // Get blocks from daemon
      const response = await this.cli.makeApiRequest(`/api/blockchain/blocks?limit=${currentHeight}`);
      const blocks = response.blocks;

      // Track transactions for the wallet during sync
      const walletTransactions = [];

      // Process blocks
      for (const blockData of blocks) {
        if (blockData.index >= startIndex && blockData.index <= currentHeight) {
          try {
            const block = Block.fromJSON(blockData);
            
            // Check for wallet transactions in this block before adding it
            block.transactions.forEach(tx => {
              const walletAddress = this.cli.localWallet.getAddress();
              const isInvolved = tx.outputs.some(output => output.address === walletAddress) ||
                                tx.inputs.some(input => {
                                  // For inputs, we need to check if the previous output was to our address
                                  return false; // We'll focus on outputs for now
                                });
              
              if (isInvolved) {
                const receivedAmount = tx.outputs
                  .filter(output => output.address === walletAddress)
                  .reduce((sum, output) => sum + output.amount, 0);
                
                if (receivedAmount > 0) {
                  walletTransactions.push({
                    type: 'received',
                    amount: receivedAmount,
                    blockHeight: block.index,
                    txHash: tx.id,
                    address: walletAddress,
                    isCoinbase: tx.tag === 'COINBASE'
                  });
                  
                  // Add transaction to wallet history with processed data
                  const transactionData = {
                    id: tx.id,
                    type: 'received',
                    amount: receivedAmount,
                    blockHeight: block.index,
                    txHash: tx.id,
                    timestamp: block.timestamp,
                    isCoinbase: tx.tag === 'COINBASE',
                    address: walletAddress
                  };
                  this.cli.localWallet.addTransactionToHistory(transactionData);
                }
              }
            });
            
            this.cli.localBlockchain.addBlock(block, true); // Suppress logging
          } catch (error) {
            console.log(chalk.red(`❌ Failed to process block ${blockData.index}: ${error.message}`));
            return false;
          }
        }
      }

      // Display detailed transaction information
      walletTransactions.forEach(tx => {
        const blockInfo = ` | Block #${tx.blockHeight}`;
        const hashInfo = ` | Hash: ${tx.txHash.substring(0, 16)}...`;
        const addressInfo = tx.isCoinbase ? ` | From: coinbase` : ` | From: ${tx.address}`;
        if (tx.isCoinbase) {
          console.log(chalk.blue(`💰 Received ${tx.amount} PAS${blockInfo}${hashInfo}${addressInfo}`));
        } else {
          console.log(chalk.green(`💰 Received ${tx.amount} PAS${blockInfo}${hashInfo}${addressInfo}`));
        }
      });

      // Update wallet balance
      this.cli.localWallet.updateBalance(this.cli.localBlockchain);
      
      // Update sync state with current blockchain state
      const latestBlock = this.cli.localBlockchain.getLatestBlock();
      this.cli.localWallet.updateSyncState(
        currentHeight,
        latestBlock ? latestBlock.hash : null,
        walletTransactions.length
      );

      console.log(chalk.green(`✅ Wallet 100% synced! Balance: ${this.cli.localWallet.getBalance()} PAS`));
      console.log(chalk.gray(`📊 Sync progress: ${this.cli.localWallet.getSyncProgress(currentHeight)}%`));
      
      // Auto-save wallet with updated sync state
      try {
        this.cli.localWallet.saveWallet(this.cli.walletPath, this.cli.walletPassword);
        console.log(chalk.cyan('💾 Wallet auto-saved with sync state'));
      } catch (error) {
        console.log(chalk.yellow(`⚠️  Failed to auto-save wallet: ${error.message}`));
      }

      return true;

    } catch (error) {
      console.log(chalk.red(`❌ Failed to sync wallet: ${error.message}`));
      return false;
    }
  }

  startWalletSync() {
    // Start periodic sync every 30 seconds
    this.cli.syncInterval = setInterval(async () => {
      if (this.cli.walletLoaded) {
        await this.syncWalletWithDaemon();
      }
    }, 30000);
  }

  stopWalletSync() {
    if (this.cli.syncInterval) {
      clearInterval(this.cli.syncInterval);
      this.cli.syncInterval = null;
    }
  }

  async resyncWallet() {
    try {
      if (!this.cli.walletLoaded) {
        console.log(chalk.red('❌ No wallet loaded. Use "wallet load" first.'));
        return;
      }

      console.log(chalk.cyan('🔄 Force resyncing wallet from beginning...'));

      // Clear local blockchain and reinitialize
      this.cli.localBlockchain.clearChain();
      
      // Reset wallet sync state and clear transaction history
      this.cli.localWallet.resetSyncState();
      this.cli.localWallet.clearTransactionHistory();

      // Sync from beginning
      await this.syncWalletWithDaemon();

      console.log(chalk.green('✅ Wallet resync completed'));

    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  async saveWallet() {
    try {
      if (!this.cli.walletLoaded) {
        console.log(chalk.red('❌ No wallet loaded. Use "wallet load" first.'));
        return;
      }

      this.cli.localWallet.saveWallet(this.cli.walletPath, this.cli.walletPassword);
      console.log(chalk.green('✅ Wallet saved successfully!'));

    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  async showTransactionHistory() {
    try {
      if (!this.cli.walletLoaded) {
        console.log(chalk.red('❌ No wallet loaded. Use "wallet load" first.'));
        return;
      }

      const transactions = this.cli.localWallet.getTransactionHistory();
      const totalPages = this.cli.localWallet.getTransactionHistoryPages(10);
      
      if (transactions.length === 0) {
        console.log(chalk.yellow('📋 No transactions found in wallet history.'));
        console.log(chalk.cyan('💡 Try syncing your wallet first with "wallet sync"'));
        return;
      }

      console.log(chalk.blue(`📋 Wallet Transaction History (${transactions.length} transactions, ${totalPages} pages)`));
      console.log(chalk.gray('Use arrow keys to navigate, ESC to exit'));
      console.log('');

      let currentPage = 0;
      const pageSize = 10;

             const showPage = () => {
         // Clear screen and show header
         console.clear();
         console.log(chalk.blue.bold(`📋 Wallet Transaction History`));
         console.log(chalk.gray(`${transactions.length} transactions • Page ${currentPage + 1} of ${totalPages}`));
         console.log(chalk.gray('Use ← → to navigate, ESC to exit'));
         console.log('');

         const pageTransactions = this.cli.localWallet.getTransactionHistoryPage(currentPage, pageSize);
         
         if (pageTransactions.length === 0) {
           console.log(chalk.yellow('No transactions on this page.'));
         } else {
           pageTransactions.forEach((tx, index) => {
             const globalIndex = currentPage * pageSize + index + 1;
             const timestamp = tx.timestamp ? new Date(tx.timestamp).toLocaleString('en-US', {
               month: 'short',
               day: '2-digit',
               hour: '2-digit',
               minute: '2-digit'
             }) : 'Unknown';
             const amount = tx.amount || 0;
             
             // Determine transaction type and color
             let type, color, direction;
             if (tx.type === 'sent') {
               type = 'SENT';
               color = chalk.red;
               direction = `→ ${tx.address.substring(0, 8)}...`;
             } else if (tx.isCoinbase) {
               type = 'COINBASE';
               color = chalk.blue;
               direction = '← coinbase';
             } else {
               type = 'RECEIVED';
               color = chalk.green;
               direction = `← ${tx.address.substring(0, 8)}...`;
             }
             
             // Compact 2-line format
             const line1 = `${chalk.cyan(`${globalIndex.toString().padStart(2)}.`)} ${color(type.padEnd(8))} ${color(`${amount} PAS`.padEnd(12))} ${direction.padEnd(20)} ${chalk.gray(`Block ${tx.blockHeight || 'Pending'}`)}`;
             const line2 = `    ${chalk.gray(`Hash: ${tx.txHash ? tx.txHash.substring(0, 12) + '...' : 'Unknown'}`)} ${tx.fee ? chalk.yellow(`Fee: ${tx.fee} PAS`) : ''} ${chalk.gray(timestamp)}`;
             
             console.log(line1);
             console.log(line2);
             console.log('');
           });
         }

         // Footer navigation
         console.log(chalk.gray('─'.repeat(80)));
         console.log(chalk.gray(`← Previous page | → Next page | ESC Exit`));
       };

      showPage();

      // Set up keyboard input handling
      const readline = require('readline');
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);

      const handleKeypress = (str, key) => {
        if (key.ctrl && key.name === 'c') {
          process.exit();
        }

        switch (key.name) {
          case 'left':
            if (currentPage > 0) {
              currentPage--;
              showPage();
            }
            break;
          case 'right':
            if (currentPage < totalPages - 1) {
              currentPage++;
              showPage();
            }
            break;
          case 'escape':
            process.stdin.setRawMode(false);
            process.stdin.removeListener('keypress', handleKeypress);
            console.log(chalk.green('✅ Exited transaction history'));
            return;
        }
      };

      process.stdin.on('keypress', handleKeypress);

    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }
}

module.exports = WalletManager;
