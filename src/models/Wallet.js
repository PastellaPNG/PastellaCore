const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CryptoUtils = require('../utils/crypto');
const { Transaction, TransactionInput, TransactionOutput } = require('./Transaction');
const { TRANSACTION_TAGS } = require('../utils/constants');

class Wallet {
    constructor() {
        this.privateKey = null;
        this.publicKey = null;
        this.address = null;
        this.seed = null;
        this.balance = 0;
        this.utxos = [];
        
        // Transaction history for wallet
        this.transactionHistory = [];
        
        // Sync state for persistent wallet synchronization
        this.syncState = {
            lastSyncedHeight: 0,
            lastSyncedHash: null,
            lastSyncTime: null,
            totalTransactions: 0,
            lastBalance: 0
        };
    }

    generateKeyPair(password) {
        const keyPair = CryptoUtils.generateKeyPair();
        this.privateKey = keyPair.privateKey;
        this.publicKey = keyPair.publicKey;
        this.seed = keyPair.seed;
        this.address = CryptoUtils.publicKeyToAddress(this.publicKey);
        
        return {
            privateKey: this.privateKey,
            publicKey: this.publicKey,
            seed: this.seed,
            address: this.address
        };
    }

    importFromSeed(seed, password) {
        try {
            const keyPair = CryptoUtils.importFromSeed(seed);
            this.privateKey = keyPair.privateKey;
            this.publicKey = keyPair.publicKey;
            this.seed = seed;
            this.address = CryptoUtils.publicKeyToAddress(this.publicKey);
            
            return {
                privateKey: this.privateKey,
                publicKey: this.publicKey,
                seed: this.seed,
                address: this.address
            };
        } catch (error) {
            throw new Error(`Failed to import from seed: ${error.message}`);
        }
    }

    importFromPrivateKey(privateKeyHex, password) {
        try {
            const keyPair = CryptoUtils.importPrivateKey(privateKeyHex);
            this.privateKey = keyPair.privateKey;
            this.publicKey = keyPair.publicKey;
            this.address = CryptoUtils.publicKeyToAddress(this.publicKey);
            
            return {
                privateKey: this.privateKey,
                publicKey: this.publicKey,
                address: this.address
            };
        } catch (error) {
            throw new Error(`Failed to import private key: ${error.message}`);
        }
    }

    getAddress() {
        return this.address;
    }

    getSeed() {
        return this.seed;
    }

    showSeedInfo(password) {
        if (!this.seed) {
            throw new Error('No seed available for this wallet');
        }
        
        return {
            privateKey: this.privateKey,
            seed: this.seed
        };
    }

    encryptWalletData(data, password) {
        const salt = crypto.randomBytes(16);
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const iv = crypto.randomBytes(16);
        
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        return {
            encrypted: encrypted,
            iv: iv.toString('hex'),
            salt: salt.toString('hex')
        };
    }

    decryptWalletData(encryptedData, password) {
        try {
            const key = crypto.pbkdf2Sync(password, Buffer.from(encryptedData.salt, 'hex'), 100000, 32, 'sha256');
            const iv = Buffer.from(encryptedData.iv, 'hex');
            
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            
            return JSON.parse(decrypted);
        } catch (error) {
            throw new Error('Invalid password or corrupted wallet file');
        }
    }

    ensureWalletExtension(filename) {
        if (!filename.endsWith('.wallet')) {
            return filename + '.wallet';
        }
        return filename;
    }

    saveToFile(filePath, password) {
        try {
            const walletData = {
                privateKey: this.privateKey,
                publicKey: this.publicKey,
                address: this.address,
                seed: this.seed,
                balance: this.balance,
                utxos: this.utxos,
                transactionHistory: this.transactionHistory,
                syncState: this.syncState
            };

            const encryptedData = this.encryptWalletData(walletData, password);
            
            // Ensure directory exists
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(filePath, JSON.stringify(encryptedData, null, 2));
            return true;
        } catch (error) {
            throw new Error(`Failed to save wallet: ${error.message}`);
        }
    }

