#!/usr/bin/env node
/**
 * Update agent scripts with latest code
 * Uses the shared agentUpdater utility for consistent script generation.
 */
const path = require('path');
const fs = require('fs');
const { buildUpdateManifest, readAgentEncryptionInfo } = require(path.join(__dirname, '..', 'src', 'utils', 'agentUpdater'));

const agentDir = process.argv[2];
if (!agentDir) {
    console.error('Usage: update-agent-scripts.js <agent_dir>');
    process.exit(1);
}

const resolvedDir = path.resolve(agentDir);

// Read encryption info from the agent's .env
const { hasEncryption } = readAgentEncryptionInfo(resolvedDir);
console.log('Encryption enabled:', hasEncryption);

// Build the update manifest using the shared utility
const manifest = buildUpdateManifest(hasEncryption);
console.log(`Generating v${manifest.version} scripts (${Object.keys(manifest.files).length} files)...`);

// Backup current files
const backupDir = path.join(resolvedDir, 'agent_state', 'backups', `v${manifest.version}-${Date.now()}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const filename of Object.keys(manifest.files)) {
    const src = path.join(resolvedDir, filename);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, filename));
    }
}
console.log('Backed up current files to:', backupDir);

// Write each updated file
for (const [filename, content] of Object.entries(manifest.files)) {
    const dest = path.join(resolvedDir, filename);
    const mode = filename.endsWith('.sh') ? 0o755 : 0o644;
    fs.writeFileSync(dest, content, { mode });
    console.log(`Updated: ${filename} (${content.length} bytes)`);
}

// Track version
const versionFile = path.join(resolvedDir, 'agent_state', '.current-version');
fs.mkdirSync(path.dirname(versionFile), { recursive: true });
fs.writeFileSync(versionFile, manifest.version);

console.log(`\nDone! Agent updated to v${manifest.version}. Restart the agent to use the new code.`);
