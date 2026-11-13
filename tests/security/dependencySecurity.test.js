const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const merge = require('deepmerge');
const deepmergePackage = require('deepmerge/package.json');
const request = require('supertest');

describe('security dependency compatibility', () => {
  test('patched Multer still accepts bounded in-memory uploads', async () => {
    const app = express();
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 1024 }
    });

    app.post('/upload', upload.single('file'), (req, res) => {
      res.json({ size: req.file.buffer.length, name: req.file.originalname });
    });

    await request(app)
      .post('/upload')
      .attach('file', Buffer.from('secure upload'), 'note.txt')
      .expect(200, { size: 13, name: 'note.txt' });
  });

  test('patched Nodemailer handles ordinary and deeply nested recipients', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const ordinary = await transport.sendMail({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Compatibility check',
      text: 'ok'
    });
    expect(ordinary.message).toBeTruthy();

    let deeplyNested = 'recipient@example.test';
    for (let depth = 0; depth < 5000; depth += 1) deeplyNested = [deeplyNested];

    await expect(transport.sendMail({
      from: 'sender@example.test',
      to: deeplyNested,
      subject: 'Depth safety check',
      text: 'ok'
    })).resolves.toHaveProperty('message');
  });

  test('Jest uses the patched deepmerge build and rejects prototype poisoning', () => {
    const nullPrototypeTarget = Object.create(null);
    nullPrototypeTarget.debug = false;
    const malicious = JSON.parse('{"__proto__":{"isAdmin":true}}');
    const merged = merge(nullPrototypeTarget, malicious);

    expect(deepmergePackage.version).toBe('4.3.2-security.0');
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.isAdmin).toBeUndefined();
    expect(merged.debug).toBe(false);

    const nested = merge(
      { session: null },
      JSON.parse('{"session":{"__proto__":{"isAdmin":true}}}')
    );
    expect(Object.getPrototypeOf(nested.session)).toBe(Object.prototype);
    expect(nested.session.isAdmin).toBeUndefined();
  });
});
