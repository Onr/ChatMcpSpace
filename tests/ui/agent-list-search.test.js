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

function getGroupPartition(agents) {
  const grouped = new Map();
  const ungrouped = [];
  for (const agent of agents) {
    if (agent.groupId) {
      if (!grouped.has(agent.groupId)) grouped.set(agent.groupId, { agents: [] });
      grouped.get(agent.groupId).agents.push(agent);
    } else {
      ungrouped.push(agent);
    }
  }
  return { grouped, ungrouped };
}

// Mirrors the fixed main-view branch of updateAgentListPanel in public/js/dashboard.js:
// while searching, matching group members render inline instead of hiding behind the
// collapsed group header, and the "no matches" empty state only shows when nothing
// (neither a group section nor a flat item) was actually rendered.
function updateAgentListPanel(agents, query = '', groups = []) {
  const listScroll = document.getElementById('agentListScroll');
  const listCount = document.getElementById('agentListCount');
  const agentList = Array.isArray(agents) ? agents : [];
  const filteredAgentList = filterAgentListBySearch(agentList, query);
  const hasActiveSearch = normalizeAgentListSearchQuery(query).length > 0;

  if (listCount) {
    listCount.textContent = query ? `${filteredAgentList.length}/${agentList.length}` : `${agentList.length}`;
  }

  if (agentList.length === 0) {
    listScroll.innerHTML = getAgentListEmptyStateHtml('No agents connected');
    return;
  }

  const partition = getGroupPartition(agentList);
  let html = '';
  let hasAnyGroupSection = false;

  for (const group of groups) {
    const groupData = partition.grouped.get(group.groupId);
    if (!groupData || groupData.agents.length === 0) continue;
    const filteredGroupAgents = filterAgentListBySearch(groupData.agents, query);
    if (filteredGroupAgents.length === 0) continue;
    hasAnyGroupSection = true;

    html += `<div class="agent-list-group-header" data-group-id="${group.groupId}">${group.groupName} (${filteredGroupAgents.length})</div>`;

    if (hasActiveSearch) {
      html += renderAgentListItemsHtml(filteredGroupAgents);
    }
  }

  const filteredUngrouped = filterAgentListBySearch(partition.ungrouped, query);
  const listAgents = groups.length > 0 ? filteredUngrouped : filteredAgentList;

  if (listAgents.length > 0) {
    html += renderAgentListItemsHtml(listAgents);
  } else if (!hasAnyGroupSection) {
    html += getAgentListEmptyStateHtml(hasActiveSearch ? `No agents match "${query}"` : 'No agents connected');
  }

  listScroll.innerHTML = html;
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

  describe('with groups', () => {
    const groups = [{ groupId: 'g1', groupName: 'Deploy Team' }];
    const groupedAgents = [
      { agentId: '1', name: 'Remotion Builder', externalProvider: 'claude', agentType: 'standard', groupId: 'g1' },
      { agentId: '2', name: 'DeployBot', externalProvider: 'codex', agentType: 'standard', groupId: 'g1' },
      { agentId: '3', name: 'News Feed', externalProvider: '', agentType: 'news_feed' }
    ];

    it('shows only the collapsed group header (no member items) when not searching', () => {
      updateAgentListPanel(groupedAgents, '', groups);
      expect(document.querySelector('.agent-list-group-header')).not.toBeNull();
      expect(document.querySelectorAll('.agent-list-item')).toHaveLength(1); // just the ungrouped News Feed
    });

    it('shows matching agents inside a group, not just the group header', () => {
      updateAgentListPanel(groupedAgents, 'deploy', groups);
      const header = document.querySelector('.agent-list-group-header');
      expect(header).not.toBeNull();
      const items = Array.from(document.querySelectorAll('.agent-list-item__name')).map((node) => node.textContent);
      expect(items).toEqual(['DeployBot']);
    });

    it('does not show a spurious "no match" message when only grouped agents match', () => {
      updateAgentListPanel(groupedAgents, 'remotion', groups);
      expect(document.getElementById('agentListScroll').textContent).not.toContain('No agents match');
      const items = Array.from(document.querySelectorAll('.agent-list-item__name')).map((node) => node.textContent);
      expect(items).toEqual(['Remotion Builder']);
    });

    it('still shows the empty state when nothing matches at all', () => {
      updateAgentListPanel(groupedAgents, 'zzz', groups);
      expect(document.getElementById('agentListScroll').textContent).toContain('No agents match "zzz"');
      expect(document.querySelectorAll('.agent-list-item')).toHaveLength(0);
    });
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
