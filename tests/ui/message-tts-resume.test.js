/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

const dashboardSource = fs.readFileSync(
  path.join(__dirname, '../../public/js/dashboard.js'),
  'utf8'
);

function loadCheckpointHelpers() {
  const start = dashboardSource.indexOf('function hashMessageTtsText');
  const end = dashboardSource.indexOf('function resetTtsButtonState', start);
  if (start < 0 || end < 0) throw new Error('Could not locate message TTS checkpoint helpers');

  const factory = new Function(
    'localStorage',
    'MESSAGE_TTS_CHECKPOINT_STORAGE_KEY',
    'MESSAGE_TTS_CHECKPOINT_LIMIT',
    `${dashboardSource.slice(start, end)}
     return { hashMessageTtsText, getMessageTtsPlaybackKey, getMessageTtsCheckpoint, saveMessageTtsCheckpoint, findMessageTtsWordOffset };`
  );

  return factory(localStorage, 'test_message_tts_checkpoints', 3);
}

describe('resumable message TTS state', () => {
  beforeEach(() => localStorage.clear());

  it('stores a checkpoint without storing the message text', () => {
    const helpers = loadCheckpointHelpers();
    const text = 'A private message that should not be copied into storage.';

    helpers.saveMessageTtsCheckpoint('message:42', text, 10, 1.25);

    const raw = localStorage.getItem('test_message_tts_checkpoints');
    expect(raw).not.toContain(text);
    expect(helpers.getMessageTtsCheckpoint('message:42', text)).toMatchObject({
      offset: 10,
      rate: 1.25
    });
  });

  it('rejects stale checkpoints when message content changes', () => {
    const helpers = loadCheckpointHelpers();
    helpers.saveMessageTtsCheckpoint('message:42', 'Original text', 5, 1);

    expect(helpers.getMessageTtsCheckpoint('message:42', 'Edited text')).toBeNull();
  });

  it('snaps slider positions to a whole-word boundary', () => {
    const helpers = loadCheckpointHelpers();
    const text = 'alpha beta gamma';

    expect(helpers.findMessageTtsWordOffset(text, 8)).toBe(6);
    expect(helpers.findMessageTtsWordOffset(text, 10)).toBe(11);
    expect(helpers.findMessageTtsWordOffset(text, text.length)).toBe(text.length);
  });

  it('bounds checkpoint history and clears completed playback', () => {
    const helpers = loadCheckpointHelpers();
    for (let index = 0; index < 4; index += 1) {
      helpers.saveMessageTtsCheckpoint(`message:${index}`, `text ${index}`, 2, 1);
    }
    const stored = JSON.parse(localStorage.getItem('test_message_tts_checkpoints'));
    expect(Object.keys(stored)).toHaveLength(3);

    helpers.saveMessageTtsCheckpoint('message:3', 'text 3', 'text 3'.length, 1);
    expect(helpers.getMessageTtsCheckpoint('message:3', 'text 3')).toBeNull();
  });
});
