const chalk = require('chalk');

/**
 * Validate wallet address format
 */
function validateAddress(address) {
  // Basic validation: check if it's a string and has the expected format
  if (typeof address !== 'string' || address.length < 26 || address.length > 35) {
    return false;
  }

  // Check if it starts with common cryptocurrency address prefixes
  // For this implementation, we'll use a simple format check
  const addressRegex = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
  return addressRegex.test(address);
}

/**
 * Format hash rate with appropriate units (H/s, KH/s, MH/s, GH/s)
 */
function formatHashRate(hashRate) {
  if (hashRate === 0) return '0 H/s';

  if (hashRate >= 1000000000) {
    return `${(hashRate / 1000000000).toFixed(2)} GH/s`;
  } else if (hashRate >= 1000000) {
    return `${(hashRate / 1000000).toFixed(2)} MH/s`;
  } else if (hashRate >= 1000) {
    return `${(hashRate / 1000).toFixed(2)} KH/s`;
  } else {
    return `${hashRate.toFixed(2)} H/s`;
  }
}

/**
 * Calculate current hash rate based on recent mining activity
 */
function calculateHashRate(totalHashes, miningStartTime, isMining) {
  if (!miningStartTime || !isMining) {
    return 0;
  }

  const elapsedTime = (Date.now() - miningStartTime) / 1000; // seconds
  if (elapsedTime === 0) return 0;

  // Estimate hash rate based on total hashes and time
  return Math.floor((totalHashes || 0) / elapsedTime);
}

/**
 * Generate CLI prompt based on wallet status and mining status
 */
function generatePrompt(walletLoaded, walletName, isMining = false) {
  let prompt = '';

  // Add mining indicator first if mining
  if (isMining) {
    prompt += chalk.blue('[') + chalk.red('Mining') + chalk.blue('] ');
  }

  // Add wallet name if loaded
  if (walletLoaded && walletName) {
    prompt += chalk.blue('[') + chalk.green(walletName) + chalk.blue('] ');
  }

  prompt += chalk.blue('pastella>');
  return prompt;
}

module.exports = {
  validateAddress,
  formatHashRate,
  calculateHashRate,
  generatePrompt,
};
