/**
 * Agent Updater Utility
 * Generates update payloads for hot-updating running agents.
 * Reuses the same generators from apiGuideGenerator.js to ensure
 * updated agents get the exact same code as newly created agents.
 */

const path = require('path');
const fs = require('fs');
const {
  generateMessageHelperPython,
  generateAgentRunner,
  generateAgentInstructions,
  generateOneshotInstructions,
  getCurrentAgentCliVersion
} = require('./apiGuideGenerator');

/**
 * Get the current agent CLI/runtime version
 * @returns {string} Version string
 */
function getPlatformVersion() {
  return getCurrentAgentCliVersion();
}

/**
 * Build an update manifest containing the latest versions of all updatable agent files.
 *
 * @param {boolean} hasEncryption - Whether the agent uses E2E encryption
 * @param {Object} [options] - Optional overrides
 * @param {boolean} [options.instructionsOnly=false] - Only update instruction files
 * @returns {{ version: string, files: Record<string, string>, instructionsOnly: boolean }}
 */
function buildUpdateManifest(hasEncryption, options = {}) {
  const { instructionsOnly = false } = options;
  const version = getPlatformVersion();
  const files = {};

  // Always include instructions
  files['AGENT_INSTRUCTIONS.md'] = generateAgentInstructions();
  files['ONESHOT_AGENT_INSTRUCTIONS.md'] = generateOneshotInstructions();

  if (!instructionsOnly) {
    // Encryption is mandatory — always generate the encrypted variant
    files['message_helper.py'] = generateMessageHelperPython(true);
    files['agent-runner.sh'] = generateAgentRunner();
  }

  return { version, files, instructionsOnly };
}

/**
 * Read an agent's .env to determine encryption status
 * @param {string} agentDir - Absolute path to agent directory
 * @returns {{ hasEncryption: boolean, salt: string|null }}
 */
function readAgentEncryptionInfo(agentDir) {
  const envPath = path.join(agentDir, '.env');
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const saltMatch = envContent.match(/ENCRYPTION_SALT="?([^"\n]+)"?/);
    const salt = saltMatch ? saltMatch[1] : null;
    const pwMatch = envContent.match(/USER_PASSWORD="?([^"\n]*)"?/);
    const hasPassword = pwMatch && pwMatch[1].length > 0;
    return {
      hasEncryption: !!(salt && hasPassword),
      salt
    };
  } catch {
    return { hasEncryption: false, salt: null };
  }
}

module.exports = {
  getPlatformVersion,
  buildUpdateManifest,
  readAgentEncryptionInfo
};
