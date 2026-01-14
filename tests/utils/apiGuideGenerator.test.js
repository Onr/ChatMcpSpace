const { generateApiGuide, generateDirectSetupScript } = require('../../src/utils/apiGuideGenerator');

describe('generateApiGuide', () => {
  it('mentions the sanitized agent folder and CLI flow', () => {
    const markdown = generateApiGuide('KEY123', 'https://example.com', 'My Agent!', 'salt');
    expect(markdown).toContain('chatspace/my_agent_/');
    expect(markdown).toMatch(/history/);
    expect(markdown).toMatch(/send/);
    expect(markdown).toMatch(/ask/);
    expect(markdown).toMatch(/ALL further conversation happens through these CLI commands/);
  });
});

describe('generateDirectSetupScript', () => {
  it('embeds API values and encryption prompts when salt is provided', () => {
    const script = generateDirectSetupScript('K-123', 'https://api.example.com', 'Agent One!', 'abc123');
    expect(script).toContain('API_KEY="K-123"');
    expect(script).toContain('API_BASE="https://api.example.com/api"');
    expect(script).toContain('ENCRYPTION_SALT="abc123"');
    expect(script).toContain('chatspace/agent_one_');
    expect(script).toContain('read -sp "Enter your account password');
    expect(script).toContain('cryptography.hazmat.primitives.ciphers.aead');
    expect(script).toContain('"encrypted": True');
  });

  it('omits password prompt and encryption plumbing when salt is missing', () => {
    const script = generateDirectSetupScript('K-456', 'http://localhost:3000', 'Agent Two!', null);
    expect(script).toContain('ENCRYPTION_SALT=""');
    expect(script).toContain('USER_PASSWORD=""');
    expect(script).toContain('chatspace/agent_two_');
    expect(script).not.toContain('cryptography.hazmat.primitives.ciphers.aead');
    expect(script).toContain('"encrypted": False');
  });
});