    loadFromFile(filePath, password) {
        try {
            if (!fs.existsSync(filePath)) {
                throw new Error('Wallet file not found');
            }

            const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const walletData = this.decryptWalletData(fileData, password);

            this.privateKey = walletData.privateKey;
            this.publicKey = walletData.publicKey;
            this.address = walletData.address;
            this.seed = walletData.seed;
            this.balance = walletData.balance || 0;
            this.utxos = walletData.utxos || [];
            this.transactionHistory = walletData.transactionHistory || [];
            this.syncState = walletData.syncState || {
                lastSyncedHeight: 0,
                lastSyncedHash: null,
                lastSyncTime: null,
                totalTransactions: 0,
                lastBalance: 0
            };

            return true;
        } catch (error) {
            throw new Error(`Failed to load wallet: ${error.message}`);
        }
    }

    load(name, password) {
        try {
            const filePath = this.ensureWalletExtension(name);
            return this.loadFromFile(filePath, password);
        } catch (error) {
            throw new Error(`Failed to load wallet '${name}': ${error.message}`);
        }
    }

    updateBalance(blockchain, onTransactionDetected = null) {
        const oldBalance = this.balance;
        const oldUtxoCount = this.utxos.length;
        const oldUtxoKeys = new Set(this.utxos.map(utxo => `${utxo.txHash}:${utxo.outputIndex}`));
        
        this.utxos = blockchain.getUTXOsForAddress(this.address);
        this.balance = this.utxos.reduce((total, utxo) => total + utxo.amount, 0);
        
        // Check for new transactions (received or sent)
        if (onTransactionDetected && (this.balance !== oldBalance || this.utxos.length !== oldUtxoCount)) {
            // Find new UTXOs (received transactions)
            const newUtxos = this.utxos.filter(utxo => !oldUtxoKeys.has(`${utxo.txHash}:${utxo.outputIndex}`));
            
            // Find spent UTXOs (sent transactions)
            const newUtxoKeys = new Set(this.utxos.map(utxo => `${utxo.txHash}:${utxo.outputIndex}`));
            const spentUtxos = this.utxos.filter(utxo => oldUtxoKeys.has(`${utxo.txHash}:${utxo.outputIndex}`) && !newUtxoKeys.has(`${utxo.txHash}:${utxo.outputIndex}`));
            
            // Group new UTXOs by transaction
            const newTransactions = new Map();
            newUtxos.forEach(utxo => {
                if (!newTransactions.has(utxo.txHash)) {
                    newTransactions.set(utxo.txHash, {
                        type: 'received',
                        txHash: utxo.txHash,
                        blockHeight: this.findBlockHeightForTransaction(blockchain, utxo.txHash),
                        outputs: []
                    });
                }
                newTransactions.get(utxo.txHash).outputs.push({
                    address: this.address,
                    amount: utxo.amount
                });
            });
            
            // Report new received transactions
            newTransactions.forEach(transaction => {
                const totalAmount = transaction.outputs.reduce((sum, output) => sum + output.amount, 0);
                onTransactionDetected('received', totalAmount, {
                    txHash: transaction.txHash,
                    blockHeight: transaction.blockHeight,
                    address: this.address,
                    amount: totalAmount
                });
            });
            
            // For sent transactions, we need to look at the blockchain to find the actual transaction details
            // This is more complex as we need to find the transaction that spent our UTXOs
            const balanceChange = this.balance - oldBalance;
            if (balanceChange < 0) {
                // This indicates we spent coins, but we don't have detailed info from UTXOs alone
                // We'll report the total amount sent
                onTransactionDetected('sent', Math.abs(balanceChange), {
                    address: this.address,
                    amount: Math.abs(balanceChange)
                });
            }
        }
        
        return this.balance;
    }
    
    /**
     * Find the block height for a given transaction hash
     */
    findBlockHeightForTransaction(blockchain, txHash) {
        for (let i = 0; i < blockchain.chain.length; i++) {
            const block = blockchain.chain[i];
            if (block.transactions.some(tx => tx.id === txHash)) {
                return block.index;
            }
        }
        return null;
    }

    getBalance() {
        return this.balance;
    }

    getUTXOCount() {
        return this.utxos.length;
    }

