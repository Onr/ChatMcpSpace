/* Shared presentation only. Authorization and encryption remain in each client. */
'use strict';
(function (root) {
  function setView(workspace, view) {
    if (workspace) workspace.dataset.view = view;
  }
  const taskLabels = {
    queued: 'Queued', running: 'Working', waiting_for_approval: 'Waiting for owner approval', paused: 'Paused',
    cancellation_requested: 'Stopping — confirmation pending', cancellation_confirmed: 'Stopped',
    completed: 'Completed', failed: 'Needs review', outcome_uncertain: 'Outcome uncertain — review before retry',
    unsupported_runtime: 'Waiting for a compatible runner and execution permissions'
  };
  function renderTasks(panel, tasks, handlers = {}) {
    if (!panel) return;
    const visible = tasks.slice(0, 6);
    panel.hidden = !visible.length;
    const signature = JSON.stringify(visible);
    if (panel.dataset.signature === signature) return;
    panel.dataset.signature = signature;
    const list = panel.querySelector('[data-chat-tasks]');
    const error = panel.querySelector('[data-task-error]');
    list.replaceChildren();
    const node = (tag, text, className = '') => Object.assign(document.createElement(tag), { textContent: text, className });
    const button = (text, fn, className = '') => {
      const element = node('button', text, className);
      element.type = 'button';
      element.addEventListener('click', async () => {
        element.disabled = true;
        error.textContent = '';
        try { await fn(); } catch (failure) { error.textContent = failure.message; }
        finally { if (element.isConnected) element.disabled = false; }
      });
      return element;
    };
    visible.forEach(task => {
      const card = node('article', '', 'chat-task');
      card.append(node('strong', task.authorization_state === 'superseded' ? 'Replaced by an authorized attempt' : taskLabels[task.state] || 'Needs review'));
      card.append(node('small', `Task ${task.task_id.slice(0, 8)} · ${task.requester_kind === 'guest' ? 'Guest request' : 'Account request'}`));
      if (task.device_label) card.append(node('small', `Executor: ${task.device_label} · ${task.executor_type || 'restricted runtime'}`));
      if (task.canCancel && ['queued', 'running', 'waiting_for_approval', 'paused', 'unsupported_runtime'].includes(task.state) && handlers.cancel)
        card.append(button('Cancel task', () => handlers.cancel(task), 'chat-danger'));
      for (const action of task.actions || []) {
        if (action.outcome || action.approvedBy) card.append(node('p', `${action.name} · ${action.outcome || action.approvalState}${action.approvedBy ? ' · owner decision retained' : ''}${action.receipt?.exitCode !== undefined ? ' · exit ' + action.receipt.exitCode : ''}`));
        if (action.approvalState !== 'pending' || !handlers.decide) continue;
        const approval = node('div', '', 'chat-task-approval');
        approval.append(node('p', `${action.name} · ${action.resource}${action.destination ? ' → ' + action.destination : ''}`));
        approval.append(node('pre', JSON.stringify(action.parameters, null, 2)));
        approval.append(node('small', 'Your decision applies to this exact action. Changed permissions or commands require a new approval.'));
        approval.append(button('Approve action', () => handlers.decide(task, action, 'approve'), 'chat-primary'),
          button('Deny', () => handlers.decide(task, action, 'deny')));
        card.append(approval);
      }
      if (task.result_held_at && handlers.review) {
        const preview = node('pre', '', 'chat-held-result');
        preview.hidden = true;
        card.append(node('p', 'Result held for your private review. It has not been shared.'));
        card.append(button('Review held result', async () => { preview.textContent = await handlers.review(task); preview.hidden = false; }), preview);
      }
      list.append(card);
    });
  }
  function bind() {
    document.querySelectorAll('[data-chat-workspace]').forEach(workspace => {
      workspace.querySelectorAll('.chat-mobile-back').forEach(button => button.addEventListener('click', () => {
        setView(workspace, 'rooms');
        workspace.querySelector('[data-chat-room][aria-current="true"]')?.focus();
      }));
    });
    document.querySelectorAll('[data-chat-composer]').forEach(form => {
      const textarea = form.querySelector('textarea');
      const fileInput = form.querySelector('input[type="file"]');
      const fileList = form.querySelector('[data-chat-files]');
      const resize = () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(190, Math.max(60, textarea.scrollHeight)) + 'px';
      };
      textarea.addEventListener('input', resize);
      textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
          event.preventDefault();
          if (!form.querySelector('button[type="submit"]')?.disabled) form.requestSubmit();
        }
      });
      fileInput.addEventListener('change', () => {
        fileList.replaceChildren();
        for (const file of fileInput.files) {
          const chip = document.createElement('span');
          chip.textContent = file.name;
          fileList.append(chip);
        }
      });
      form.addEventListener('reset', () => {
        fileList.replaceChildren();
        textarea.style.height = 'auto';
      });
    });
  }
  root.SharingUI = { setView, renderTasks };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})(window);
