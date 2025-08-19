const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const fetch = require('node-fetch');
const { toAtomicUnits, fromAtomicUnits, formatAtomicUnits } = require('../utils/atomicUnits.js');

const { Transaction, TransactionInput, TransactionOutput } = require('../models/Transaction.js');
const { Wallet } = require('../models/Wallet.js');
const logger = require('../utils/logger.js');

/**
 * Network Wallet Manager - Pure API-based wallet that connects to any node
 * No blockchain.json dependency - syncs directly from network nodes
 */
class WalletManager {
  constructor() {
    this.wallets = new Map(); // Map<walletName, Wallet>
    this.currentWallet = null;
    this.connectedNode = null;
    this.nodeConfig = {
      host: '127.0.0.1',
      port: 22000,
      protocol: 'http',
    };

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
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
        logger.info('WALLET_MANAGER', `✅ Connected to node: ${baseUrl}`);
        logger.info('WALLET_MANAGER', `Node status: ${response.data.status || 'unknown'}`);
        return true;
      } else {
        throw new Error('Failed to get node status');
      }
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to connect to node: ${error.message}`);
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
      const url = endpoint.startsWith('http') ? endpoint : `${this.connectedNode}${endpoint}`;

      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': options.apiKey || '',
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error('WALLET_MANAGER', `API request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create new wallet
   * @param name
   * @param password
   */
  async createWallet(name, password) {
    try {
      if (this.wallets.has(name)) {
        throw new Error(`Wallet '${name}' already exists`);
      }

      const wallet = new Wallet();
      await wallet.generateKeyPair();

      // Encrypt private key with password
      const encryptedWallet = await wallet.encrypt(password);

      this.wallets.set(name, wallet);
      this.currentWallet = wallet;

      logger.info('WALLET_MANAGER', `✅ Wallet '${name}' created successfully`);
      logger.info('WALLET_MANAGER', `Address: ${wallet.getAddress()}`);

      return wallet;
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to create wallet: ${error.message}`);
      throw error;
    }
  }

  /**
   * Import wallet from seed phrase
   * @param name
   * @param seedPhrase
   * @param password
   */
  async importWalletFromSeed(name, seedPhrase, password) {
    try {
      if (this.wallets.has(name)) {
        throw new Error(`Wallet '${name}' already exists`);
      }

      const wallet = new Wallet();
      await wallet.importFromSeed(seedPhrase);

      // Encrypt private key with password
      const encryptedWallet = await wallet.encrypt(password);

      this.wallets.set(name, wallet);
      this.currentWallet = wallet;

      logger.info('WALLET_MANAGER', `✅ Wallet '${name}' imported from seed successfully`);
      logger.info('WALLET_MANAGER', `Address: ${wallet.getAddress()}`);

      return wallet;
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to import wallet from seed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Import wallet from private key
   * @param name
   * @param privateKey
   * @param password
   */
  async importWalletFromKey(name, privateKey, password) {
    try {
      if (this.wallets.has(name)) {
        throw new Error(`Wallet '${name}' already exists`);
      }

      const wallet = new Wallet();
      await wallet.importFromPrivateKey(privateKey);

      // Encrypt private key with password
      const encryptedWallet = await wallet.encrypt(password);

      this.wallets.set(name, wallet);
      this.currentWallet = wallet;

      logger.info('WALLET_MANAGER', `✅ Wallet '${name}' imported from private key successfully`);
      logger.info('WALLET_MANAGER', `Address: ${wallet.getAddress()}`);

      return wallet;
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to import wallet from private key: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load wallet
   * @param name
   * @param password
   */
  async loadWallet(name, password) {
    try {
      if (!this.wallets.has(name)) {
        throw new Error(`Wallet '${name}' not found`);
      }

      const wallet = this.wallets.get(name);
      await wallet.decrypt(password);

      this.currentWallet = wallet;
      logger.info('WALLET_MANAGER', `✅ Wallet '${name}' loaded successfully`);

      return wallet;
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to load wallet: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get wallet balance from network
   * @param address
   */
  async getBalance(address) {
    try {
      if (!this.connectedNode) {
        throw new Error('Not connected to any node');
      }

      const response = await this.makeApiRequest(`/api/wallet/balance/${address}`);

      if (response.success) {
        return response.data.balance;
      } else {
        throw new Error(response.error || 'Failed to get balance');
      }
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to get balance: ${error.message}`);
      throw error;
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
      logger.error('WALLET_MANAGER', `Failed to get transactions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send transaction via network
   * @param toAddress
   * @param amount
   * @param fee
   */
  async sendTransaction(toAddress, amount, fee = 100000) {
    try {
      if (!this.currentWallet) {
        throw new Error('No wallet loaded');
      }

      if (!this.connectedNode) {
        throw new Error('Not connected to any node');
      }

      // Convert amount and fee to atomic units if they're not already
      const atomicAmount = typeof amount === 'string' ? toAtomicUnits(amount) : amount;
      const atomicFee = typeof fee === 'string' ? toAtomicUnits(fee) : fee;

      // Get current balance
      const balance = await this.getBalance(this.currentWallet.getAddress());

      if (balance < atomicAmount + atomicFee) {
        throw new Error(
          `Insufficient balance: ${formatAtomicUnits(balance)} PAS (need ${formatAtomicUnits(atomicAmount + atomicFee)} PAS)`
        );
      }

      // Create transaction
      const transaction = new Transaction();
      transaction.addInput(this.currentWallet.getAddress(), balance);
      transaction.addOutput(toAddress, atomicAmount);
      transaction.addOutput(this.currentWallet.getAddress(), balance - atomicAmount - atomicFee); // Change
      transaction.fee = atomicFee;

      // Sign transaction
      transaction.sign(this.currentWallet.getPrivateKey());

      // Submit to network
      const response = await this.makeApiRequest('/api/transactions/submit', {
        method: 'POST',
        body: {
          transaction: transaction.toJSON(),
        },
      });

      if (response.success) {
        logger.info('WALLET_MANAGER', `✅ Transaction sent successfully: ${response.data.transactionId}`);
        return response.data.transactionId;
      } else {
        throw new Error(response.error || 'Failed to send transaction');
      }
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to send transaction: ${error.message}`);
      throw error;
    }
  }

  /**
   * Sync wallet with network
   * @param address
   */
  async syncWallet(address) {
    try {
      if (!this.connectedNode) {
        throw new Error('Not connected to any node');
      }

      logger.info('WALLET_MANAGER', `🔄 Syncing wallet ${address} with network...`);

      // Get balance
      const balance = await this.getBalance(address);

      // Get transactions
      const transactions = await this.getTransactions(address);

      // Get mempool status
      const mempoolResponse = await this.makeApiRequest('/api/memory-pool/status');
      const mempoolStatus = mempoolResponse.success ? mempoolResponse.data : null;

      logger.info('WALLET_MANAGER', `✅ Wallet synced successfully`);
      logger.info('WALLET_MANAGER', `Balance: ${formatAtomicUnits(balance)} PAS`);
      logger.info('WALLET_MANAGER', `Transactions: ${transactions.length}`);

      if (mempoolStatus) {
        logger.info('WALLET_MANAGER', `Mempool: ${mempoolStatus.poolSize} pending transactions`);
      }

      return {
        balance,
        transactions,
        mempoolStatus,
      };
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to sync wallet: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get network status
   */
  async getNetworkStatus() {
    try {
      if (!this.connectedNode) {
        throw new Error('Not connected to any node');
      }

      const response = await this.makeApiRequest('/api/status');

      if (response.success) {
        return response.data;
      } else {
        throw new Error(response.error || 'Failed to get network status');
      }
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to get network status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get blockchain status
   */
  async getBlockchainStatus() {
    try {
      if (!this.connectedNode) {
        throw new Error('Not connected to any node');
      }

      const response = await this.makeApiRequest('/api/blockchain/status');

      if (response.success) {
        return response.data;
      } else {
        throw new Error(response.error || 'Failed to get blockchain status');
      }
    } catch (error) {
      logger.error('WALLET_MANAGER', `Failed to get blockchain status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Interactive CLI mode
   */
  async startInteractiveMode() {
    console.log('🔐 Pastella Network Wallet Manager');
    console.log('=====================================');
    console.log('Type "help" for available commands');
    console.log('');

    const prompt = () => {
      this.rl.question('wallet> ', async input => {
        try {
          await this.processCommand(input.trim());
    } catch (error) {
          console.error(`❌ Error: ${error.message}`);
        }
        prompt();
      });
    };

    prompt();
  }

  /**
   * Process CLI commands
   * @param command
   */
  async processCommand(command) {
    const parts = command.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'help':
        this.showHelp();
        break;

      case 'connect':
        if (parts.length < 3) {
          console.log('Usage: connect <host> <port> [protocol]');
        return;
      }
        const host = parts[1];
        const port = parseInt(parts[2]);
        const protocol = parts[3] || 'http';
        await this.connectToNode(host, port, protocol);
        break;

      case 'create':
        if (parts.length < 3) {
          console.log('Usage: create <name> <password>');
          return;
        }
        await this.createWallet(parts[1], parts[2]);
        break;

      case 'seed-import':
        if (parts.length < 4) {
          console.log('Usage: seed-import <name> <seed-phrase> <password>');
        return;
      }
        const seedPhrase = parts.slice(2, -1).join(' ');
        const seedPassword = parts[parts.length - 1];
        await this.importWalletFromSeed(parts[1], seedPhrase, seedPassword);
        break;

      case 'key-import':
        if (parts.length < 4) {
          console.log('Usage: key-import <name> <private-key> <password>');
          return;
        }
        const privateKey = parts[2];
        const keyPassword = parts[3];
        await this.importWalletFromKey(parts[1], privateKey, keyPassword);
        break;

      case 'load':
        if (parts.length < 3) {
          console.log('Usage: load <name> <password>');
          return;
        }
        await this.loadWallet(parts[1], parts[2]);
        break;

      case 'balance':
        if (!this.currentWallet) {
          console.log('❌ No wallet loaded. Use "load <name> <password>" first.');
          return;
        }
        const balance = await this.getBalance(this.currentWallet.getAddress());
        console.log(`💰 Balance: ${formatAtomicUnits(balance)} PAS`);
        break;

      case 'send':
        if (parts.length < 4) {
          console.log('Usage: send <to-address> <amount> [fee]');
          return;
        }
        if (!this.currentWallet) {
          console.log('❌ No wallet loaded. Use "load <name> <password>" first.');
          return;
        }
        const amount = parseFloat(parts[2]);
        const fee = parts[3] ? parseFloat(parts[3]) : 100000; // 0.001 PAS in atomic units
        await this.sendTransaction(parts[1], amount, fee);
            break;

      case 'sync':
        if (!this.currentWallet) {
          console.log('❌ No wallet loaded. Use "load <name> <password>" first.');
          return;
        }
        await this.syncWallet(this.currentWallet.getAddress());
        break;

      case 'status':
        await this.showStatus();
        break;

      case 'quit':
      case 'exit':
        console.log('👋 Goodbye!');
        this.rl.close();
        process.exit(0);
            break;

      default:
        if (command.trim()) {
          console.log(`❓ Unknown command: ${cmd}. Type "help" for available commands.`);
        }
    }
  }

  /**
   * Show help
   */
  showHelp() {
    console.log('📚 Available Commands:');
    console.log('');
    console.log('🔌 Connection:');
    console.log('  connect <host> <port> [protocol]  - Connect to a node');
    console.log('');
    console.log('🔐 Wallet Management:');
    console.log('  create <name> <password>          - Create new wallet');
    console.log('  seed-import <name> <seed> <pass>  - Import from seed phrase');
    console.log('  key-import <name> <key> <pass>    - Import from private key');
    console.log('  load <name> <password>            - Load existing wallet');
    console.log('');
    console.log('💰 Operations:');
    console.log('  balance                            - Show current balance');
    console.log('  send <address> <amount> [fee]     - Send transaction');
    console.log('  sync                               - Sync wallet with network');
    console.log('');
    console.log('📊 Information:');
    console.log('  status                             - Show network status');
    console.log('  help                               - Show this help');
    console.log('  quit/exit                          - Exit wallet manager');
    console.log('');
  }

  /**
   * Show current status
   */
  async showStatus() {
    console.log('📊 Current Status:');
    console.log('==================');

    if (this.connectedNode) {
      console.log(`🔌 Connected to: ${this.connectedNode}`);

      try {
        const networkStatus = await this.getNetworkStatus();
        console.log(`🌐 Network: ${networkStatus.status || 'unknown'}`);

        const blockchainStatus = await this.getBlockchainStatus();
        console.log(`🔗 Blockchain: ${blockchainStatus.length || 0} blocks`);
        console.log(`⏰ Latest block: ${blockchainStatus.latestBlock || 'unknown'}`);
        } catch (error) {
        console.log(`❌ Failed to get status: ${error.message}`);
        }
      } else {
      console.log('❌ Not connected to any node');
    }

    if (this.currentWallet) {
      console.log(`🔐 Wallet: ${this.currentWallet.getAddress()}`);
    } else {
      console.log('🔐 No wallet loaded');
    }

    console.log(`📁 Wallets: ${this.wallets.size} available`);
    console.log('');
  }
}

module.exports = WalletManager;
