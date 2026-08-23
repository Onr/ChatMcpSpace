const fs = require('fs');
const os = require('os');
const path = require('path');

describe('ttsService cache cleanup', () => {
  let cacheDir;

  beforeEach(() => {
    jest.resetModules();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-cache-'));
    process.env.TTS_CACHE_DIR = cacheDir;
    process.env.TTS_CACHE_MAX_FILES = '2';
    process.env.TTS_CACHE_MAX_AGE_DAYS = '30';
    process.env.TTS_ENABLED = 'false';
  });

  afterEach(() => {
    delete process.env.TTS_CACHE_DIR;
    delete process.env.TTS_CACHE_MAX_FILES;
    delete process.env.TTS_CACHE_MAX_AGE_DAYS;
    delete process.env.TTS_ENABLED;
    fs.rmSync(cacheDir, { recursive: true, force: true });
    jest.resetModules();
  });

  it('removes expired audio files and prunes oldest overflow files', async () => {
    jest.doMock('@google-cloud/text-to-speech', () => ({
      v1beta1: {
        TextToSpeechClient: jest.fn(),
      },
    }));

    const now = new Date();
    const expired = path.join(cacheDir, 'expired.wav');
    const oldest = path.join(cacheDir, 'oldest.wav');
    const keepA = path.join(cacheDir, 'keep-a.wav');
    const keepB = path.join(cacheDir, 'keep-b.mp3');
    const ignored = path.join(cacheDir, 'note.txt');

    fs.writeFileSync(expired, 'expired');
    fs.writeFileSync(oldest, 'oldest');
    fs.writeFileSync(keepA, 'keep-a');
    fs.writeFileSync(keepB, 'keep-b');
    fs.writeFileSync(ignored, 'ignored');

    fs.utimesSync(expired, new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000), new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000));
    fs.utimesSync(oldest, new Date(now.getTime() - 10_000), new Date(now.getTime() - 10_000));
    fs.utimesSync(keepA, new Date(now.getTime() - 5_000), new Date(now.getTime() - 5_000));
    fs.utimesSync(keepB, now, now);

    const { cleanupTtsCache } = require('../../src/services/ttsService');
    const deleted = await cleanupTtsCache();

    expect(deleted).toBe(2);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(keepA)).toBe(true);
    expect(fs.existsSync(keepB)).toBe(true);
    expect(fs.existsSync(ignored)).toBe(true);
  });
});
