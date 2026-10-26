import test from 'node:test';
import assert from 'node:assert/strict';
import { EmailService } from '../src/services/emailService.js';

const silentLogger = { error() {}, warn() {}, info() {} };

test('sendOtp: returns false when SMTP delivery fails', async () => {
  const service = new EmailService({
    transport: { async sendMail() { throw Object.assign(new Error('bad credentials'), { code: 'EAUTH' }); } },
    from: 'SeatSpot <no-reply@seatspot.app>',
    env: 'production',
    logger: silentLogger
  });

  assert.equal(await service.sendOtp('user@example.com', '123456'), false);
});

test('sendOtp: returns true when the transport accepts the message', async () => {
  let sent;
  const service = new EmailService({
    transport: { async sendMail(message) { sent = message; } },
    from: 'SeatSpot <no-reply@seatspot.app>',
    env: 'production',
    logger: silentLogger
  });

  assert.equal(await service.sendOtp('user@example.com', '123456'), true);
  assert.equal(sent.to, 'user@example.com');
  assert.match(sent.html, /123456/);
});

test('sendOtp: dev console fallback reports dispatched', async () => {
  const logs = [];
  const service = new EmailService({
    transport: null,
    from: 'SeatSpot <no-reply@seatspot.app>',
    env: 'development',
    logger: { error: (...args) => logs.push(args.join(' ')) }
  });

  assert.equal(await service.sendOtp('dev@example.com', '654321'), true);
  assert.ok(logs.some((line) => line.includes('654321')));
});

test('sendOtp: production without a transport does not claim delivery', async () => {
  const service = new EmailService({
    transport: null,
    from: 'SeatSpot <no-reply@seatspot.app>',
    env: 'production',
    logger: silentLogger
  });

  assert.equal(await service.sendOtp('prod@example.com', '654321'), false);
});
