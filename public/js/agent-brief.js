/* Owner editor for agent identity, goals, and automatic work. */
(function () {
  'use strict';

  const templates = {
    Reviewer: { role: 'Reviewer', purpose: 'Review work and report findings with evidence.', preferences: 'Be concise and cite files or sources.', boundaries: 'Ask before changing files or publishing.' },
    'Release assistant': { role: 'Release assistant', purpose: 'Help prepare a verified release.', preferences: 'Report progress and risks clearly.', boundaries: 'Ask before deployment or publication.' },
    Researcher: { role: 'Researcher', purpose: 'Investigate questions and summarize evidence.', preferences: 'Distinguish facts from inferences.', boundaries: 'Ask before spending money or contacting others.' },
    Monitor: { role: 'Monitor', purpose: 'Watch a defined signal and report meaningful changes.', preferences: 'Group unchanged checks; report only useful changes.', boundaries: 'Ask before taking corrective action.' }
  };
  const textFields = [
    ['displayName', 'Display name (website only)', 120, 'text'], ['avatar', 'Avatar emoji', 16, 'text'],
    ['role', 'Role', 120, 'text'], ['purpose', 'Purpose', 500, 'textarea'],
    ['workspace', 'Workspace', 500, 'text'], ['preferences', 'Working preferences', 1200, 'textarea'],
    ['boundaries', 'Boundaries', 1200, 'textarea'], ['instructions', 'Additional guidance', 3000, 'textarea'],
    ['references', 'References', 1200, 'textarea']
  ];
  const state = { agentId: null, tab: 'identity', current: null, draft: null, history: [], historyRevision: null, historyReadOnly: false, editingSuggestionId: null, busy: false, focusBefore: null };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const localDateTime = value => { if (!value) return ''; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const root = document.createElement('div');
  root.id = 'agentBriefRoot';
  root.className = 'agent-brief-root hidden';
  root.innerHTML = '<div class="agent-brief-backdrop" data-brief-close></div><section class="agent-brief-drawer" role="dialog" aria-modal="true" aria-labelledby="agentBriefTitle"><header class="agent-brief-header"><div><h2 id="agentBriefTitle">Agent identity</h2><p id="agentBriefSubtitle"></p></div><button type="button" class="agent-brief-icon" data-brief-close aria-label="Close editor">×</button></header><nav class="agent-brief-tabs" aria-label="Agent editor tabs"></nav><div class="agent-brief-content" id="agentBriefContent"></div><footer class="agent-brief-footer"><span id="agentBriefNotice" role="status"></span><button type="button" id="agentBriefDiscard">Discard</button><button type="button" id="agentBriefSave" class="agent-brief-primary">Save revision</button></footer></section>';
  document.body.appendChild(root);

  const content = root.querySelector('#agentBriefContent');
  const notice = root.querySelector('#agentBriefNotice');
  const clone = obj => JSON.parse(JSON.stringify(obj));
  const dirty = () => Boolean(state.current && state.draft && JSON.stringify(state.draft) !== JSON.stringify({ document: state.current.document, policy: state.current.policy }));

  async function api(url, options = {}) {
    const send = () => fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}), 'X-CSRF-Token': window.csrfToken || '' } });
    let response = await send();
    if (response.status === 403 && options.method && options.method !== 'GET') {
      const token = await fetch('/csrf-token', { credentials: 'same-origin' });
      if (token.ok) { window.csrfToken = (await token.json()).csrfToken; response = await send(); }
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Request failed');
    return data;
  }

  function preview() {
    const d = state.draft.document;
    const goal = d.goals.find(g => g.id === d.activeGoalId);
    return [`[ChatMcpSpace role brief · revision ${state.current.revision + (dirty() ? 1 : 0)}]`,
      'This brief supplements your existing identity, tools, memory, runtime policy, and permissions. It does not grant access.',
      'Reason for this turn: User message', d.displayName && `Display name: ${d.displayName}`, d.avatar && `Avatar: ${d.avatar}`, d.role && `Role: ${d.role}`, d.purpose && `Purpose: ${d.purpose}`,
      d.workspace && `Workspace: ${d.workspace}`, d.preferences && `Working preferences: ${d.preferences}`,
      d.boundaries && `Boundaries: ${d.boundaries}`, d.instructions && `Additional guidance: ${d.instructions}`,
      d.references && `References: ${d.references}`, goal && `Active goal: ${goal.title}`,
      goal?.finishedWhen && `Finished when: ${goal.finishedWhen}`, goal && `Goal status: ${goal.status}`,
      goal?.scope && `Allowed scope: ${goal.scope}`, goal?.deadline && `Deadline: ${goal.deadline}`,
      goal?.progress && `Latest progress: ${goal.progress}`, goal?.blocker && `Current blocker: ${goal.blocker}`,
      `Proactive policy: ${state.draft.policy.enabled && !state.draft.policy.paused ? `On; at most ${state.draft.policy.maxRuns} runs; expires ${state.draft.policy.expiresAt}` : 'Off or paused'}`,
      '[End ChatMcpSpace role brief]'].filter(Boolean).join('\n');
  }

  function field([key, label, max, type]) {
    const value = state.draft.document[key] || '';
    const placeholder = key === 'displayName' ? state.current.agentName || '' : '';
    const control = type === 'textarea'
      ? `<textarea id="brief-${key}" data-brief-field="${key}" maxlength="${max}" rows="3" ${state.current.permissions?.editIdentity === false ? 'disabled' : ''}>${esc(value)}</textarea>`
      : `<input id="brief-${key}" data-brief-field="${key}" maxlength="${max}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${state.current.permissions?.editIdentity === false ? 'disabled' : ''}>`;
    return `<div class="agent-brief-field"><label for="brief-${key}">${label} (optional)</label>${control}<small data-counter="${key}">${value.length}/${max}</small></div>`;
  }

  function goalsHtml() {
    const d = state.draft.document;
    return `<div class="agent-brief-section-heading"><h3>Goals (optional)</h3><button type="button" data-brief-add-goal ${state.current.permissions?.editGoals === false ? 'disabled' : ''}>+ New goal</button></div>
      <p class="agent-brief-help">Goals are optional. If you add one, give it a clear finish line. Only one can be active.</p>
      ${d.goals.length ? d.goals.map((g, index) => `<article class="agent-brief-goal" data-goal-index="${index}">
        <div class="agent-brief-goal-head"><label><input type="radio" name="activeGoal" data-active-goal="${esc(g.id)}" ${d.activeGoalId === g.id ? 'checked' : ''} ${g.status === 'archived' ? 'disabled' : ''}> Active</label><select data-goal-field="status" aria-label="Goal status"><option value="in_progress" ${g.status === 'in_progress' ? 'selected' : ''}>In progress</option><option value="ready_for_review" ${g.status === 'ready_for_review' ? 'selected' : ''}>Ready for review</option><option value="blocked" ${g.status === 'blocked' ? 'selected' : ''}>Blocked</option><option value="done" ${g.status === 'done' ? 'selected' : ''}>Done</option><option value="archived" ${g.status === 'archived' ? 'selected' : ''}>Archived</option></select><button type="button" data-goal-up="${index}" aria-label="Move goal up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-goal-down="${index}" aria-label="Move goal down" ${index === d.goals.length - 1 ? 'disabled' : ''}>↓</button></div>
        <label>Desired result<input data-goal-field="title" maxlength="200" value="${esc(g.title)}"></label>
        <label>Finished when<textarea data-goal-field="finishedWhen" maxlength="1200" rows="2">${esc(g.finishedWhen)}</textarea></label>
        <details><summary>Scope, progress, blockers and evidence</summary><label>Allowed scope<textarea data-goal-field="scope" maxlength="800">${esc(g.scope)}</textarea></label><label>Latest progress<textarea data-goal-field="progress" maxlength="1200">${esc(g.progress)}</textarea></label><label>Blocker or question<textarea data-goal-field="blocker" maxlength="800">${esc(g.blocker)}</textarea></label><label>Result evidence<textarea data-goal-field="evidence" maxlength="1200">${esc(g.evidence)}</textarea></label><label>Deadline<input type="date" data-goal-field="deadline" value="${esc(g.deadline ? g.deadline.slice(0, 10) : '')}"></label></details>
      </article>`).join('') : '<p class="agent-brief-empty">No goals yet. Existing agents do not get an invented goal.</p>'}`;
  }

  function renderIdentity() {
    const estimate = Math.ceil(preview().length / 4);
    const agents = window.AgentBriefUI?.agents || [];
    content.innerHTML = `<p class="agent-brief-help">Identity and goals are optional. You can chat with this agent without filling in any of these fields.</p><div class="agent-brief-tools"><label>Start from template<select id="briefTemplate"><option value="">Choose a template</option>${Object.keys(templates).map(n => `<option>${esc(n)}</option>`).join('')}</select></label><label>Copy from agent<select id="briefCopy"><option value="">Choose an agent</option>${agents.filter(a => a.agentId !== state.agentId).map(a => `<option value="${esc(a.agentId)}">${esc(a.name)}</option>`).join('')}</select></label></div>
      ${textFields.slice(0, 7).map(field).join('')}${goalsHtml()}
      <details class="agent-brief-advanced"><summary>Advanced guidance &amp; visibility</summary>${textFields.slice(7).map(field).join('')}<fieldset><legend>Hide from collaborator views</legend><p class="agent-brief-help">These fields still reach your agent. Do not put secrets in this brief.</p>${['workspace','preferences','boundaries','instructions','references','goals'].map(key => `<label class="agent-brief-switch"><input type="checkbox" data-private-field="${key}" ${(state.draft.document.privateFields || []).includes(key) ? 'checked' : ''} ${state.current.permissions?.editIdentity === false ? 'disabled' : ''}>${key}</label>`).join('')}</fieldset></details>
      <p class="agent-brief-help" data-brief-token-estimate>About ${estimate} tokens are added to each turn that receives this brief.${estimate > 600 ? ' Consider shortening it.' : ''}</p>
      <details><summary>What the agent sees</summary><pre class="agent-brief-preview">${esc(preview())}</pre></details>
      ${state.current.suggestions?.length ? `<section class="agent-brief-suggestions"><h3>Suggested by this agent</h3>${state.current.suggestions.map(s => `<article><p>${esc(s.reason)}</p><p>Based on revision ${s.base_revision}</p><details><summary>Review proposed changes</summary><div class="agent-brief-diff"><section><strong>Current</strong><pre>${esc(JSON.stringify(state.current.document, null, 2))}</pre></section><section><strong>Proposed</strong><pre>${esc(JSON.stringify(s.proposed_document, null, 2))}</pre></section></div></details><button type="button" data-suggestion-accept="${esc(s.suggestion_id)}">Accept</button><button type="button" data-suggestion-edit="${esc(s.suggestion_id)}">Edit</button><button type="button" data-suggestion-reject="${esc(s.suggestion_id)}">Reject</button></article>`).join('')}</section>` : ''}`;
    if (state.current.permissions?.editIdentity === false) content.querySelectorAll('#briefTemplate, #briefCopy').forEach(el => { el.disabled = true; });
    if (state.current.permissions?.editGoals === false) content.querySelectorAll('.agent-brief-goal input, .agent-brief-goal textarea, .agent-brief-goal select, .agent-brief-goal button').forEach(el => { el.disabled = true; });
    const details = document.createElement('details');
    details.className = 'agent-brief-connected';
    details.open = true;
    const fields = [['message-count', 'Messages'], ['last-heartbeat', 'Last heartbeat'], ['last-poll', 'Last poll'], ['parent', 'Parent'], ['children', 'Children'], ['machine-name', 'Computer'], ['project-path', 'Project folder']];
    const loadStats = window.DashboardHelpers?.loadAgentActionStats;
    details.innerHTML = `<summary>Connected agent details</summary><dl class="agent-menu-stats"><div><dt>Agent name</dt><dd>${esc(state.current.agentName || 'Agent')}</dd></div>${loadStats && state.current.permissions?.editIdentity !== false ? fields.map(([key, label]) => `<div><dt>${label}</dt><dd data-agent-stat="${key}">…</dd></div>`).join('') : ''}</dl><p class="agent-brief-help">These are your existing connection details. Optional fields below only add guidance.</p>`;
    content.prepend(details);
    if (loadStats && state.current.permissions?.editIdentity !== false) {
      loadStats(state.agentId, details).catch(() => {
        details.querySelectorAll('[data-agent-stat]').forEach(el => { el.textContent = 'Unavailable'; });
      });
    }
  }

  function renderPolicy() {
    const p = state.draft.policy;
    const canWake = state.current.proactiveAvailable === true;
    const s = state.current.state || {};
    content.innerHTML = `<h3>Proactivity</h3><p class="agent-brief-help">Automatic work requires a verified runner. Normal messages always work while this is off.</p>
      ${canWake ? '' : '<div class="agent-brief-callout">This connection has not verified policy-controlled wake-ups. Update a supported local runner to enable this control.</div>'}
      <label class="agent-brief-switch"><input type="checkbox" data-policy-field="enabled" ${p.enabled ? 'checked' : ''} ${canWake && state.current.permissions?.editPolicy !== false ? '' : 'disabled'}> Enable automatic work</label>
      <label class="agent-brief-switch"><input type="checkbox" data-policy-field="paused" ${p.paused ? 'checked' : ''} ${state.current.permissions?.pause === false ? 'disabled' : ''}> Pause future automatic work</label>
      <label>Goal<select data-policy-field="goalId"><option value="">Choose a goal</option>${state.draft.document.goals.filter(g => g.status === 'in_progress').map(g => `<option value="${esc(g.id)}" ${p.goalId === g.id ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}</select></label>
      <div class="agent-brief-two"><label>Maximum runs<input type="number" min="1" max="24" data-policy-field="maxRuns" value="${p.maxRuns || 4}"></label><label>Minimum minutes between checks<input type="number" min="30" max="10080" data-policy-field="intervalMinutes" value="${p.intervalMinutes || 30}"></label></div>
      <label>Expires at<input type="datetime-local" data-policy-field="expiresAt" value="${esc(localDateTime(p.expiresAt))}"></label>
      <p class="agent-brief-help">Usage unavailable for some providers. Run counts and expiry are the hard limits.</p>
      <div class="agent-brief-callout">Status: ${esc(s.status || 'off')} · ${esc(s.usedRuns || 0)} of ${esc(p.maxRuns || 4)} runs used · Next check: ${esc(s.nextWakeAt ? new Date(s.nextWakeAt).toLocaleString() : 'none')}</div>
      <div class="agent-brief-actions"><button type="button" data-brief-check-once ${canWake && state.current.permissions?.editPolicy !== false ? '' : 'disabled'}>Check once</button><button type="button" data-brief-pause ${p.enabled && !p.paused && state.current.permissions?.pause !== false ? '' : 'disabled'}>Pause future</button><button type="button" data-brief-stop ${canWake && state.current.permissions?.editPolicy !== false ? '' : 'disabled'}>Stop now</button></div>`;
    if (state.current.permissions?.editPolicy === false) content.querySelectorAll('[data-policy-field]:not([data-policy-field="paused"])').forEach(el => { el.disabled = true; });
  }

  async function renderActivity() {
    content.innerHTML = '<p class="agent-brief-help">Loading activity…</p>';
    try {
      const data = await api(`/api/user/agents/${state.agentId}/brief/activity`);
      content.innerHTML = `<h3>Activity</h3>${data.activity.length ? data.activity.map(a => `<article class="agent-brief-activity"><strong>${esc(a.event_type.replaceAll('_', ' '))}</strong><time>${esc(new Date(a.created_at).toLocaleString())}</time><p>${esc(a.detail?.reason || a.detail?.outcome || '')}</p></article>`).join('') : '<p class="agent-brief-empty">No automatic activity recorded.</p>'}`;
    } catch (error) { content.textContent = error.message; }
  }

  async function renderHistory() {
    content.innerHTML = '<p class="agent-brief-help">Loading revisions…</p>';
    try {
      const data = await api(`/api/user/agents/${state.agentId}/brief/history`);
      state.history = data.revisions;
      content.innerHTML = `<h3>History</h3>${data.revisions.length ? data.revisions.map((r, i) => `<article class="agent-brief-revision" data-brief-revision="${r.revision}"><div><strong>Revision ${r.revision}</strong><span>${esc(new Date(r.created_at).toLocaleString())} · ${esc(r.actor_type)}</span></div><p>Changed: ${esc((r.changed_fields || []).join(', ') || 'None')}</p><details><summary>Compare with previous version</summary><div class="agent-brief-diff"><section><strong>Before</strong><pre>${esc(JSON.stringify(data.revisions[i + 1]?.document || {}, null, 2))}</pre></section><section><strong>After</strong><pre>${esc(JSON.stringify(r.document, null, 2))}</pre></section></div></details><button type="button" data-brief-restore="${r.revision}" ${r.revision === state.current.revision || state.current.permissions?.editIdentity === false || state.historyReadOnly ? 'disabled' : ''}>Restore as new revision</button></article>`).join('') : '<p class="agent-brief-empty">No saved revisions yet.</p>'}`;
      if (state.historyRevision) {
        const selected = content.querySelector(`[data-brief-revision="${state.historyRevision}"]`);
        if (selected) { selected.querySelector('details').open = true; selected.scrollIntoView?.({ block: 'nearest' }); }
      }
    } catch (error) { content.textContent = error.message; }
  }

  function render() {
    if (!state.current) return;
    root.querySelector('#agentBriefTitle').textContent = `${state.current.document.avatar || ''} ${state.current.document.displayName || state.current.agentName || 'Agent identity'}`.trim();
    root.querySelector('#agentBriefSubtitle').textContent = `${state.current.document.displayName ? `Connected as ${state.current.agentName} · ` : ''}Revision ${state.current.revision || 'not saved yet'}`;
    root.querySelector('.agent-brief-tabs').innerHTML = [['identity', 'Identity & goals'], ['policy', 'Proactivity'], ['activity', 'Activity'], ['history', 'History']].map(([id, label]) => `<button type="button" data-brief-tab="${id}" role="tab" aria-selected="${state.tab === id}">${label}</button>`).join('');
    if (state.tab === 'identity') renderIdentity();
    if (state.tab === 'policy') renderPolicy();
    if (state.tab === 'activity') renderActivity();
    if (state.tab === 'history') renderHistory();
    root.querySelector('#agentBriefSave').disabled = !dirty() || state.busy || (state.current.permissions?.editIdentity === false && state.current.permissions?.editGoals === false && state.current.permissions?.pause === false);
    root.querySelector('#agentBriefDiscard').disabled = !dirty() || state.busy;
    notice.textContent = dirty() ? 'Unsaved changes' : '';
  }

  async function open(agentId, tab = 'identity', revision = null) {
    if (!agentId) return;
    if (dirty() && !window.confirm('Discard unsaved identity changes?')) return;
    state.focusBefore = document.activeElement;
    state.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    state.agentId = agentId;
    state.tab = tab;
    state.historyRevision = Number.isInteger(revision) && revision > 0 ? revision : null;
    state.historyReadOnly = state.historyRevision !== null;
    state.editingSuggestionId = null;
    root.classList.remove('hidden');
    root.querySelector('.agent-brief-drawer').setAttribute('aria-busy', 'true');
    content.textContent = 'Loading identity…';
    try {
      state.current = await api(`/api/user/agents/${encodeURIComponent(agentId)}/brief`);
      state.draft = { document: clone(state.current.document), policy: clone(state.current.policy) };
      render();
      root.querySelector('[data-brief-close]').focus();
    } catch (error) { content.textContent = error.message; }
    finally { root.querySelector('.agent-brief-drawer').removeAttribute('aria-busy'); }
  }

  function close() {
    if (dirty() && !window.confirm('Discard unsaved identity changes?')) return;
    root.classList.add('hidden');
    document.body.style.overflow = state.previousBodyOverflow || '';
    state.agentId = null;
    state.current = null;
    state.draft = null;
    state.editingSuggestionId = null;
    state.focusBefore?.focus?.();
  }

  async function quickEdit(button, agentId) {
    if (!agentId) return;
    const kind = button.dataset.quickBrief;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = kind === 'role' ? 120 : 200;
    input.className = 'agent-brief-inline-input';
    input.setAttribute('aria-label', kind === 'role' ? 'Agent role' : 'Active goal');
    const oldLabel = button.textContent;
    input.value = /^(Set a role|Set a goal)$/.test(oldLabel) ? '' : oldLabel;
    button.hidden = true;
    button.after(input);
    input.focus(); input.select();
    let done = false;
    const cancel = () => { if (done) return; done = true; input.remove(); button.hidden = false; button.focus(); };
    input.addEventListener('keydown', async event => {
      if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      input.disabled = true;
      try {
        const current = await api(`/api/user/agents/${encodeURIComponent(agentId)}/brief`);
        const document = clone(current.document);
        if (kind === 'role') document.role = input.value.trim();
        else {
          let goal = document.goals.find(g => g.id === document.activeGoalId);
          if (!goal) {
            goal = { id: crypto.randomUUID(), title: '', finishedWhen: '', scope: '', progress: '', blocker: '', evidence: '', deadline: null, status: 'in_progress' };
            document.goals.push(goal); document.activeGoalId = goal.id;
          }
          goal.title = input.value.trim();
        }
        const updated = await api(`/api/user/agents/${encodeURIComponent(agentId)}/brief`, { method: 'PUT', body: JSON.stringify({ expectedRevision: current.revision, document, policy: current.policy }) });
        button.textContent = input.value.trim() || (kind === 'role' ? 'Set a role' : 'Set a goal');
        window.dispatchEvent(new CustomEvent('agentbriefsaved', { detail: { agentId, brief: updated } }));
        cancel();
      } catch (error) { input.disabled = false; input.setCustomValidity(error.message); input.reportValidity(); }
    });
    input.addEventListener('blur', () => { if (!input.disabled) cancel(); });
  }

  async function save() {
    if (!dirty() || state.busy) return null;
    state.busy = true; render();
    try {
      let applyQueued = false;
      const queued = await api(`/api/user/agents/${state.agentId}/brief/queued`).catch(() => null);
      if (queued?.pendingCount > 0) applyQueued = window.confirm(`Apply this revision to ${queued.pendingCount} queued messages? Cancel keeps their original brief.`);
      const editedId = state.editingSuggestionId;
      const response = editedId
        ? await api(`/api/user/agents/${state.agentId}/brief/suggestions/${editedId}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'accept', document: state.draft.document, applyQueued }) })
        : await api(`/api/user/agents/${state.agentId}/brief`, { method: 'PUT', body: JSON.stringify({ expectedRevision: state.current.revision, ...state.draft, applyQueued }) });
      const updated = editedId ? response.brief : response;
      if (editedId) state.current.suggestions = state.current.suggestions.filter(s => s.suggestion_id !== editedId);
      state.editingSuggestionId = null;
      state.current = { ...state.current, ...updated, suggestions: state.current.suggestions };
      state.draft = { document: clone(updated.document), policy: clone(updated.policy) };
      render();
      notice.textContent = updated.notice || `Agent will use revision ${updated.revision} from its next turn.`;
      window.dispatchEvent(new CustomEvent('agentbriefsaved', { detail: { agentId: state.agentId, brief: updated } }));
      return updated;
    } catch (error) { notice.textContent = error.message; return null; }
    finally { state.busy = false; root.querySelector('#agentBriefSave').disabled = !dirty(); }
  }

  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-brief-close]')) return close();
    const tab = event.target.closest('[data-brief-tab]');
    if (tab) { state.tab = tab.dataset.briefTab; render(); return; }
    if (event.target.closest('#agentBriefSave')) return save();
    if (event.target.closest('#agentBriefDiscard')) { state.draft = { document: clone(state.current.document), policy: clone(state.current.policy) }; state.editingSuggestionId = null; render(); return; }
    if (event.target.closest('[data-brief-check-once]')) {
      try { const data = await api(`/api/user/agents/${state.agentId}/brief/check-once`, { method: 'POST', body: '{}' }); notice.textContent = `One check requested. It expires at ${new Date(data.expiresAt).toLocaleTimeString()} if the agent is offline.`; }
      catch (error) { notice.textContent = error.message; } return;
    }
    if (event.target.closest('[data-brief-pause]')) { state.draft.policy.paused = true; await save(); return; }
    if (event.target.closest('[data-brief-stop]')) {
      if (!window.confirm('Stop the agent process now? Future automatic work will be paused, and the local agent may need a restart to receive messages.')) return;
      try {
        if (state.draft.policy.enabled && !state.draft.policy.paused) {
          state.draft.policy.paused = true;
          if (!await save()) { notice.textContent = 'Could not pause future work. Reload this agent and try Stop now again.'; return; }
        }
        notice.textContent = 'Stopping… waiting for agent acknowledgement.';
        const result = await api(`/api/user/agents/${state.agentId}/stop`, { method: 'POST', body: '{}' });
        notice.textContent = result.processKilled ? 'Agent process stopped. Future automatic work is paused; restart the agent to receive messages again.' : 'Stop requested. Waiting for the runner to acknowledge at its next heartbeat.';
      } catch (error) { notice.textContent = error.message; } return;
    }
    if (event.target.closest('[data-brief-add-goal]')) {
      if (state.draft.document.goals.length >= 12) { notice.textContent = 'Maximum 12 goals'; return; }
      const id = crypto.randomUUID();
      state.draft.document.goals.push({ id, title: '', finishedWhen: '', scope: '', progress: '', blocker: '', evidence: '', deadline: null, status: 'in_progress' });
      if (!state.draft.document.activeGoalId) state.draft.document.activeGoalId = id;
      render(); return;
    }
    const moveUp = event.target.closest('[data-goal-up]');
    const moveDown = event.target.closest('[data-goal-down]');
    if (moveUp || moveDown) {
      const index = Number((moveUp || moveDown).dataset[moveUp ? 'goalUp' : 'goalDown']);
      const other = index + (moveUp ? -1 : 1);
      const goals = state.draft.document.goals;
      [goals[index], goals[other]] = [goals[other], goals[index]];
      render(); return;
    }
    const restore = event.target.closest('[data-brief-restore]');
    if (restore) {
      if (dirty()) { notice.textContent = 'Save or discard changes before restoring.'; return; }
      if (!window.confirm(`Restore revision ${restore.dataset.briefRestore} as a new revision? Automatic work will be paused.`)) return;
      try { const updated = await api(`/api/user/agents/${state.agentId}/brief/restore`, { method: 'POST', body: JSON.stringify({ revision: Number(restore.dataset.briefRestore), expectedRevision: state.current.revision }) }); state.current = { ...state.current, ...updated }; state.draft = { document: clone(updated.document), policy: clone(updated.policy) }; render(); notice.textContent = updated.notice; window.dispatchEvent(new CustomEvent('agentbriefsaved', { detail: { agentId: state.agentId, brief: updated } })); }
      catch (error) { notice.textContent = error.message; } return;
    }
    const suggestion = event.target.closest('[data-suggestion-accept], [data-suggestion-edit], [data-suggestion-reject]');
    if (suggestion) {
      const id = suggestion.dataset.suggestionAccept || suggestion.dataset.suggestionEdit || suggestion.dataset.suggestionReject;
      if (suggestion.dataset.suggestionEdit) {
        const proposed = state.current.suggestions.find(item => item.suggestion_id === id);
        if (!proposed) return;
        if (dirty() && !window.confirm('Discard unsaved changes to edit this suggestion?')) return;
        state.draft.document = clone(proposed.proposed_document);
        state.editingSuggestionId = id;
        state.tab = 'identity'; render();
        notice.textContent = 'Edit the proposed fields, then save as a new revision.';
        return;
      }
      const decision = suggestion.dataset.suggestionAccept ? 'accept' : 'reject';
      if (decision === 'accept' && !window.confirm('Accept this agent suggestion as a new revision?')) return;
      try { const data = await api(`/api/user/agents/${state.agentId}/brief/suggestions/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }); if (data.brief) { state.current = { ...state.current, ...data.brief }; state.draft = { document: clone(data.brief.document), policy: clone(data.brief.policy) }; } state.current.suggestions = state.current.suggestions.filter(s => s.suggestion_id !== id); render(); }
      catch (error) { notice.textContent = error.message; }
    }
  });

  content.addEventListener('input', (event) => {
    const el = event.target;
    const key = el.dataset.briefField;
    if (key) {
      state.draft.document[key] = el.value;
      const counter = content.querySelector(`[data-counter="${key}"]`);
      if (counter) counter.textContent = `${el.value.length}/${el.maxLength}`;
    }
    const goalField = el.dataset.goalField;
    if (goalField) { const goal = state.draft.document.goals[Number(el.closest('[data-goal-index]').dataset.goalIndex)]; goal[goalField] = goalField === 'deadline' ? (el.value || null) : el.value; }
    const policyField = el.dataset.policyField;
    if (policyField) state.draft.policy[policyField] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : policyField === 'expiresAt' && el.value ? new Date(el.value).toISOString() : el.value || null;
    if (el.dataset.privateField) {
      const fields = new Set(state.draft.document.privateFields || []);
      if (el.checked) fields.add(el.dataset.privateField); else fields.delete(el.dataset.privateField);
      state.draft.document.privateFields = [...fields];
    }
    root.querySelector('#agentBriefSave').disabled = !dirty();
    root.querySelector('#agentBriefDiscard').disabled = !dirty();
    const previewEl = content.querySelector('.agent-brief-preview');
    if (previewEl) previewEl.textContent = preview();
    const estimateEl = content.querySelector('[data-brief-token-estimate]');
    if (estimateEl) {
      const tokens = Math.ceil(preview().length / 4);
      estimateEl.textContent = `About ${tokens} tokens are added to each turn that receives this brief.${tokens > 600 ? ' Consider shortening it.' : ''}`;
    }
    notice.textContent = dirty() ? 'Unsaved changes' : '';
  });
  content.addEventListener('change', async (event) => {
    const el = event.target;
    if (el.dataset.activeGoal) {
      state.draft.document.activeGoalId = el.dataset.activeGoal;
      if (state.draft.policy.enabled && state.draft.policy.goalId !== el.dataset.activeGoal) {
        state.draft.policy.enabled = false;
        state.draft.policy.paused = true;
      }
      state.draft.policy.goalId = el.dataset.activeGoal;
      render();
      return;
    }
    if (el.dataset.policyField === 'enabled' && el.checked) {
      state.draft.policy.goalId = state.draft.policy.goalId || state.draft.document.activeGoalId;
      state.draft.policy.expiresAt = state.draft.policy.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      state.draft.policy.paused = false;
      render();
    }
    if (el.dataset.goalField === 'status') {
      const goal = state.draft.document.goals[Number(el.closest('[data-goal-index]').dataset.goalIndex)];
      if (el.value === 'archived' && state.draft.document.activeGoalId === goal.id) state.draft.document.activeGoalId = null;
      if (state.draft.policy.goalId === goal.id && el.value !== 'in_progress') {
        state.draft.policy.enabled = false;
        state.draft.policy.paused = true;
        state.draft.policy.goalId = null;
      }
      render();
      return;
    }
    if (el.id === 'briefTemplate' && templates[el.value]) { Object.assign(state.draft.document, templates[el.value]); render(); }
    if (el.id === 'briefCopy' && el.value) {
      try { const source = await api(`/api/user/agents/${encodeURIComponent(el.value)}/brief`); state.draft.document = clone(source.document); state.draft.document.goals.forEach(g => { g.id = crypto.randomUUID(); }); state.draft.document.activeGoalId = null; render(); }
      catch (error) { notice.textContent = error.message; }
    }
  });

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-open-agent-brief]');
    if (!trigger) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    const menu = trigger.closest('#agentContextMenu, #floatingAgentMenu');
    const agentId = trigger.dataset.agentId || trigger.closest('[data-agent-id]')?.dataset.agentId || window.DashboardHelpers?.getSelectedAgentForActions?.()?.agentId;
    if (!agentId) return;
    menu?.classList.add('hidden');
    if (trigger.dataset.quickBrief) { quickEdit(trigger, agentId); return; }
    open(agentId, trigger.dataset.briefTab || 'identity');
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !root.classList.contains('hidden')) { event.preventDefault(); close(); } });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary')].filter(el => el.getClientRects().length && !el.hidden);
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
  });
  window.AgentBriefUI = { open, close, agents: [] };
  const settingsList = document.getElementById('agentBriefSettingsList');
  if (settingsList) {
    const loadSettingsAgents = async () => {
      try {
        const data = await api('/api/user/agents');
        window.AgentBriefUI.agents = data.agents || [];
        settingsList.innerHTML = data.agents.length ? data.agents.map(agent => `<article><div><strong>${esc(agent.briefSummary?.avatar || '')} ${esc(agent.briefSummary?.displayName || agent.name)}</strong><p>${esc(agent.briefSummary?.role || 'No role set')} · ${esc(agent.briefSummary?.goal || 'No active goal')} · Proactive ${agent.briefSummary?.proactiveEnabled ? 'on' : 'off'}</p></div><button type="button" data-open-agent-brief data-agent-id="${esc(agent.agentId)}" class="agent-brief-entry">Edit</button></article>`).join('') : '<p class="agent-brief-empty">No agents yet.</p>';
      } catch (error) { settingsList.textContent = error.message; }
    };
    loadSettingsAgents();
    window.addEventListener('agentbriefsaved', loadSettingsAgents);
    document.getElementById('agentBriefPauseAll')?.addEventListener('click', async () => {
      const status = document.getElementById('agentBriefPauseAllStatus');
      status.textContent = 'Pausing…';
      try { const data = await api('/api/user/agents/brief/pause-all', { method: 'POST', body: '{}' }); status.textContent = `${data.paused} active policies paused.`; loadSettingsAgents(); }
      catch (error) { status.textContent = error.message; }
    });
  }
})();