    createTransaction(toAddress, amount, fee, blockchain, tag = TRANSACTION_TAGS.TRANSACTION) {
        // Users can only create TRANSACTION tagged transactions
        if (tag !== TRANSACTION_TAGS.TRANSACTION) {
            throw new Error('Users can only create TRANSACTION tagged transactions. Other tags are reserved for system use.');
        }
        
        if (amount + fee > this.balance) {
            throw new Error('Insufficient balance');
        }

        // Find UTXOs to spend
        const utxosToSpend = [];
        let totalInput = 0;
        
        for (const utxo of this.utxos) {
            if (totalInput >= amount + fee) break;
            utxosToSpend.push(utxo);
            totalInput += utxo.amount;
        }

        if (totalInput < amount + fee) {
            throw new Error('Insufficient UTXOs to cover transaction');
        }

        // Create transaction inputs
        const inputs = utxosToSpend.map(utxo => new TransactionInput(
            utxo.txHash, // Changed from utxo.txId to utxo.txHash
            utxo.outputIndex,
            null, // signature will be set later
            this.publicKey
        ));

        // Create transaction outputs
        const outputs = [
            new TransactionOutput(toAddress, amount)
        ];

        // Add change output if needed
        const change = totalInput - amount - fee;
        if (change > 0) {
            outputs.push(new TransactionOutput(this.address, change));
        }

        // Create transaction with tag
        const transaction = new Transaction(inputs, outputs, fee, tag);
        
        // Sign the transaction
        const txData = transaction.getDataToSign();
        for (let i = 0; i < inputs.length; i++) {
            const signature = CryptoUtils.sign(txData, this.privateKey);
            transaction.inputs[i].signature = signature;
        }

        transaction.id = transaction.calculateId();
        return transaction;
    }

    getInfo() {
        return {
            address: this.address,
            balance: this.balance,
            utxoCount: this.utxos.length,
            hasSeed: !!this.seed
        };
    }

    isLoaded() {
        return !!(this.privateKey && this.publicKey && this.address);
    }

    saveWallet(filePath = null, password = null) {
        if (!this.isLoaded()) {
            throw new Error('No wallet loaded to save');
        }
        
        if (!filePath) {
            throw new Error('File path is required for saving wallet');
        }
        
        try {
            this.saveToFile(filePath, password);
            return true;
        } catch (error) {
            throw new Error(`Failed to save wallet: ${error.message}`);
        }
    }

    unloadWallet() {
        this.privateKey = null;
        this.publicKey = null;
        this.address = null;
        this.seed = null;
        this.balance = 0;
        this.utxos = [];
        this.transactionHistory = [];
        this.syncState = {
            lastSyncedHeight: 0,
            lastSyncedHash: null,
            lastSyncTime: null,
            totalTransactions: 0,
            lastBalance: 0
        };
        return true;
    }

    // Sync state methods
    getSyncState() {
        return this.syncState;
    }

    updateSyncState(height, hash, transactionCount = 0) {
        this.syncState.lastSyncedHeight = height;
        this.syncState.lastSyncedHash = hash;
        this.syncState.lastSyncTime = Date.now();
        this.syncState.totalTransactions = transactionCount;
        this.syncState.lastBalance = this.balance;
    }

    resetSyncState() {
        this.syncState = {
            lastSyncedHeight: 0,
            lastSyncedHash: null,
            lastSyncTime: null,
            totalTransactions: 0,
            lastBalance: 0
        };
    }

    isFullySynced(currentHeight) {
        return this.syncState.lastSyncedHeight >= currentHeight;
    }

    getSyncProgress(currentHeight) {
        if (currentHeight === 0) return 100;
        return Math.round((this.syncState.lastSyncedHeight / currentHeight) * 100);
    }

    // Transaction history methods
    addTransactionToHistory(transaction) {
        // Add transaction to history if not already present
        const exists = this.transactionHistory.find(tx => tx.id === transaction.id);
        if (!exists) {
            this.transactionHistory.unshift(transaction); // Add to beginning (most recent first)
        }
    }

    getTransactionHistory() {
        return this.transactionHistory;
    }

    getTransactionHistoryPage(page, pageSize = 10) {
        const startIndex = page * pageSize;
        const endIndex = startIndex + pageSize;
        return this.transactionHistory.slice(startIndex, endIndex);
    }

    getTransactionHistoryPages(pageSize = 10) {
        return Math.ceil(this.transactionHistory.length / pageSize);
    }

    clearTransactionHistory() {
        this.transactionHistory = [];
    }
}

module.exports = Wallet; 