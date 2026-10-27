/** @jest-environment jsdom */
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require('path').join(__dirname, '../../public/js/agent-brief.js'), 'utf8');
const id = '11111111-1111-4111-8111-111111111111';
const doc = { role: '', purpose: '', workspace: '', preferences: '', boundaries: '', instructions: '', references: '', goals: [], activeGoalId: null };
const policy = { enabled: false, paused: false, goalId: null, maxRuns: 4, intervalMinutes: 30, expiresAt: null };
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function boot(bootOptions = {}) {
  document.body.innerHTML = `<button id="header" data-open-agent-brief data-agent-id="${id}">Identity</button><button id="menu" data-open-agent-brief data-agent-id="${id}">Edit</button>`;
  window.csrfToken = 'token';
  window.confirm = jest.fn(() => true);
  let revision = 0;
  let savedDoc = JSON.parse(JSON.stringify(doc));
  window.fetch = jest.fn(async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : null;
    if (String(url).endsWith('/brief/queued')) return { ok: true, status: 200, json: async () => ({ pendingCount: 0 }) };
    if (String(url).endsWith('/brief/history')) return { ok: true, status: 200, json: async () => ({ revisions: [{ revision: 1, document: { ...savedDoc, role: 'Original' }, policy, changed_fields: ['role'], actor_type: 'owner', created_at: new Date().toISOString() }] }) };
    if (String(url).includes('/brief/suggestions/') && options.method === 'POST') {
      revision += 1; savedDoc = payload.document;
      return { ok: true, status: 200, json: async () => ({ decided: true, brief: { agentId: id, agentName: 'Alpha', revision, document: savedDoc, policy, state: {} } }) };
    }
    if (String(url).endsWith('/brief') && options.method === 'PUT') {
      if (bootOptions.failSave) return { ok: false, status: 409, json: async () => ({ error: { message: 'Revision changed' } }) };
      revision += 1; savedDoc = payload.document;
      return { ok: true, status: 200, json: async () => ({ agentId: id, agentName: 'Alpha', revision, document: savedDoc, policy: payload.policy, state: {}, notice: `Agent will use revision ${revision} from its next turn.` }) };
    }
    if (String(url).endsWith('/brief')) return { ok: true, status: 200, json: async () => ({ agentId: id, agentName: 'Alpha', revision, document: savedDoc, policy: bootOptions.activePolicy ? { ...policy, enabled: true } : policy, proactiveAvailable: true, state: {}, suggestions: bootOptions.suggestion ? [bootOptions.suggestion] : [] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vm.runInNewContext(source, { window, document, fetch: window.fetch, crypto: { randomUUID: () => id }, CustomEvent, console, Date, JSON, String, Number });
  return { current: () => ({ revision, document: savedDoc }) };
}

test('header and menu open one editor, save explicit revision, and close with focus returned', async () => {
  const db = boot();
  const header = document.getElementById('header');
  header.focus(); header.click(); await settle();
  expect(document.querySelectorAll('#agentBriefRoot')).toHaveLength(1);
  const drawer = document.querySelector('#agentBriefRoot');
  expect(drawer.classList.contains('hidden')).toBe(false);
  const role = drawer.querySelector('#brief-role');
  role.value = 'Release assistant'; role.dispatchEvent(new Event('input', { bubbles: true }));
  expect(drawer.querySelector('.agent-brief-preview').textContent).toContain('Role: Release assistant');
  expect(db.current().revision).toBe(0);
  drawer.querySelector('#agentBriefSave').click(); await settle();
  expect(db.current()).toMatchObject({ revision: 1, document: { role: 'Release assistant' } });
  expect(drawer.querySelector('#agentBriefNotice').textContent).toContain('revision 1');
  drawer.querySelector('[data-brief-close]').click();
  expect(drawer.classList.contains('hidden')).toBe(true);
  expect(document.activeElement).toBe(header);
  document.getElementById('menu').click(); await settle();
  expect(document.querySelectorAll('#agentBriefRoot')).toHaveLength(1);
  expect(drawer.querySelector('#brief-role').value).toBe('Release assistant');
  const maliciousRole = drawer.querySelector('#brief-role');
  maliciousRole.value = '<img src=x onerror=alert(1)>';
  maliciousRole.dispatchEvent(new Event('input', { bubbles: true }));
  window.confirm.mockReturnValueOnce(false);
  drawer.querySelector('[data-brief-close]').click();
  expect(drawer.classList.contains('hidden')).toBe(false);
  expect(window.confirm).toHaveBeenCalled();
  drawer.querySelector('[data-brief-tab="policy"]').click();
  drawer.querySelector('[data-brief-tab="identity"]').click();
  expect(drawer.querySelector('#brief-role').value).toBe('<img src=x onerror=alert(1)>');
  expect(drawer.querySelector('#agentBriefContent img')).toBeNull();
});

test('new-agent invitation is optional and a message revision opens read-only history', async () => {
  boot();
  window.AgentBriefUI.offerSetup({ agentId: id, name: 'Alpha' });
  expect(document.querySelectorAll('.agent-brief-onboarding')).toHaveLength(1);
  expect(document.querySelector('.agent-brief-onboarding').textContent).toContain('Automatic work stays off');
  document.querySelector('.agent-brief-onboarding button:last-child').click();
  expect(document.querySelector('.agent-brief-onboarding')).toBeNull();
  await window.AgentBriefUI.open(id, 'history', 1);
  await settle();
  const revision = document.querySelector('[data-brief-revision="1"]');
  expect(revision).not.toBeNull();
  expect(revision.querySelector('details').open).toBe(true);
  expect(revision.querySelector('[data-brief-restore]').disabled).toBe(true);
});

test('Stop now does not claim future work is paused when the pause save fails', async () => {
  boot({ activePolicy: true, failSave: true });
  await window.AgentBriefUI.open(id, 'policy');
  await settle();
  document.querySelector('[data-brief-stop]').click();
  await settle();
  expect(document.querySelector('#agentBriefNotice').textContent).toContain('Could not pause future work');
  expect(window.fetch.mock.calls.some(([url]) => String(url).endsWith('/stop'))).toBe(false);
});

test('owner can edit a suggestion before accepting it as a revision', async () => {
  const suggestion = { suggestion_id: id, base_revision: 0, reason: 'Clarify role', proposed_document: { ...doc, role: 'Suggested role' } };
  const db = boot({ suggestion });
  await window.AgentBriefUI.open(id);
  document.querySelector('[data-suggestion-edit]').click();
  const role = document.querySelector('#brief-role');
  expect(role.value).toBe('Suggested role');
  role.value = 'Owner revised role'; role.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#agentBriefSave').click(); await settle();
  expect(db.current()).toMatchObject({ revision: 1, document: { role: 'Owner revised role' } });
  expect(window.fetch.mock.calls.some(([url]) => String(url).includes('/brief/suggestions/') && String(url).endsWith('/decision'))).toBe(true);
});
