#!/usr/bin/env node
/**
 * Regenerate agent-cli.sh Script
 * 
 * This script regenerates the agent-cli.sh file using the apiGuideGenerator
 * without requiring a server restart. Run this after code changes to apply
 * updated templates immediately.
 * 
 * Usage: node scripts/regenerate-cli.js [--api-key <key>] [--base-url <url>] [--salt <salt>]
 * 
 * If not provided, values will be read from:
 * 1. Command line arguments
 * 2. Existing agent-cli.sh file
 * 3. Default values
 */

const fs = require('fs');
const path = require('path');

// Import the generator
const { generateMainCLIScript } = require('../src/utils/apiGuideGenerator');

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const result = {};

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--api-key' && args[i + 1]) {
            result.apiKey = args[++i];
        } else if (args[i] === '--base-url' && args[i + 1]) {
            result.baseUrl = args[++i];
        } else if (args[i] === '--salt' && args[i + 1]) {
            result.salt = args[++i];
        } else if (args[i] === '--output' && args[i + 1]) {
            result.output = args[++i];
        } else if (args[i] === '--help' || args[i] === '-h') {
            console.log(`
Regenerate agent-cli.sh Script

Usage: node scripts/regenerate-cli.js [options]

Options:
  --api-key <key>    API key to embed in the script
  --base-url <url>   Base URL for the API (default: http://localhost:3000)
  --salt <salt>      Encryption salt (optional)
  --output <path>    Output file path (default: ./agent-cli.sh)
  --help, -h         Show this help message

If options are not provided, values will be extracted from existing agent-cli.sh
`);
            process.exit(0);
        }
    }

    return result;
}

// Extract values from existing agent-cli.sh
function extractFromExisting(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const result = {};

        // Extract API_KEY
        const apiKeyMatch = content.match(/^API_KEY="([^"]+)"/m);
        if (apiKeyMatch) result.apiKey = apiKeyMatch[1];

        // Extract API_BASE (remove /api suffix to get base URL)
        const apiBaseMatch = content.match(/^API_BASE="([^"]+)"/m);
        if (apiBaseMatch) {
            result.baseUrl = apiBaseMatch[1].replace(/\/api$/, '');
        }

        // Extract ENCRYPTION_SALT
        const saltMatch = content.match(/^ENCRYPTION_SALT="([^"]*)"/m);
        if (saltMatch && saltMatch[1]) result.salt = saltMatch[1];

        return result;
    } catch (err) {
        return {};
    }
}

async function main() {
    const scriptDir = path.dirname(__dirname);
    const defaultOutputPath = path.join(scriptDir, 'agent-cli.sh');

    // Parse command line args
    const args = parseArgs();

    // Try to extract from existing file
    const existing = extractFromExisting(args.output || defaultOutputPath);

    // Merge: args > existing > defaults
    const config = {
        apiKey: args.apiKey || existing.apiKey || 'YOUR_API_KEY',
        baseUrl: args.baseUrl || existing.baseUrl || 'http://localhost:3000',
        salt: args.salt || existing.salt || null,
        output: args.output || defaultOutputPath
    };

    console.log('Regenerating agent-cli.sh with:');
    console.log(`  API Key: ${config.apiKey.substring(0, 8)}...`);
    console.log(`  Base URL: ${config.baseUrl}`);
    console.log(`  Encryption: ${config.salt ? 'enabled' : 'disabled'}`);
    console.log(`  Output: ${config.output}`);
    console.log('');

    try {
        // Generate the new script
        const script = generateMainCLIScript(config.apiKey, config.baseUrl, config.salt);

        // Write to file
        fs.writeFileSync(config.output, script, { mode: 0o755 });

        console.log('✓ Successfully regenerated agent-cli.sh');
        console.log('');
        console.log('Run with: bash agent-cli.sh');
    } catch (err) {
        console.error('✗ Failed to regenerate:', err.message);
        process.exit(1);
    }
}

main();
