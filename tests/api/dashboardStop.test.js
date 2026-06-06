const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Dashboard stop route', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('POST /dashboard/stop finds agents in .chatspace and writes stop flag', async () => {
    jest.resetModules();

    jest.doMock('../../src/middleware/authMiddleware', () => ({
      protectRoute: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    }));

    jest.doMock('../../src/middleware/csrfMiddleware', () => ({
      csrfProtection: (_req, _res, next) => next(),
      validateCsrfToken: (_req, _res, next) => next(),
    }));

    jest.doMock('../../src/db/connection', () => ({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }));

    const pageRoutes = require('../../src/routes/pageRoutes');

    const app = express();
    app.use(express.json());
    app.use(pageRoutes);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-dashboard-stop-'));
    const agentName = 'DashboardStopAgent';
    const agentFolder = agentName.toLowerCase();
    const agentDir = path.join(tmpRoot, '.chatspace', agentFolder);
    fs.mkdirSync(path.join(agentDir, 'agent_state'), { recursive: true });

    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
    const homeBackup = process.env.HOME;
    process.env.HOME = path.join(tmpRoot, 'home');

    try {
      const response = await request(app)
        .post('/dashboard/stop')
        .send({ agentName })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBeDefined();

      const stopFlagPath = path.join(agentDir, 'agent_state', '.stop_requested');
      expect(fs.existsSync(stopFlagPath)).toBe(true);
      expect(fs.readFileSync(stopFlagPath, 'utf8').trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      cwdSpy.mockRestore();
      process.env.HOME = homeBackup;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
