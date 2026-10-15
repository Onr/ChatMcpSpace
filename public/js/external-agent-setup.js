/* Onboarding helpers. This prompt contains public URLs only; credentials stay local. */
(function () {
  function providerLabel(provider) {
    return provider === 'openclaw' ? 'OpenClaw' : provider === 'hermes' ? 'Hermes' : provider === 'pi' ? 'Pi' : 'compatible agent';
  }
  function setupPrompt(baseUrl, provider, name) {
    const root = String(baseUrl || '').replace(/\/$/, '');
    const label = providerLabel(provider);
    const identity = String(name || label).trim() || label;
    const nativeSetup = provider === 'pi' ? ' Use ChatMCP’s native Pi runner (provider pi) from the main CLI setup, keeping my Pi authentication and tools on this machine.' : '';
    return `Connect to ChatMCP at ${root} as my ${label} agent named "${identity}" and guide me through what needs to be done. Read ${root}/api/agent/connect-guide and ${root}/api/agent/connection-instructions. Help me approve your identity, configure your existing runtime, and keep a listener running for user and peer messages.${nativeSetup} Verify replies in this space. ChatMCP supports history, images, and general files; tell me when the current bridge cannot carry an attachment. Ask me to enter secrets locally, never in chat.`;
  }
  function init() {
    const button = document.getElementById('copyExternalAgentSetup');
    const prompt = document.getElementById('externalAgentSetupPrompt');
    const status = document.getElementById('externalAgentCopyStatus');
    const provider = document.getElementById('externalAgentProvider');
    const name = document.getElementById('externalAgentName');
    const link = document.getElementById('externalAgentApproveLink');
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
      if (link) {
        link.textContent = `Approve ${selectedName || providerLabel(selectedProvider)}`;
        link.href = `/settings/external-agents/approve?provider=${encodeURIComponent(selectedProvider)}&agentName=${encodeURIComponent(selectedName || providerLabel(selectedProvider))}`;
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
