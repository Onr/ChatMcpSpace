'use strict';

(() => {
  const menu = document.getElementById('floatingAgentMenu');
  const dialog = document.getElementById('agentShareDialog');
  if (!menu) return;
  // The dashboard's animated main element creates a CSS containing block.
  // Floating actions belong to the viewport, outside that transformed parent.
  document.body.append(menu);
  if (dialog) document.body.append(dialog);
  let anchorRect;
  let returnFocus;
  let pointerStart;
  let pointerMoved = false;
  const iconSelector = '.agent-list-item__avatar, .agent-seat .agent-avatar, .dock-agent-avatar, #selectedAgentActionIcon';

  function place() {
    if (!anchorRect || menu.classList.contains('hidden')) return;
    const margin = 12;
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0;
    const topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    menu.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    menu.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
    const bounds = menu.getBoundingClientRect();
    const left = Math.max(leftEdge + margin, Math.min(anchorRect.left, leftEdge + width - bounds.width - margin));
    const below = anchorRect.bottom + 8;
    const above = anchorRect.top - bounds.height - 8;
    const top = below + bounds.height <= topEdge + height - margin ? below : above;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(topEdge + margin, Math.min(top, topEdge + height - bounds.height - margin))}px`;
  }

  window.AgentActionsUI = {
    position(rect, agentId, { name = 'Agent', shareable = true } = {}) {
      anchorRect = rect;
      if (agentId) menu.dataset.agentId = agentId;
      else delete menu.dataset.agentId;
      document.getElementById('floatingAgentName').textContent = name;
      const share = document.getElementById('floatingShareAgentBtn');
      if (share) share.hidden = !agentId || !shareable;
      menu.classList.remove('hidden');
      place();
    }
  };

  function closeMenu() {
    window.DashboardHelpers?.hideAgentActionsMenu?.();
    menu.classList.add('hidden');
    delete menu.dataset.agentId;
  }

  function enhanceIcons(root = document) {
    root.querySelectorAll(iconSelector).forEach(icon => {
      const agent = icon.closest('[data-agent-id]');
      if (!agent?.dataset.agentId) return;
      icon.setAttribute('role', 'button');
      icon.tabIndex = 0;
      icon.setAttribute('aria-haspopup', 'dialog');
      icon.setAttribute('aria-label', `Actions for ${agent.dataset.agentName || 'agent'}`);
      icon.title = 'Agent actions and sharing';
    });
  }

  function openIcon(event) {
    if (event.type === 'click' && pointerMoved) return;
    const icon = event.target.closest(iconSelector);
    if (!icon || event.target.closest('.agent-seat__group-remove')) return;
    const agent = icon.id === 'selectedAgentActionIcon'
      ? { dataset: window.DashboardHelpers?.getSelectedAgentForActions?.() }
      : icon.closest('[data-agent-id]');
    const open = window.DashboardHelpers?.openAgentActionsMenu;
    if (!agent?.dataset?.agentId || !open) return;
    event.preventDefault();
    event.stopPropagation();
    returnFocus = icon;
    if (!menu.classList.contains('hidden') && menu.dataset.agentId === agent.dataset.agentId) {
      closeMenu();
      return;
    }
    Promise.resolve(open(agent.dataset.agentId, agent.dataset.agentName, {
      agentType: agent.dataset.agentType || 'standard',
      externalProvider: agent.dataset.agentExternalProvider || ''
    }, icon)).then(() => {
      if (event.type === 'keydown') menu.querySelector('button:not([hidden])')?.focus();
    }).catch(error => window.showError?.(error.message));
  }

  // Delegate to surviving parents: background agent-list updates replace rows.
  document.addEventListener('pointerdown', event => {
    pointerStart = { x: event.clientX, y: event.clientY };
    pointerMoved = false;
  }, { capture: true, passive: true });
  document.addEventListener('pointermove', event => {
    if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 8) pointerMoved = true;
  }, { capture: true, passive: true });
  document.addEventListener('pointerup', () => { pointerStart = null; }, { capture: true, passive: true });
  document.addEventListener('pointercancel', () => { pointerStart = null; pointerMoved = false; }, { capture: true, passive: true });
  document.addEventListener('click', openIcon, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && dialog?.open) {
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') openIcon(event);
    if (event.key === 'Escape' && !menu.classList.contains('hidden')) {
      closeMenu();
      returnFocus?.focus();
    }
  }, true);
  document.getElementById('floatingCloseAgentMenu')?.addEventListener('click', () => {
    closeMenu();
    returnFocus?.focus();
  });
  menu.querySelector('details')?.addEventListener('toggle', place);
  if (window.ResizeObserver) new ResizeObserver(place).observe(menu);
  window.addEventListener('resize', place);
  window.visualViewport?.addEventListener('resize', place);
  enhanceIcons();
  const list = document.getElementById('dashboardRoot');
  if (list) new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1))) enhanceIcons(list);
  }).observe(list, { childList: true, subtree: true });

  document.getElementById('floatingShareAgentBtn')?.addEventListener('click', async () => {
    const agentId = menu.dataset.agentId;
    if (!agentId) return;
    const name = document.getElementById('floatingAgentName').textContent;
    if (document.getElementById('shareExistingChatDialog')) {
      closeMenu();
      try { await window.AgentChatSharing.openForAgent(agentId, name); }
      catch (error) { window.showError?.(error.message); }
      return;
    }
    if (!dialog) return;
    const query = new URLSearchParams({ agentId }).toString();
    document.getElementById('agentShareName').textContent = name;
    document.getElementById('agentShareAvatar').textContent = name.slice(0, 2).toUpperCase();
    document.getElementById('agentShareChatLink').href = '/shared?' + query;
    const guest = document.getElementById('agentShareGuestLink');
    if (guest) guest.href = '/guest-sharing?' + query;
    closeMenu();
    dialog.showModal();
  });
  document.getElementById('agentShareClose')?.addEventListener('click', () => dialog.close());
  dialog?.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog?.addEventListener('close', () => returnFocus?.focus());
})();
