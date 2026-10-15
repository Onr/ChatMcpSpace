const fs = require('fs');
const os = require('os');
const path = require('path');
const { mapPublicModels, refreshModelCatalog, stopModelRefresh } = require('../../src/services/modelRefreshService');
let dir, file;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-refresh-')); file = path.join(dir, 'models.json'); });
afterEach(() => { stopModelRefresh(); fs.rmSync(dir, { recursive: true, force: true }); });
const model = { id: 'anthropic/claude-haiku-99.5', name: 'Haiku future', architecture: { output_modalities: ['text'] } };
test('maps native IDs as unconfirmed and never invents Antigravity account IDs', () => {
  const mapped = mapPublicModels([model, { id: 'image-only', architecture: { output_modalities: ['image'] } }]);
  expect(mapped.claude[0]).toMatchObject({ value: 'claude-haiku-99-5', unconfirmed: true });
  expect(mapped.copilot[0].value).toBe('claude-haiku-99.5');
  expect(mapped.antigravity).toBeUndefined();
});
test('refreshes atomically, uses a three-hour cache, and preserves it on network failure', async () => {
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ data: [model] }) }));
  await refreshModelCatalog({ file, fetchImpl, force: true });
  const previous = fs.readFileSync(file, 'utf8');
  await refreshModelCatalog({ file, fetchImpl }); expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(refreshModelCatalog({ file, force: true, fetchImpl: async () => { throw Error('offline'); } })).rejects.toThrow('offline');
  expect(fs.readFileSync(file, 'utf8')).toBe(previous);
});
test('an invalid or empty provider response does not erase a usable catalog', async () => {
  fs.writeFileSync(file, 'last known catalog');
  await expect(refreshModelCatalog({ file, force: true, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) })).rejects.toThrow('incomplete');
  expect(fs.readFileSync(file, 'utf8')).toBe('last known catalog');
});
