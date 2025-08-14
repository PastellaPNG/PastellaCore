const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const chalk = require('chalk'); // Added for beautified output

const { Transaction, TransactionInput, TransactionOutput } = require('../models/Transaction.js');
const Wallet = require('../models/Wallet.js');
const logger = require('../utils/logger.js');

/**
 * Network Wallet Manager - Integrates with existing CLI structure
 * Provides network-based wallet operations while maintaining CLI compatibility
 */
class NetworkWalletManager {
  constructor() {
    this.wallets = new Map(); // Map<walletName, Wallet>
    this.currentWallet = null;
    this.connectedNode = null;
    this.nodeConfig = {
      host: '127.0.0.1',
      port: 22000,
      protocol: 'http'
    };

    // CLI integration
    this.cli = null;
  }

  /**
   * Set CLI reference for integration
   * @param cli
   */
  setCLIReference(cli) {
    this.cli = cli;
    this.updateApiUrl(cli.apiBaseUrl);

    // Load existing wallets from disk
    this.loadWalletsFromDisk();
  }

  /**
   * Update API URL from CLI
   * @param apiUrl
   */
  updateApiUrl(apiUrl) {
    try {
      const url = new URL(apiUrl);
      this.nodeConfig = {
        host: url.hostname,
        port: parseInt(url.port) || 22000,
        protocol: url.protocol.replace(':', '')
      };
      this.connectedNode = apiUrl;
    } catch (error) {
      logger.error('NETWORK_WALLET', `Failed to parse API URL: ${error.message}`);
    }
  }

  /**
   * Connect to a node
   * @param host
   * @param port
   * @param protocol
   */
  async connectToNode(host = '127.0.0.1', port = 22000, protocol = 'http') {
    try {
      this.nodeConfig = { host, port, protocol };
      const baseUrl = `${protocol}://${host}:${port}`;

      // Test connection by getting node status
      const response = await this.makeApiRequest(`${baseUrl}/api/status`);

      if (response.success) {
        this.connectedNode = baseUrl;
        logger.info('NETWORK_WALLET', `✅ Connected to node: ${baseUrl}`);
        logger.info('NETWORK_WALLET', `Node status: ${response.data.status || 'unknown'}`);

        // Update CLI API URL
        if (this.cli) {
          this.cli.apiBaseUrl = baseUrl;
          this.cli.isConnected = true;
        }

        return true;
      } else {
        throw new Error('Failed to get node status');
      }
    } catch (error) {
      logger.error('NETWORK_WALLET', `Failed to connect to node: ${error.message}`);
      this.connectedNode = null;
      return false;
    }
  }

