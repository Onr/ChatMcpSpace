/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const declaration = parser.parse(source, { sourceType: 'script' }).program.body
  .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'renderSharedRichContent');
let submit, context;

beforeEach(() => {
  document.body.innerHTML = '<div id="rich-container"></div>';
  context = { mode: 'shared', conversationId: 'room-one', agentId: 'agent-one' };
  window.InPlaceChat = { getContext: () => context, sendMessage: jest.fn().mockResolvedValue({ messages: [] }) };
  window.RichRendering = {
    renderRichContent: jest.fn((_data, callback) => { submit = callback; return document.createElement('form'); }),
    sendFormResponse: jest.fn()
  };
  window.loadMessages = jest.fn().mockResolvedValue();
  window.eval(source.slice(declaration.start, declaration.end));
  window.renderSharedRichContent(document.getElementById('rich-container'), { title: 'Shared form' }, 'room-one');
});

test('shared rich form responses use the same conversation transport and refresh its normal chat', async () => {
  expect(document.querySelector('#rich-container form')).not.toBeNull();
  await submit('Plan: Proceed');
  expect(window.InPlaceChat.sendMessage).toHaveBeenCalledWith('Plan: Proceed');
  expect(window.loadMessages).toHaveBeenCalledWith('agent-one');
  expect(window.RichRendering.sendFormResponse).not.toHaveBeenCalled();
});

test('a form from another conversation cannot send through the newly selected chat', async () => {
  context = { ...context, conversationId: 'room-two' };
  await expect(submit('Plan: Proceed')).rejects.toThrow('Open the conversation containing this form');
  expect(window.InPlaceChat.sendMessage).not.toHaveBeenCalled();
  expect(window.RichRendering.sendFormResponse).not.toHaveBeenCalled();
});

test('switching after a successful submission does not refresh the new chat with old form results', async () => {
  window.InPlaceChat.sendMessage.mockImplementation(async () => { context = { ...context, conversationId: 'room-two' }; });
  await submit('Plan: Proceed');
  expect(window.InPlaceChat.sendMessage).toHaveBeenCalledTimes(1);
  expect(window.loadMessages).not.toHaveBeenCalled();
});

test('recovering an older outbox request does not mark a newer form response as submitted', async () => {
  window.InPlaceChat.sendMessage.mockResolvedValue({ preserveDraft: true });
  await expect(submit('New form response')).rejects.toThrow('Submit this form again');
  expect(window.loadMessages).toHaveBeenCalledWith('agent-one');
});
