const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vault = require('../../src/services/mcpKeyVault');

describe('Hosted MCP key protection', () => {
  const originalFile = process.env.MCP_HOSTED_KEY_FILE;
  const originalSecret = process.env.MCP_HOSTED_WRAPPING_KEY;
  let directory;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-vault-'));
    process.env.MCP_HOSTED_KEY_FILE = path.join(directory, 'wrapping-key');
    delete process.env.MCP_HOSTED_WRAPPING_KEY;
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (originalFile === undefined) delete process.env.MCP_HOSTED_KEY_FILE; else process.env.MCP_HOSTED_KEY_FILE = originalFile;
    if (originalSecret === undefined) delete process.env.MCP_HOSTED_WRAPPING_KEY; else process.env.MCP_HOSTED_WRAPPING_KEY = originalSecret;
  });
  test('persists a private wrapping key and binds ciphertext to the owner, identity and grant', () => {
    const key = crypto.randomBytes(32);
    const grant = { user_id: crypto.randomUUID(), agent_id: crypto.randomUUID(), grant_id: crypto.randomUUID() };
    const sealed = vault.wrap(key, grant);
    expect(sealed).not.toContain(key.toString('base64'));
    expect(fs.statSync(process.env.MCP_HOSTED_KEY_FILE).mode & 0o777).toBe(0o600);
    jest.resetModules();
    expect(require('../../src/services/mcpKeyVault').unwrap(sealed, grant)).toEqual(key);
    for (const property of ['user_id', 'agent_id', 'grant_id']) expect(() => vault.unwrap(sealed, { ...grant, [property]: crypto.randomUUID() })).toThrow();
    const parts = sealed.split(':');
    const damaged = Buffer.from(parts[2], 'base64'); damaged[0] ^= 1; parts[2] = damaged.toString('base64');
    expect(() => vault.unwrap(parts.join(':'), grant)).toThrow();
  });
  test('fails closed for public files, symlinks, invalid secrets and wrong master keys', () => {
    const grant = { user_id: 'owner', agent_id: 'agent', grant_id: 'grant' };
    const sealed = vault.wrap(crypto.randomBytes(32), grant);
    fs.chmodSync(process.env.MCP_HOSTED_KEY_FILE, 0o644);
    expect(() => vault.unwrap(sealed, grant)).toThrow(/private/);
    fs.chmodSync(process.env.MCP_HOSTED_KEY_FILE, 0o600);
    const link = path.join(directory, 'link'); fs.symlinkSync(process.env.MCP_HOSTED_KEY_FILE, link);
    process.env.MCP_HOSTED_KEY_FILE = link;
    expect(() => vault.unwrap(sealed, grant)).toThrow();
    process.env.MCP_HOSTED_WRAPPING_KEY = 'invalid';
    expect(() => vault.unwrap(sealed, grant)).toThrow(/32/);
    process.env.MCP_HOSTED_WRAPPING_KEY = crypto.randomBytes(32).toString('base64');
    expect(() => vault.unwrap(sealed, grant)).toThrow();
  });
});
