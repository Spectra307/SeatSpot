import test from 'node:test';
import assert from 'node:assert/strict';
import { EmailService, sendEmail } from '../src/services/emailService.js';

const silentLogger = { error() {}, warn() {}, info() {} };

function withFetch(impl, fn) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BREVO_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;

  process.env.BREVO_API_KEY = 'test-brevo-key';
  process.env.EMAIL_FROM = 'from@example.com';
  globalThis.fetch = impl;

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.BREVO_API_KEY;
      else process.env.BREVO_API_KEY = originalKey;
      if (originalFrom === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = originalFrom;
    });
}

test('sendEmail posts the expected payload to the Brevo API', async () => {
  let captured;

  await withFetch(
    async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 201, text: async () => '' };
    },
    async () => {
      await sendEmail('to@example.com', 'Test subject', '<p>Hello</p>');
    }
  );

  assert.equal(captured.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['api-key'], 'test-brevo-key');
  assert.equal(captured.options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.options.body), {
    sender: { name: 'SeatSpot', email: 'from@example.com' },
    to: [{ email: 'to@example.com' }],
    subject: 'Test subject',
    htmlContent: '<p>Hello</p>'
  });
});

test('sendEmail throws with the status and response text on failure', async () => {
  await withFetch(
    async () => ({ ok: false, status: 401, text: async () => 'invalid api key' }),
    async () => {
      await assert.rejects(
        () => sendEmail('to@example.com', 'Test subject', '<p>Hello</p>'),
        /401.*invalid api key/
      );
    }
  );
});

test('sendOtp: returns false when Brevo delivery fails', async () => {
  const service = new EmailService({
    sender: async () => { throw new Error('bad credentials'); },
    env: 'production',
    logger: silentLogger,
    configured: true
  });

  assert.equal(await service.sendOtp('user@example.com', '123456'), false);
});

test('sendOtp: returns true when Brevo accepts the message', async () => {
  let sent;
  const service = new EmailService({
    sender: async (to, subject, html) => { sent = { to, subject, html }; },
    env: 'production',
    logger: silentLogger,
    configured: true
  });

  assert.equal(await service.sendOtp('user@example.com', '123456'), true);
  assert.equal(sent.to, 'user@example.com');
  assert.match(sent.html, /123456/);
});

test('sendOtp: dev console fallback reports dispatched', async () => {
  const logs = [];
  const service = new EmailService({
    configured: false,
    env: 'development',
    logger: { error: (...args) => logs.push(args.join(' ')) }
  });

  assert.equal(await service.sendOtp('dev@example.com', '654321'), true);
  assert.ok(logs.some((line) => line.includes('654321')));
});

test('sendOtp: production without Brevo config does not claim delivery', async () => {
  const service = new EmailService({
    configured: false,
    env: 'production',
    logger: silentLogger
  });

  assert.equal(await service.sendOtp('prod@example.com', '654321'), false);
});
