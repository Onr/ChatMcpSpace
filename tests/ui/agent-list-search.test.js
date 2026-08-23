/**
 * @jest-environment jsdom
 */

function normalizeAgentListSearchQuery(query) {
  return String(query || '').trim().toLowerCase();
}

function filterAgentListBySearch(agents, query) {
  const normalizedQuery = normalizeAgentListSearchQuery(query);
  if (!normalizedQuery) {
    return Array.isArray(agents) ? agents : [];
  }

  return (Array.isArray(agents) ? agents : []).filter((agent) => {
    const haystack = [agent?.name, agent?.externalProvider, agent?.agentType]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

function getAgentListEmptyStateHtml(message) {
  return `<div class="agent-list-empty"><p>${message}</p></div>`;
}

function renderAgentListItemsHtml(agents) {
  return agents.map((agent) => `
    <div class="agent-list-item" data-agent-id="${agent.agentId}" data-agent-name="${agent.name}">
      <span class="agent-list-item__name">${agent.name}</span>
    </div>
  `).join('');
}

function updateAgentListPanel(agents, query = '') {
  const listScroll = document.getElementById('agentListScroll');
  const listCount = document.getElementById('agentListCount');
  const agentList = Array.isArray(agents) ? agents : [];
  const filteredAgentList = filterAgentListBySearch(agentList, query);

  if (listCount) {
    listCount.textContent = query ? `${filteredAgentList.length}/${agentList.length}` : `${agentList.length}`;
  }

  if (agentList.length === 0) {
    listScroll.innerHTML = getAgentListEmptyStateHtml('No agents connected');
    return;
  }

  listScroll.innerHTML = filteredAgentList.length > 0
    ? renderAgentListItemsHtml(filteredAgentList)
    : getAgentListEmptyStateHtml(`No agents match "${query}"`);
}

function bindAgentListSearch(agents) {
  const searchInput = document.getElementById('agentListSearchInput');
  if (!searchInput || searchInput.dataset.bound === 'true') {
    return;
  }

  searchInput.dataset.bound = 'true';
  searchInput.addEventListener('input', (event) => {
    updateAgentListPanel(agents, String(event.target.value || ''));
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault();
      searchInput.value = '';
      updateAgentListPanel(agents, '');
    }
  });
}

function createDOM() {
  document.body.innerHTML = `
    <div id="agentListPanel">
      <div class="agent-list-header">
        <input id="agentListSearchInput" type="search" />
        <div id="agentListCount"></div>
      </div>
      <div id="agentListScroll"></div>
    </div>
  `;
}

describe('Agent list search', () => {
  const agents = [
    { agentId: '1', name: 'Remotion Builder', externalProvider: 'claude', agentType: 'standard' },
    { agentId: '2', name: 'DeployBot', externalProvider: 'codex', agentType: 'standard' },
    { agentId: '3', name: 'News Feed', externalProvider: '', agentType: 'news_feed' }
  ];

  beforeEach(() => {
    createDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the full count when no search is active', () => {
    updateAgentListPanel(agents, '');
    expect(document.getElementById('agentListCount').textContent).toBe('3');
    expect(document.querySelectorAll('.agent-list-item')).toHaveLength(3);
  });

  it('filters by agent name as the user types', () => {
    bindAgentListSearch(agents);
    const input = document.getElementById('agentListSearchInput');
    input.value = 'remo';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const items = Array.from(document.querySelectorAll('.agent-list-item__name')).map((node) => node.textContent);
    expect(items).toEqual(['Remotion Builder']);
    expect(document.getElementById('agentListCount').textContent).toBe('1/3');
  });

  it('matches provider and agent type metadata', () => {
    expect(filterAgentListBySearch(agents, 'codex').map((agent) => agent.name)).toEqual(['DeployBot']);
    expect(filterAgentListBySearch(agents, 'news_feed').map((agent) => agent.name)).toEqual(['News Feed']);
  });

  it('shows an empty state when no agents match', () => {
    updateAgentListPanel(agents, 'zzz');
    expect(document.querySelectorAll('.agent-list-item')).toHaveLength(0);
    expect(document.getElementById('agentListScroll').textContent).toContain('No agents match "zzz"');
    expect(document.getElementById('agentListCount').textContent).toBe('0/3');
  });

  it('clears the search on Escape and restores the full list', () => {
    bindAgentListSearch(agents);
    const input = document.getElementById('agentListSearchInput');
    input.value = 'deploy';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(input.value).toBe('');
    expect(document.querySelectorAll('.agent-list-item')).toHaveLength(3);
    expect(document.getElementById('agentListCount').textContent).toBe('3');
  });
});
