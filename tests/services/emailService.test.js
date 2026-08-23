const mockQuery = jest.fn();
const mockCreateTransport = jest.fn();
const mockSendMail = jest.fn();
const mockVerify = jest.fn();
const mockReadFileSync = jest.fn();

jest.mock('../../src/db/connection', () => ({
  query: (...args) => mockQuery(...args)
}));

jest.mock('nodemailer', () => ({
  createTransport: (...args) => mockCreateTransport(...args)
}));

jest.mock('fs', () => ({
  readFileSync: (...args) => mockReadFileSync(...args)
}));

describe('emailService', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.EMAIL_USER = 'test@example.com';
    process.env.EMAIL_PASSWORD = 'password';

    mockSendMail.mockResolvedValue({ messageId: 'message-1' });
    mockVerify.mockResolvedValue(true);
    mockCreateTransport.mockReturnValue({
      sendMail: mockSendMail,
      verify: mockVerify
    });
    mockReadFileSync.mockReturnValue(Buffer.from('logo-bytes'));
    mockQuery.mockImplementation((text) => {
      if (text.includes('INSERT INTO email_logs')) {
        return Promise.resolve({ rows: [{ log_id: 'log-1', created_at: new Date() }] });
      }

      return Promise.resolve({ rows: [] });
    });
  });

  afterEach(() => {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASSWORD;
  });

  it('creates a hardened transport and inlines the logo attachment when sending verification email', async () => {
    const emailService = require('../../src/services/emailService');

    const result = await emailService.sendVerificationEmail('user-1', 'person@example.com', { ip: '127.0.0.1' });

    expect(result).toMatchObject({ success: true, messageId: 'message-1', logId: 'log-1' });
    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: 'test@example.com', pass: 'password' },
      disableFileAccess: true,
      disableUrlAccess: true,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5
    }));
    expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringMatching(/public\/images\/logo\.png$/));
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'person@example.com',
      attachments: [
        expect.objectContaining({
          filename: 'logo.png',
          content: Buffer.from('logo-bytes'),
          cid: 'logo'
        })
      ]
    }));

    const sentMail = mockSendMail.mock.calls[0][0];
    expect(sentMail.attachments[0]).not.toHaveProperty('path');
  });

  it('verifies the configured transport connection', async () => {
    const emailService = require('../../src/services/emailService');

    await expect(emailService.verifyEmailConnection()).resolves.toBe(true);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });
});
