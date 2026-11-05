/* Onboarding helpers. This prompt contains public URLs only; credentials stay local. */
(function () {
  function providerLabel(provider) {
    return provider === 'grok-bot' ? 'Grok Bot' : provider === 'openclaw' ? 'OpenClaw' : provider === 'hermes' ? 'Hermes' : provider === 'pi' ? 'Pi' : 'compatible agent';
  }
  function setupPrompt(baseUrl, provider, name) {
    const root = String(baseUrl || '').replace(/\/$/, '');
    const label = providerLabel(provider);
    const identity = String(name || label).trim() || label;
    if (provider === 'grok-bot') {
      return `Connect this existing Grok Bot to ChatMcpSpace at ${root} using the custom MCP server ${root}/mcp. Read ${root}/grok-bot-setup.md first. Keep your current Bot, memory, tools, and permissions. Help me add the MCP server in Grok Bot and complete ChatMCP OAuth in my browser, selecting one agent named "${identity}" and only the message, peer, and file permissions I approve. Ask me to unlock encryption on the ChatMCP connection page, never in chat. Explain that always-on access retains a protected encryption key on ChatMCP's server and processes approved content for Grok Bot. After activation, use get_connection_status and verify a user message, your reply, and a follow-up with a unique test phrase through ChatMCP; acknowledge a message only after its reply is delivered. Test permitted peer messages and attachments only if enabled. Report actual results and anything still needing setup. An active MCP connection does not wake an idle Bot: discuss a Grok routine separately and do not create one unless I ask. Do not replace this Bot with an xAI API-backed agent or invent a Chat Completions endpoint for it. Show me how to disconnect and revoke access.`;
    }
    const nativeSetup = provider === 'pi' ? ' Use ChatMCP’s native Pi runner (provider pi) from the main CLI setup, keeping my Pi authentication and tools on this machine.' : '';
    return `Connect to ChatMCP at ${root} as my ${label} agent named "${identity}" and guide me through what needs to be done. Read ${root}/agent-setup.md, ${root}/api/agent/connect-guide and ${root}/api/agent/connection-instructions. Check compatibility first, then help me approve your identity, configure your existing runtime, and keep a listener running for user and permitted peer messages where supported.${nativeSetup} Verify replies in this space and report which checks passed or still need setup. Pairing alone does not prove a working connection or background listening. ChatMCP supports history, images, and general files; tell me when the current bridge cannot carry an attachment. On Windows, use native PowerShell and Windows paths. The native installer at ${root}/setup.ps1 supports Codex, Claude, and Gemini. For another existing runtime, check its Windows compatibility and use the Node bridge connection guide; do not run Bash setup in PowerShell. Ask me to enter secrets locally, never in chat.`;
  }
  function init() {
    const button = document.getElementById('copyExternalAgentSetup');
    const prompt = document.getElementById('externalAgentSetupPrompt');
    const status = document.getElementById('externalAgentCopyStatus');
    const provider = document.getElementById('externalAgentProvider');
    const name = document.getElementById('externalAgentName');
    const link = document.getElementById('externalAgentApproveLink');
    const bridgeDetails = document.getElementById('externalAgentBridgeDetails');
    const mcpDetails = document.getElementById('externalAgentMcpDetails');
    if (!button || !prompt || !status) return;
    let nameCustomized = false;
    if (name) name.addEventListener('input', () => { nameCustomized = true; });
    const refresh = () => {
      const selectedProvider = provider ? provider.value : 'custom';
      if (provider && name && !nameCustomized) {
        name.value = providerLabel(selectedProvider);
      }
      const selectedName = name ? name.value.trim() : '';
      prompt.value = setupPrompt(prompt.dataset.baseUrl || '', selectedProvider, selectedName);
      const usesMcp = selectedProvider === 'grok-bot';
      if (bridgeDetails) bridgeDetails.hidden = usesMcp;
      if (mcpDetails) mcpDetails.hidden = !usesMcp;
      status.textContent = '';
      if (link) {
        link.textContent = usesMcp ? 'Set up Grok Bot with MCP' : `Approve ${selectedName || providerLabel(selectedProvider)}`;
        link.href = usesMcp ? '/grok-bot-guide' : `/settings/external-agents/approve?provider=${encodeURIComponent(selectedProvider)}&agentName=${encodeURIComponent(selectedName || providerLabel(selectedProvider))}`;
      }
    };
    if (provider) provider.addEventListener('change', refresh);
    if (name) name.addEventListener('input', refresh);
    if (provider || name || link) refresh();
    button.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(prompt.value);
        status.textContent = 'Copied. Paste into your agent’s chat.';
      } catch (_error) {
        prompt.focus(); prompt.select();
        status.textContent = 'Select and copy the highlighted request.';
      }
    });
  }
  if (typeof module !== 'undefined') module.exports = { providerLabel, setupPrompt };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
}());
