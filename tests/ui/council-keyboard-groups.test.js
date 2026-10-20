/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const navigation = source.slice(source.indexOf('function setupKeyboardNavigation()'), source.indexOf('function setFocusArea(area)'));
const focus = source.slice(source.indexOf('function updateAgentFocus()'), source.indexOf('function navigateAgentListBy(delta)'));

function setup(memberCount = 2) {
  document.body.innerHTML = '<div class="group-seat" data-group-id="work"></div><div class="group-seat" data-group-id="empty"></div>';
  let listener;
  const context = vm.createContext({
    document: {
      addEventListener: (type, callback) => { listener = callback; },
      querySelector: selector => document.querySelector(selector),
      querySelectorAll: selector => document.querySelectorAll(selector),
      getElementById: id => document.getElementById(id)
    },
    currentFocusArea: 'council', focusedAgentIndex: -1, previousFocusedIndex: -1,
    selectedAgentId: null, activeGroupId: null,
    getVisibleAgentSeats: () => Array.from(document.querySelectorAll('.agent-seat, .group-seat')),
    hideFloatingAgentMenu: jest.fn(),
    enterGroupView: jest.fn(() => {
      document.body.innerHTML = Array.from({ length: memberCount }, (_, i) =>
        `<div class="agent-seat" data-agent-id="agent-${i}" data-agent-name="Agent ${i}"></div>`).join('');
    }),
    openAgentWithFeedback: jest.fn(), shouldSelectIntoSidePanel: jest.fn(() => true),
    setFocusArea: jest.fn(), setTimeout, clearTimeout
  });
  vm.runInContext(navigation + focus + '\nsetupKeyboardNavigation();', context);
  const press = key => {
    const event = new KeyboardEvent('keydown', { key, cancelable: true });
    Object.defineProperty(event, 'target', { value: document.body });
    listener(event);
    return event;
  };
  return { context, press };
}

test('Enter opens a keyboard-focused group and then its first member without opening a null-agent chat', () => {
  const { context, press } = setup();
  press('ArrowRight');
  const event = press('Enter');
  expect(event.defaultPrevented).toBe(true);
  expect(context.enterGroupView).toHaveBeenCalledWith('work');
  expect(context.openAgentWithFeedback).not.toHaveBeenCalled();
  expect(context.currentFocusArea).toBe('council');
  expect(context.focusedAgentIndex).toBe(0);
  expect(document.querySelector('.agent-seat--focused').dataset.agentId).toBe('agent-0');
  press('Enter');
  expect(context.openAgentWithFeedback).toHaveBeenCalledWith('agent-0', 'Agent 0', expect.any(Object));
});

test('an empty group opens without retaining an invalid member focus', () => {
  const { context, press } = setup(0);
  press('ArrowRight');
  press('ArrowRight');
  press('Enter');
  expect(context.enterGroupView).toHaveBeenCalledWith('empty');
  expect(context.focusedAgentIndex).toBe(-1);
  press('Enter');
  expect(context.openAgentWithFeedback).not.toHaveBeenCalled();
});

test('moving keyboard focus between groups clears the previous highlight', () => {
  const { press } = setup();
  press('ArrowRight');
  press('ArrowRight');
  expect(document.querySelectorAll('.agent-seat--focused')).toHaveLength(1);
  expect(document.querySelector('.agent-seat--focused').dataset.groupId).toBe('empty');
});
