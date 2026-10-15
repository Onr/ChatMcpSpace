/* Quoted replies stay inside their conversation. Shared previews resolve only
 * from messages visible to the current reader, never from copied private text. */
(function (root) {
  'use strict';
  const drafts = new Map();
  let activeKey = null;
  let renderedDraft = null;
  function preview(message) {
    return {
      messageId: String(message.messageId || message.id || ''),
      senderName: String(message.senderName || message.agentName || (message.type === 'user_message' ? 'You' : 'Agent')).slice(0, 100),
      text: String(message.content || (message.attachments?.length ? 'Attachment' : 'Message')).slice(0, 240)
    };
  }
  function quoteElement(reply, jump = true) {
    const element = document.createElement(jump ? 'button' : 'div');
    element.className = 'message-reply-quote';
    if (jump) {
      element.type = 'button';
      element.title = 'Go to the original message';
      element.addEventListener('click', () => {
        const target = Array.from(document.querySelectorAll('[data-message-id]'))
          .find(node => node.dataset.messageId === reply.messageId);
        if (target) {
          target.scrollIntoView({ block: 'center', behavior: 'instant' });
          target.classList.add('message-reply-highlight');
          root.setTimeout(() => target.classList.remove('message-reply-highlight'), 1500);
        } else root.showErrorMessage?.('The original message is not loaded. Scroll up to find it.');
      });
    }
    const author = document.createElement('strong');
    author.textContent = reply.senderName || 'Original message';
    const text = document.createElement('span');
    text.textContent = reply.text || 'Message unavailable';
    element.append(author, text);
    return element;
  }
  function renderDraft() {
    let element = document.getElementById('messageReplyDraft');
    const input = document.getElementById('userMessageInput');
    if (!input) return;
    const draft = drafts.get(activeKey);
    if (!draft) { element?.remove(); renderedDraft = null; return; }
    if (element && renderedDraft === draft) return;
    renderedDraft = draft;
    if (!element) {
      element = document.createElement('div');
      element.id = 'messageReplyDraft';
      element.className = 'message-reply-draft';
      element.setAttribute('role', 'status');
      input.parentElement.insertAdjacentElement('beforebegin', element);
    }
    element.replaceChildren(quoteElement(draft, false));
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'message-utility-btn';
    cancel.textContent = '×'; cancel.setAttribute('aria-label', 'Cancel reply');
    cancel.addEventListener('click', () => clear(activeKey));
    element.append(cancel);
  }
  function setContext(key) { activeKey = key || null; renderDraft(); }
  function clear(key, sentReply) {
    if (!sentReply || drafts.get(key) === sentReply) drafts.delete(key);
    renderDraft();
  }
  function decorate(element, message, key, canReply) {
    if (message.reply) element.querySelector('.message-bubble')?.prepend(quoteElement(message.reply));
    if (!canReply || !key || !['user_message', 'agent_message', 'agent_question'].includes(message.type) || message.isEncryptedPlaceholder) return;
    const utilities = element.querySelector('.message-utilities');
    if (!utilities) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'message-utility-btn message-reply-btn';
    button.textContent = '↩'; button.title = 'Reply to this message';
    button.setAttribute('aria-label', 'Reply to this message');
    button.addEventListener('click', () => {
      drafts.set(key, preview(message)); setContext(key);
      document.getElementById('userMessageInput')?.focus();
    });
    utilities.append(button);
  }
  function encode(text, reply) {
    return reply ? JSON.stringify({ type: 'chatmcpspace.reply.v1', text, reply }) : text;
  }
  function decode(text) {
    if (typeof text !== 'string' || !text.startsWith('{')) return null;
    try {
      const value = JSON.parse(text);
      return value.type === 'chatmcpspace.reply.v1' && typeof value.text === 'string' &&
        value.reply && typeof value.reply.messageId === 'string' ? value : null;
    } catch (_) { return null; }
  }
  const api = { setContext, clear, get: key => drafts.get(key), decorate, encode, decode, preview };
  root.MessageReplies = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
