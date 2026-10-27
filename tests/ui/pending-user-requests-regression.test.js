/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const { getProviderModelCatalog, STATIC_PROVIDER_MODELS } = require('../../src/utils/modelCatalog');
const setupPlatform = require('../../public/js/setup-platform');

const dashboardSource = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const dashboardEjs = fs.readFileSync(path.join(__dirname, '../../views/dashboard.ejs'), 'utf8');

describe('Pending user requests regressions', () => {
  test('includes gpt-6.1-terra (GPT-6.1 Terra) in model catalogs', () => {
    expect(STATIC_PROVIDER_MODELS.codex).toContainEqual({ value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' });
    expect(STATIC_PROVIDER_MODELS.openai).toContainEqual({ value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' });
    expect(STATIC_PROVIDER_MODELS.openrouter).toContainEqual({ value: 'openai/gpt-6.1-terra', label: 'GPT-6.1 Terra' });
    const catalog = getProviderModelCatalog('test-user');
    expect(catalog.codex.some((m) => m.value === 'gpt-6.1-terra')).toBe(true);
  });

  test('Windows setup command uses powershell.exe -Command so pasting into Bash/WSL works', () => {
    const steps = setupPlatform.setupSteps('https://chatmcp.space', 'windows', false);
    expect(steps[0].command).toMatch(/^powershell\.exe -NoProfile -ExecutionPolicy Bypass -Command "/);
    expect(steps[0].command).toContain("Invoke-RestMethod -Uri 'https://chatmcp.space/setup.ps1' -ErrorAction Stop");
  });

  test('dashboard.ejs renders pressable Need Attention and Urgent filter buttons', () => {
    expect(dashboardEjs).toContain('id="statsFilterAttentionBtn"');
    expect(dashboardEjs).toContain('data-agent-status-filter="attention"');
    expect(dashboardEjs).toContain('id="statsFilterUrgentBtn"');
    expect(dashboardEjs).toContain('data-agent-status-filter="urgent"');
  });

  test('filterAgentListByStatus supports attention and urgent filters and toggles back to all', () => {
    const start = dashboardSource.indexOf('const VALID_AGENT_STATUS_FILTERS');
    const end = dashboardSource.indexOf('function filterAgentListBySearch');
    const filterCode = dashboardSource.slice(start, end);

    const agents = [
      { agentId: '1', name: 'NormalBot', ring: 'normal', active: true },
      { agentId: '2', name: 'AttentionBot', ring: 'attention', active: false },
      { agentId: '3', name: 'UrgentBot', ring: 'urgent', active: true }
    ];

    const runFilter = (statusFilter) => {
      const fn = new Function(
        'agentListStatusFilter',
        'isAgentActive',
        'getOrbitRingKey',
        'currentAgentList',
        'updateAgentListPanel',
        `${filterCode}; return filterAgentListByStatus(currentAgentList);`
      );
      return fn(
        statusFilter,
        (a) => a.active,
        (a) => a.ring,
        agents,
        () => {}
      );
    };

    expect(runFilter('all').map((a) => a.name)).toEqual(['NormalBot', 'AttentionBot', 'UrgentBot']);
    expect(runFilter('active').map((a) => a.name)).toEqual(['NormalBot', 'UrgentBot']);
    expect(runFilter('attention').map((a) => a.name)).toEqual(['AttentionBot']);
    expect(runFilter('urgent').map((a) => a.name)).toEqual(['UrgentBot']);
  });

  test('isMcpAgent detects MCP agents by externalProvider or MCP suffix and hides config', () => {
    const start = dashboardSource.indexOf('function isMcpAgent(');
    const end = dashboardSource.indexOf('function getPendingRunOverrides()');
    const isMcpCode = dashboardSource.slice(start, end);
    const agentList = [
      { agentId: 'mcp-1', name: 'Custom Agent', externalProvider: 'mcp' },
      { agentId: 'mcp-2', name: 'Google MCP (3)', externalProvider: null },
      { agentId: 'std-1', name: 'Codex Builder', externalProvider: null }
    ];
    const check = new Function('currentAgentList', 'target', `${isMcpCode}; return isMcpAgent(target);`);
    expect(check(agentList, 'mcp-1')).toBe(true);
    expect(check(agentList, 'mcp-2')).toBe(true);
    expect(check(agentList, 'Google MCP')).toBe(true);
    expect(check(agentList, 'Google MCP (3)')).toBe(true);
    expect(check(agentList, 'std-1')).toBe(false);
    expect(check(agentList, 'Codex Builder')).toBe(false);
  });

  test('user_message attaches info button and showMessageInfoModal displays per-message provider and permissions', () => {
    document.body.innerHTML = `
      <div id="runCommandModal" class="hidden">
        <h3 id="runCommandModalTitle"></h3>
        <p id="runCommandModalSubtitle"></p>
        <pre id="runCommandModalBody"></pre>
        <button id="runCommandModalCopyBtn" type="button"></button>
      </div>
      <div class="message-bubble">
        <div class="message-utilities"></div>
      </div>
    `;

    const attachStart = dashboardSource.indexOf('function attachMessageInfoButton(');
    const attachEnd = dashboardSource.indexOf('function attachMessageTtsButton(');
    const modalStart = dashboardSource.indexOf('function showMessageInfoModal(');
    const modalEnd = dashboardSource.indexOf('function hideRunCommandModal(');
    const snippet = `${dashboardSource.slice(attachStart, attachEnd)}\n${dashboardSource.slice(modalStart, modalEnd)}`;

    const loadedAgentConfigs = new Map([
      ['BuilderBot', { model_provider: 'codex', model: 'gpt-6.1-terra', sandbox_mode: 'workspace-write', approval_mode: 'full-auto', thinking_effort: 'high' }]
    ]);

    const invoke = new Function(
      'loadedAgentConfigs',
      'selectedAgentName',
      'formatTimestamp',
      'bubble',
      'msg1',
      'msg2',
      `${snippet}
       attachMessageInfoButton(bubble, msg1);
       return { showMessageInfoModal };`
    );

    const bubble = document.querySelector('.message-bubble');
    const msg1 = {
      messageId: 'msg-1',
      type: 'user_message',
      agentName: 'BuilderBot',
      timestamp: '2026-10-26T21:00:00.000Z',
      readAt: null,
      runOverrides: {
        model_provider: 'claude',
        model: 'claude-sonnet-5',
        sandbox_mode: 'read-only',
        approval_mode: 'suggest',
        thinking_effort: 'max'
      }
    };
    const msg2 = {
      messageId: 'msg-2',
      type: 'user_message',
      agentName: 'BuilderBot',
      timestamp: '2026-10-26T21:01:00.000Z',
      readAt: '2026-10-26T21:01:05.000Z',
      runOverrides: {
        model_provider: 'codex',
        model: 'gpt-6.1-terra',
        sandbox_mode: 'none',
        approval_mode: 'full-auto',
        thinking_effort: 'high'
      }
    };

    const { showMessageInfoModal } = invoke(
      loadedAgentConfigs,
      'BuilderBot',
      () => '21:00',
      bubble,
      msg1,
      msg2
    );

    const infoBtn = bubble.querySelector('.message-info-btn');
    expect(infoBtn).not.toBeNull();
    infoBtn.click();

    const bodyText1 = document.getElementById('runCommandModalBody').textContent;
    expect(bodyText1).toContain('Recipient agent: BuilderBot');
    expect(bodyText1).toContain('Provider: claude');
    expect(bodyText1).toContain('Model: claude-sonnet-5');
    expect(bodyText1).toContain('Permissions / Sandbox: read-only');
    expect(bodyText1).toContain('Approval mode: suggest');
    expect(bodyText1).toContain('Thinking effort: max');
    expect(bodyText1).toContain('Status: Queued (will run with these settings)');

    showMessageInfoModal(msg2);
    const bodyText2 = document.getElementById('runCommandModalBody').textContent;
    expect(bodyText2).toContain('Provider: codex');
    expect(bodyText2).toContain('Model: gpt-6.1-terra');
    expect(bodyText2).toContain('Permissions / Sandbox: none');
    expect(bodyText2).toContain('Approval mode: full-auto');
    expect(bodyText2).toContain('Thinking effort: high');
    expect(bodyText2).toContain('Status: Read by agent at 21:00');
  });
});
