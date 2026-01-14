#!/usr/bin/env node
/**
 * Update agent scripts with latest code
 */
const path = require('path');
const { generateMainCLIScript } = require(path.join(__dirname, '..', 'src', 'utils', 'apiGuideGenerator'));
const fs = require('fs');

const agentDir = process.argv[2] || '/home/onrm/projects/agentsMCPspace/AgentsMCPspace/tmp/temp_test_chat/chatspace/newagent_img';

// Read the env file to get encryption salt
const envPath = path.join(agentDir, '.env');
let salt = null;
try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const saltMatch = envContent.match(/ENCRYPTION_SALT="?([^"\n]+)"?/);
    salt = saltMatch ? saltMatch[1] : null;
} catch (e) {
    console.log('No .env file found, assuming no encryption');
}

console.log('Regenerating agent scripts with encryption:', !!salt);

// Generate the full CLI script to extract the message helper
const script = generateMainCLIScript('dummy', 'http://localhost:3000', salt);

// Extract message_helper.py from the script
// Pattern: cat > "$agent_dir/message_helper.py" <<'PYEOF' ... PYEOF
const pyMatch = script.match(/cat > "\$agent_dir\/message_helper\.py" <<'PYEOF'\n([\s\S]*?)\nPYEOF/);
if (pyMatch) {
    const pyContent = pyMatch[1];
    console.log('Found message_helper.py content, length:', pyContent.length);
    fs.writeFileSync(path.join(agentDir, 'message_helper.py'), pyContent);
    console.log('Updated message_helper.py');
} else {
    console.log('Could not find message_helper.py in generated script');
    // Debug: check what patterns exist
    if (script.includes('PYEOF')) {
        console.log('Script contains PYEOF marker');
        const idx = script.indexOf('PYEOF');
        console.log('Context:', script.substring(Math.max(0, idx - 100), idx + 10));
    }
}

// Extract agent-runner.sh
// Pattern: cat > "$agent_dir/agent-runner.sh" <<'RUNNEREOF' ... RUNNEREOF
const runnerMatch = script.match(/cat > "\$agent_dir\/agent-runner\.sh" <<'RUNNEREOF'\n([\s\S]*?)\nRUNNEREOF/);
if (runnerMatch) {
    const runnerContent = runnerMatch[1];
    console.log('Found agent-runner.sh content, length:', runnerContent.length);
    fs.writeFileSync(path.join(agentDir, 'agent-runner.sh'), runnerContent, { mode: 0o755 });
    console.log('Updated agent-runner.sh');
} else {
    console.log('Could not find agent-runner.sh in generated script');
}

console.log('\nDone! Restart the agent to use the updated scripts.');