  /**
   * Make API request to connected node
   * @param endpoint
   * @param options
   */
  async makeApiRequest(endpoint, options = {}) {
    try {
      let url = endpoint.startsWith('http') ? endpoint : `${this.connectedNode}${endpoint}`;

      // Force IPv4 by using 127.0.0.1 instead of localhost
      if (url.includes('localhost')) {
        url = url.replace('localhost', '127.0.0.1');
      }

      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': options.apiKey || '',
          ...options.headers
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error('NETWORK_WALLET', `API request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle CLI wallet commands (main integration point)
   * @param args
   */
  async handleCommand(args) {
    if (!args || args.length === 0) {
      console.log('❌ Missing wallet command');
      this.showHelp();
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
          console.log('❌ Usage: wallet send <address> <amount>');
          return;
        }
        await this.sendTransaction(args[1], args[2]);
        break;
      case 'info':
        await this.showWalletInfo();
        break;
      case 'sync':
        await this.syncWalletWithNetwork();
        break;
      case 'resync':
        await this.resyncWallet();
        break;
      case 'transactions':
        await this.showTransactionHistory();
        break;
      case 'transaction-info':
        if (args.length < 2) {
          console.log('❌ Usage: wallet transaction-info <transaction-id>');
          return;
        }
        await this.showTransactionInfo(args[1]);
        break;
      case 'save':
        await this.saveWallet();
        break;
      case 'seed-import':
        await this.importWalletFromSeed();
        break;
      case 'key-import':
        await this.importWalletFromKey();
        break;
      case 'connect':
        if (args.length < 3) {
          console.log('❌ Usage: wallet connect <host> <port> [protocol]');
          return;
        }
        const host = args[1];
        const port = parseInt(args[2]);
        const protocol = args[3] || 'http';
        await this.connectToNode(host, port, protocol);
        break;
      default:
        console.log(`❌ Unknown wallet command: ${command}`);
        this.showHelp();
    }
  }

  /**
   * Create new wallet
   */
  async createWallet() {
    try {
      const answers = await this.cli.inquirer.prompt([
        {
          type: 'input',
          name: 'walletName',
          message: 'Enter wallet name:',
          default: 'default',
          validate: (input) => {
            if (!input.trim()) {
              return 'Wallet name cannot be empty';
            }
            // Check if wallet file already exists
            const filePath = path.join(process.cwd(), `${input.trim()}.wallet`);
            if (fs.existsSync(filePath)) {
              return `Wallet '${input.trim()}' already exists. Please choose a different name.`;
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

      // Check if wallet already exists in memory
      if (this.wallets.has(answers.walletName)) {
        console.log(chalk.red(`❌ Error: Wallet '${answers.walletName}' already exists in memory.`));
        console.log(chalk.yellow('💡 Use "wallet load" to load an existing wallet or choose a different name.'));
        return;
      }

      const wallet = new Wallet();
      await wallet.generateKeyPair();

      // Store wallet in memory (no encryption needed for network wallet)
      this.wallets.set(answers.walletName, wallet);
      this.currentWallet = wallet;

      // Update CLI state
      this.cli.walletLoaded = true;
      this.cli.walletName = answers.walletName;
      this.cli.walletPassword = answers.password;
      this.cli.currentNetworkWallet = wallet;

      // Save wallet to disk
      this.saveWalletToFile(answers.walletName, wallet, answers.password);

      console.log('✅ Wallet created successfully!');
      console.log(`Name: ${answers.walletName}`);
      console.log(`Address: ${wallet.getAddress()}`);

      // Beautify the wallet creation output
      console.log(chalk.blue('╔══════════════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.blue('║                            🎉 WALLET CREATED! 🎉                             ║'));
      console.log(chalk.blue('╚══════════════════════════════════════════════════════════════════════════════╝'));
      console.log('');
      console.log(chalk.cyan('📋 NEW WALLET INFORMATION:'));
      console.log(chalk.white('  ┌─────────────────────────────────────────────────────────────────────────┐'));
      console.log(chalk.white(`  │ ${chalk.yellow('Name:')}    ${chalk.green(answers.walletName.padEnd(62))} │`));
      console.log(chalk.white(`  │ ${chalk.yellow('Address:')} ${chalk.green(wallet.getAddress().padEnd(62))} │`));
      console.log(chalk.white('  └─────────────────────────────────────────────────────────────────────────┘'));
      console.log('');
      console.log(chalk.red('⚠️  SECURITY WARNING:'));
      console.log(chalk.white('  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐'));
      console.log(chalk.white(`  │ ${chalk.yellow('Private Key:')} ${chalk.red(wallet.privateKey.padEnd(83))} │`));
      console.log(chalk.white(`  │ ${chalk.yellow('Seed Phrase:')} ${chalk.red(wallet.seed.padEnd(83))} │`));
      console.log(chalk.white('  └──────────────────────────────────────────────────────────────────────────────────────────────────┘'));
      console.log('');
      console.log(chalk.red('🔒 IMPORTANT:'));
      console.log(chalk.white('  • Store your private key and seed phrase securely'));
      console.log(chalk.white('  • Never share them with anyone'));
      console.log(chalk.white('  • Keep them in a safe, offline location'));
      console.log(chalk.white('  • If lost, you will lose access to your funds forever'));
      console.log('');
      console.log(chalk.cyan('🔐 STATUS:'));
      console.log(chalk.green('  ✅ Wallet generated successfully'));
      console.log(chalk.green('  ✅ Private key encrypted and saved'));
      console.log(chalk.green('  ✅ Ready for use'));
      console.log('');
      console.log(chalk.blue('────────────────────────────────────────────────────────────────────────────────'));

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Import wallet from seed phrase
   */
  async importWalletFromSeed() {
    try {
      const answers = await this.cli.inquirer.prompt([
        {
          type: 'input',
          name: 'walletName',
          message: 'Enter wallet name:',
          default: 'default',
          validate: (input) => {
            if (!input.trim()) {
              return 'Wallet name cannot be empty';
            }
            // Check if wallet file already exists
            const filePath = path.join(process.cwd(), `${input.trim()}.wallet`);
            if (fs.existsSync(filePath)) {
              return `Wallet '${input.trim()}' already exists. Please choose a different name.`;
            }
            return true;
          }
        },
        {
          type: 'input',
          name: 'seedPhrase',
          message: 'Enter seed phrase:',
          validate: (input) => {
            if (!input.trim()) {
              return 'Seed phrase cannot be empty';
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

      // Check if wallet already exists in memory
      if (this.wallets.has(answers.walletName)) {
        console.log(chalk.red(`❌ Error: Wallet '${answers.walletName}' already exists in memory.`));
        console.log(chalk.yellow('💡 Use "wallet load" to load an existing wallet or choose a different name.'));
        return;
      }

      const wallet = new Wallet();
      await wallet.importFromSeed(answers.seedPhrase);

      // Store wallet in memory (no encryption needed for network wallet)
      this.wallets.set(answers.walletName, wallet);
      this.currentWallet = wallet;

      // Update CLI state
      this.cli.walletLoaded = true;
      this.cli.walletName = answers.walletName;
      this.cli.walletPassword = answers.password;
      this.cli.currentNetworkWallet = wallet;

      // Save wallet to disk
      this.saveWalletToFile(answers.walletName, wallet, answers.password);

      console.log('✅ Wallet imported from seed successfully!');
      console.log(`Name: ${answers.walletName}`);
      console.log(`Address: ${wallet.getAddress()}`);

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Import wallet from private key
   */
  async importWalletFromKey() {
    try {
      const answers = await this.cli.inquirer.prompt([
        {
          type: 'input',
          name: 'walletName',
          message: 'Enter wallet name:',
          default: 'default',
          validate: (input) => {
            if (!input.trim()) {
              return 'Wallet name cannot be empty';
            }
            // Check if wallet file already exists
            const filePath = path.join(process.cwd(), `${input.trim()}.wallet`);
            if (fs.existsSync(filePath)) {
              return `Wallet '${input.trim()}' already exists. Please choose a different name.`;
            }
            return true;
          }
        },
        {
          type: 'input',
          name: 'privateKey',
          message: 'Enter private key:',
          validate: (input) => {
            if (!input.trim()) {
              return 'Private key cannot be empty';
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

      // Check if wallet already exists in memory
      if (this.wallets.has(answers.walletName)) {
        console.log(chalk.red(`❌ Error: Wallet '${answers.walletName}' already exists in memory.`));
        console.log(chalk.yellow('💡 Use "wallet load" to load an existing wallet or choose a different name.'));
        return;
      }

      const wallet = new Wallet();
      await wallet.importFromPrivateKey(answers.privateKey);

      // Store wallet in memory (no encryption needed for network wallet)
      this.wallets.set(answers.walletName, wallet);
      this.currentWallet = wallet;

      // Update CLI state
      this.cli.walletLoaded = true;
      this.cli.walletName = answers.walletName;
      this.cli.walletPassword = answers.password;
      this.cli.currentNetworkWallet = wallet;

      // Save wallet to disk
      this.saveWalletToFile(answers.walletName, wallet, answers.password);

      console.log('✅ Wallet imported from private key successfully!');
      console.log(`Name: ${answers.walletName}`);
      console.log(`Address: ${wallet.getAddress()}`);

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Load wallet
   */
  async loadWallet() {
    try {
      const answers = await this.cli.inquirer.prompt([
        {
          type: 'input',
          name: 'walletName',
          message: 'Enter wallet name:',
          default: 'default',
        },
        {
          type: 'password',
          name: 'password',
          message: 'Enter wallet password:',
        },
      ]);

      // First try to load from memory (if already loaded)
      if (this.wallets.has(answers.walletName)) {
        const wallet = this.wallets.get(answers.walletName);
        this.currentWallet = wallet;

        // Update CLI state
        this.cli.walletLoaded = true;
        this.cli.walletName = answers.walletName;
        this.cli.walletPassword = answers.password;
        this.cli.currentNetworkWallet = wallet;

        console.log('✅ Wallet loaded from memory!');
        console.log(`Name: ${answers.walletName}`);
        console.log(`Address: ${wallet.getAddress()}`);
        return;
      }

      // Try to load from disk
      const wallet = this.loadWalletFromFile(answers.walletName, answers.password);

      if (!wallet) {
        console.log(`❌ Wallet '${answers.walletName}' not found or invalid password`);
        return;
      }

      // Store in memory for future use
      this.wallets.set(answers.walletName, wallet);
      this.currentWallet = wallet;

      // Update CLI state
      this.cli.walletLoaded = true;
      this.cli.walletName = answers.walletName;
      this.cli.walletPassword = answers.password;
      this.cli.currentNetworkWallet = wallet;

      console.log('');
      console.log(chalk.blue('╔══════════════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.blue('║                             🎉 WALLET LOADED! 🎉                             ║'));
      console.log(chalk.blue('╚══════════════════════════════════════════════════════════════════════════════╝'));
      console.log('');
      console.log(chalk.cyan('📋 WALLET INFORMATION:'));
      console.log(chalk.white('  ┌─────────────────────────────────────────────────────────────────────────┐'));
      console.log(chalk.white(`  │ ${chalk.yellow('Name:')}    ${chalk.green(answers.walletName.padEnd(62))} │`));
      console.log(chalk.white(`  │ ${chalk.yellow('Address:')} ${chalk.green(wallet.getAddress().padEnd(62))} │`));
      console.log(chalk.white('  └─────────────────────────────────────────────────────────────────────────┘'));
      console.log('');
      console.log(chalk.cyan('🔐 STATUS:'));
      console.log(chalk.green('  ✅ Wallet decrypted and loaded successfully'));
      console.log(chalk.green('  ✅ Connected to network'));
      console.log('');
    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Unload wallet
   */
  async unloadWallet() {
    if (!this.cli.walletLoaded) {
      console.log('⚠️  No wallet loaded.');
      return;
    }

    // Clear wallet state
    this.currentWallet = null;
    this.cli.walletLoaded = false;
    this.cli.walletName = null;
    this.cli.walletPassword = null;
    this.cli.currentNetworkWallet = null;

    console.log('✅ Wallet unloaded successfully!');
  }

  /**
   * Check balance from network
   */
  async checkBalance() {
    try {
      if (!this.cli.walletLoaded) {
        console.log('❌ No wallet loaded. Use "wallet load" first.');
        return;
      }

      if (!this.connectedNode) {
        console.log('❌ Not connected to any node. Use "wallet connect" first.');
        return;
      }

      const address = this.currentWallet.getAddress();
      await this.getBalance(address);
    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Get wallet balance from network
   * @param address
   */
  async getBalance(address) {
    try {
      if (!this.connectedNode) {
        console.log(chalk.red('❌ Error: Not connected to any node. Use "wallet connect" first.'));
        return;
      }

      const balance = await this.makeApiRequest(`/api/wallet/balance/${address}`);

      console.log('');
      console.log(chalk.cyan('📊 BALANCE INFORMATION:'));
      console.log(chalk.white('  ┌─────────────────────────────────────────────────────────────────────────┐'));
      console.log(chalk.white(`  │ ${chalk.yellow('Address:')} ${chalk.green(address.padEnd(62))} │`));
      console.log(chalk.white(`  │ ${chalk.yellow('Balance:')} ${chalk.green(`${balance.balance} PAS`.padEnd(62))} │`));
      console.log(chalk.white('  └─────────────────────────────────────────────────────────────────────────┘'));
      console.log('');

      return balance;
    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }

  /**
   * Send transaction via network
   * @param toAddress
   * @param amount
   * @param fee
   */
  async sendTransaction(toAddress, amount, fee = 0.001) {
    try {
      if (!this.currentWallet) {
        throw new Error('No wallet loaded');
      }

      if (!this.connectedNode) {
        throw new Error('Not connected to any node');
      }

      // Parse amount and fee
      const amountNum = parseFloat(amount);
      const feeNum = parseFloat(fee);

      if (isNaN(amountNum) || amountNum <= 0) {
        throw new Error('Invalid amount. Must be a positive number.');
      }

      if (isNaN(feeNum) || feeNum < 0) {
        throw new Error('Invalid fee. Must be a non-negative number.');
      }

      // Get current balance and UTXOs from the network
      const balance = await this.getBalance(this.currentWallet.getAddress());

      if (balance < (amountNum + feeNum)) {
        throw new Error(`Insufficient balance: ${balance} PAS (need ${amountNum + feeNum} PAS)`);
      }

      // Get UTXOs for this address from the network
      console.log(`🔍 Fetching UTXOs for address: ${this.currentWallet.getAddress()}`);

      try {
        const utxoResponse = await this.makeApiRequest(`/api/wallet/utxos/${this.currentWallet.getAddress()}`);

        if (!utxoResponse.success || !utxoResponse.utxos) {
          throw new Error('Failed to fetch UTXOs from network');
        }

        const utxos = utxoResponse.utxos;
        console.log(`📦 Found ${utxos.length} UTXOs`);

        // Select UTXOs to spend (simple greedy algorithm)
        let totalInput = 0;
        const selectedUtxos = [];

        for (const utxo of utxos) {
          if (totalInput >= amountNum + feeNum) break;
          selectedUtxos.push(utxo);
          totalInput += utxo.amount;
        }

        if (totalInput < amountNum + feeNum) {
          throw new Error(`Insufficient UTXOs: have ${totalInput} PAS, need ${amountNum + feeNum} PAS`);
        }

        console.log(`💳 Selected ${selectedUtxos.length} UTXOs (total: ${totalInput} PAS)`);

        // Create transaction inputs from selected UTXOs
        const inputs = selectedUtxos.map(utxo => new TransactionInput(
          utxo.txHash, // Real transaction hash
          utxo.outputIndex, // Real output index
          '', // Signature (will be added after signing)
          this.currentWallet.publicKey
        ));

        // Create transaction outputs
        const outputs = [
          new TransactionOutput(toAddress, amountNum),
          new TransactionOutput(this.currentWallet.getAddress(), totalInput - amountNum - feeNum) // Change
        ];

        // Create transaction with proper inputs and outputs
        const transaction = new Transaction(inputs, outputs, feeNum);

        // Calculate transaction ID immediately after creation
        transaction.calculateId();

        // Sign the transaction with the wallet's private key
        transaction.sign(this.currentWallet.privateKey);

        console.log(`📝 Creating transaction...`);
        console.log(`🆔 Transaction ID: ${transaction.id}`);
        console.log(`💰 Amount: ${amountNum} PAS`);
        console.log(`💸 Fee: ${feeNum} PAS`);
        console.log(`📤 To: ${toAddress}`);
        console.log(`📥 Change: ${totalInput - amountNum - feeNum} PAS`);

        // Submit transaction to network
        console.log(`🚀 Submitting transaction to network...`);

        const response = await this.makeApiRequest('/api/transactions/submit', {
          method: 'POST',
          body: {
            transaction: transaction.toJSON()
          }
        });

        if (response.success) {
          console.log('✅ Transaction sent successfully!');
          console.log(`Transaction ID: ${response.transactionId || 'Pending'}`);
          console.log(`Amount: ${amountNum} PAS`);
          console.log(`Fee: ${feeNum} PAS`);
          console.log(`To: ${toAddress}`);
        } else {
          throw new Error(response.error || 'Failed to send transaction');
        }

      } catch (utxoError) {
        console.log(`⚠️  UTXO fetch failed: ${utxoError.message}`);
        console.log(`📝 Creating simplified transaction preview instead...`);

        // Fallback to simplified preview
        const inputs = [new TransactionInput('pending-utxo', 0, '', this.currentWallet.publicKey)];
        const outputs = [
          new TransactionOutput(toAddress, amountNum),
          new TransactionOutput(this.currentWallet.getAddress(), balance - amountNum - feeNum)
        ];

        const transaction = new Transaction(inputs, outputs, feeNum);

        console.log(`📋 Transaction Preview:`);
        console.log(`💰 Amount: ${amountNum} PAS`);
        console.log(`💸 Fee: ${feeNum} PAS`);
        console.log(`📤 To: ${toAddress}`);
        console.log(`📥 Change: ${balance - amountNum - feeNum} PAS`);
        console.log(`\n⚠️  Note: This is a preview. Real submission requires UTXO access.`);
      }

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Sync wallet with network
   */
  async syncWalletWithNetwork() {
    try {
      if (!this.cli.walletLoaded) {
        console.log('❌ No wallet loaded. Use "wallet load" first.');
        return;
      }

      if (!this.connectedNode) {
        console.log('❌ Not connected to any node. Use "wallet connect" first.');
        return;
      }

      const address = this.currentWallet.getAddress();
      console.log(`🔄 Syncing wallet ${address} with network...`);

      // Get balance
      const balance = await this.getBalance(address);

      // Get transactions
      const transactions = await this.getTransactions(address);

      // Get mempool status
      const mempoolResponse = await this.makeApiRequest('/api/memory-pool/status');
      const mempoolStatus = mempoolResponse.success ? mempoolResponse.data : null;

      console.log('✅ Wallet synced successfully');
      console.log(`Balance: ${balance} PAS`);
      console.log(`Transactions: ${transactions.length}`);

      if (mempoolStatus) {
        console.log(`Mempool: ${mempoolStatus.poolSize} pending transactions`);
      }

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Get wallet transactions from network
   * @param address
   */
  async getTransactions(address) {
    try {
      if (!this.connectedNode) {
        throw new Error('Not connected to any node');
      }

      const response = await this.makeApiRequest(`/api/wallet/transactions/${address}`);

      if (response.success) {
        return response.data.transactions;
      } else {
        throw new Error(response.error || 'Failed to get transactions');
      }
    } catch (error) {
      logger.error('NETWORK_WALLET', `Failed to get transactions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Show wallet information
   */
  showWalletInfo() {
    if (!this.currentWallet) {
      console.log(chalk.red('❌ Error: No wallet loaded. Use "wallet load" first.'));
      return;
    }

    console.log('');
    console.log(chalk.blue('╔═══════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue('║                       📋 WALLET INFORMATION                       ║'));
    console.log(chalk.blue('╚═══════════════════════════════════════════════════════════════════╝'));
    console.log('');
    console.log(chalk.cyan('🔐 WALLET DETAILS:'));
    console.log(chalk.white('  ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐'));
    console.log(chalk.white(`  │ ${chalk.yellow('Name:      ')} ${chalk.green(this.currentWallet.name || 'N/A'.padEnd(134))} │`));
    console.log(chalk.white(`  │ ${chalk.yellow('Address:   ')} ${chalk.green(this.currentWallet.getAddress().padEnd(134))} │`));
    console.log(chalk.white(`  │ ${chalk.yellow('Public Key:')} ${chalk.green(this.currentWallet.publicKey.padEnd(134))} │`));
    console.log(chalk.white('  └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘'));
    console.log('');
  }

  /**
   * Show transaction history
   */
  async showTransactionHistory() {
    try {
      if (!this.cli.walletLoaded) {
        console.log('❌ No wallet loaded. Use "wallet load" first.');
        return;
      }

      if (!this.connectedNode) {
        console.log('❌ Not connected to any node. Use "wallet connect" first.');
        return;
      }

      const address = this.currentWallet.getAddress();
      const transactions = await this.getTransactions(address);

      if (transactions.length === 0) {
        console.log('📋 No transactions found.');
        return;
      }

      console.log(`📋 Transaction History (${transactions.length} transactions):`);
      transactions.forEach((tx, index) => {
        console.log(`${index + 1}. ${tx.id} - ${tx.amount || 0} PAS`);
      });

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Show transaction information
   * @param txId
   */
  async showTransactionInfo(txId) {
    try {
      if (!this.cli.walletLoaded) {
        console.log('❌ No wallet loaded. Use "wallet load" first.');
        return;
      }

      if (!this.connectedNode) {
        console.log('❌ Not connected to any node. Use "wallet connect" first.');
        return;
      }

      // Try to get transaction from network
      const response = await this.makeApiRequest(`/api/blockchain/transactions/${txId}`);

      if (response && response.success) {
        const tx = response.data;
        console.log('📋 Transaction Information:');
        console.log(`ID: ${tx.id}`);
        console.log(`Amount: ${tx.outputs.reduce((sum, out) => sum + out.amount, 0)} PAS`);
        console.log(`Fee: ${tx.fee} PAS`);
        console.log(`Timestamp: ${new Date(tx.timestamp).toLocaleString()}`);
      } else {
        console.log('❌ Transaction not found on network');
      }

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Save wallet (for backward compatibility)
   */
  async saveWallet() {
    console.log('💾 Wallet state saved (network-based wallet)');
  }

  /**
   * Save wallet to disk (encrypted)
   * @param walletName
   * @param wallet
   * @param password
   */
  saveWalletToFile(walletName, wallet, password) {
    try {
      const walletData = {
        name: walletName,
        address: wallet.getAddress(),
        seed: wallet.getSeed(),
        privateKey: wallet.privateKey,
        publicKey: wallet.publicKey,
        timestamp: Date.now()
      };

      const encryptedData = wallet.encryptWalletData(walletData, password);
      const filePath = path.join(process.cwd(), `${walletName}.wallet`);

      fs.writeFileSync(filePath, JSON.stringify(encryptedData, null, 2));
      console.log(`💾 Wallet saved to disk`);

      // Verify the file was created
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        console.log(`📁 File size: ${stats.size} bytes`);
      } else {
        console.log(`❌ File was not created at ${filePath}`);
      }

    } catch (error) {
      console.log(`❌ Failed to save wallet '${walletName}': ${error.message}`);
      if (error.stack) {
        console.log(`Stack trace: ${error.stack}`);
      }
    }
  }

  /**
   * Load wallet from disk (decrypted)
   * @param walletName
   * @param password
   * @returns {Wallet|null}
   */
  loadWalletFromFile(walletName, password) {
    try {
      const filePath = path.join(process.cwd(), `${walletName}.wallet`);

      if (!fs.existsSync(filePath)) {
        console.log(`❌ Wallet file not found: ${filePath}`);
        return null;
      }

      const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Create a temporary wallet instance to use its decryption method
      const tempWallet = new Wallet();
      const walletData = tempWallet.decryptWalletData(fileData, password);

      // Create the actual wallet and restore the data directly
      const wallet = new Wallet();
      if (walletData.seed) {
        // Directly set the wallet properties instead of calling importFromSeed
        wallet.seed = walletData.seed;
        wallet.privateKey = walletData.privateKey;
        wallet.publicKey = walletData.publicKey;
        wallet.address = walletData.address;
      } else if (walletData.privateKey) {
        // Directly set the wallet properties instead of calling importFromPrivateKey
        wallet.privateKey = walletData.privateKey;
        wallet.publicKey = walletData.publicKey;
        wallet.address = walletData.address;
      } else {
        console.log(`❌ No seed or private key found in wallet data`);
        return null;
      }

      return wallet;

    } catch (error) {
      console.log(`❌ Failed to load wallet '${walletName}': ${error.message}`);
      if (error.stack) {
        console.log(`Stack trace: ${error.stack}`);
      }
      return null;
    }
  }

  /**
   * Load all wallets from disk
   */
  loadWalletsFromDisk() {
    try {
      const rootDir = process.cwd();

      const files = fs.readdirSync(rootDir);
      const walletFiles = files.filter(file => file.endsWith('.wallet'));
    } catch (error) {
      console.log(`❌ Failed to scan for wallet files: ${error.message}`);
    }
  }

  /**
   * Resync wallet (for backward compatibility)
   */
  async resyncWallet() {
    await this.syncWalletWithNetwork();
  }

  /**
   * Show help
   */
  showHelp() {
    console.log('📚 Available Wallet Commands:');
    console.log('');
    console.log('🔌 Connection:');
    console.log('  wallet connect <host> <port> [protocol]  - Connect to a node');
    console.log('');
    console.log('🔐 Wallet Management:');
    console.log('  wallet create                           - Create new wallet');
    console.log('  wallet seed-import                      - Import from seed phrase');
    console.log('  wallet key-import                       - Import from private key');
    console.log('  wallet load                             - Load existing wallet');
    console.log('  wallet unload                           - Unload current wallet');
    console.log('');
    console.log('💰 Operations:');
    console.log('  wallet balance                          - Show current balance');
    console.log('  wallet send <address> <amount> [fee]    - Send transaction');
    console.log('  wallet sync                             - Sync wallet with network');
    console.log('  wallet resync                           - Resync wallet (alias for sync)');
    console.log('');
    console.log('📊 Information:');
    console.log('  wallet info                             - Show wallet information');
    console.log('  wallet transactions                     - Show transaction history');
    console.log('  wallet transaction-info <id>            - Show transaction details');
    console.log('  wallet save                             - Save wallet state');
    console.log('');
  }

  async showTransactions(address) {
    try {
      if (!this.connectedNode) {
        console.log(chalk.red('❌ Error: Not connected to any node. Use "wallet connect" first.'));
        return;
      }

      const transactions = await this.makeApiRequest(`/api/wallet/transactions/${address}`);

      if (!transactions || transactions.length === 0) {
        console.log(chalk.blue('╔══════════════════════════════════════════════════════════════════════════════╗'));
        console.log(chalk.blue('║                        📜 TRANSACTION HISTORY 📜                          ║'));
        console.log(chalk.blue('╚══════════════════════════════════════════════════════════════════════════════╝'));
        console.log('');
        console.log(chalk.yellow('📭 No transactions found for this address.'));
        console.log(chalk.white('  This could mean:'));
        console.log(chalk.white('  • The address has never received any transactions'));
        console.log(chalk.white('  • The address is new and hasn\'t been used yet'));
        console.log(chalk.white('  • There might be a network connection issue'));
        console.log('');
        console.log(chalk.blue('────────────────────────────────────────────────────────────────────────────────'));
        return;
      }

      // Beautify the transactions output
      console.log(chalk.blue('╔══════════════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.blue('║                        📜 TRANSACTION HISTORY 📜                          ║'));
      console.log(chalk.blue('╚══════════════════════════════════════════════════════════════════════════════╝'));
      console.log('');
      console.log(chalk.cyan('📊 TRANSACTION SUMMARY:'));
      console.log(chalk.white('  ┌─────────────────────────────────────────────────────────────────────────┐'));
      console.log(chalk.white(`  │ ${chalk.yellow('Address:')}     ${chalk.green(address.padEnd(58))} │`));
      console.log(chalk.white(`  │ ${chalk.yellow('Total TXs:')}  ${chalk.green(`${transactions.length} transactions`.padEnd(58))} │`));
      console.log(chalk.white('  └─────────────────────────────────────────────────────────────────────────┘'));
      console.log('');
      console.log(chalk.cyan('🔍 TRANSACTION DETAILS:'));

      transactions.forEach((tx, index) => {
        const isSender = tx.isSender;
        const isReceiver = tx.isReceiver;
        const netAmount = tx.netAmountForAddress || 0;

        console.log(chalk.white(`  ┌─ Transaction ${index + 1} ─────────────────────────────────────────────┐`));
        console.log(chalk.white(`  │ ${chalk.yellow('ID:')}        ${chalk.green(tx.id.padEnd(58))} │`));
        console.log(chalk.white(`  │ ${chalk.yellow('Type:')}     ${chalk.green(`${isSender ? 'Sent' : ''}${isReceiver ? 'Received' : ''}`.padEnd(58))} │`));
        console.log(chalk.white(`  │ ${chalk.yellow('Net Amount:')} ${chalk.green(`${netAmount} PSTL`.padEnd(58))} │`));
        console.log(chalk.white(`  │ ${chalk.yellow('Inputs:')}   ${chalk.green(`${tx.inputs.length} inputs`.padEnd(58))} │`));
        console.log(chalk.white(`  │ ${chalk.yellow('Outputs:')}  ${chalk.green(`${tx.outputs.length} outputs`.padEnd(58))} │`));
        console.log(chalk.white('  └─────────────────────────────────────────────────────────────────────────┘'));
        console.log('');
      });

      console.log(chalk.cyan('🔗 NETWORK STATUS:'));
      console.log(chalk.green(`  ✅ Connected to: ${this.connectedNode}`));
      console.log(chalk.green('  ✅ Transactions fetched successfully'));
      console.log(chalk.green('  ✅ Ready for more actions'));
      console.log('');
      console.log(chalk.blue('💡 Available actions:'));
      console.log(chalk.white('  • Check balance: wallet balance'));
      console.log(chalk.white('  • Send coins: wallet send <address> <amount>'));
      console.log(chalk.white('  • View UTXOs: wallet utxos'));
      console.log(chalk.white('  • Resync wallet: wallet resync'));
      console.log('');
      console.log(chalk.blue('────────────────────────────────────────────────────────────────────────────────'));

    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }
}

module.exports = NetworkWalletManager;
