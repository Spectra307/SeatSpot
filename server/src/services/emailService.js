/**
 * emailService.js — Nodemailer-based transactional email delivery.
 *
 * The transport is created once and injected through the constructor so it can
 * be swapped for any compatible transport (Resend, SendGrid via nodemailer-
 * sendgrid, AWS SES, etc.) without touching this file.
 *
 * If SMTP credentials are absent in development the service falls back to a
 * no-op that logs the OTP to the server console.  In production, missing SMTP
 * config causes every send to fail silently (the caller must fire-and-forget).
 */

import nodemailer from 'nodemailer';

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function htmlWrap(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f7f5;font-family:'DM Sans',Arial,sans-serif;color:#1e2b28;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border:1px solid #dfe7e3;border-radius:12px;overflow:hidden;">
        <!-- Header -->
        <tr>
          <td style="background:#153d35;padding:24px 32px;">
            <span style="color:#b3cbc2;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;">SeatSpot</span>
          </td>
        </tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          ${body}
        </td></tr>
        <!-- Footer -->
        <tr>
          <td style="padding:18px 32px;border-top:1px solid #edf2ef;color:#97a49e;font-size:11px;">
            You received this email because you have a SeatSpot account.
            If you did not request this, you can safely ignore it.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function otpTemplate({ otp, expiresMinutes = 5 }) {
  return htmlWrap('Verify your SeatSpot account', `
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#153d35;">One quick check.</h2>
    <p style="margin:0 0 28px;color:#718079;font-size:14px;line-height:1.6;">
      Enter this code to verify your SeatSpot account.
      It expires in <strong>${expiresMinutes} minutes</strong>.
    </p>
    <div style="display:inline-block;padding:18px 36px;border-radius:8px;background:#f0f8f4;
                border:1px solid #c9e2d8;font-size:32px;font-weight:800;
                letter-spacing:.34em;color:#087f70;font-family:'Courier New',monospace;">
      ${otp}
    </div>
    <p style="margin:24px 0 0;color:#9aa69f;font-size:12px;">
      If you didn't sign up for SeatSpot, you can safely ignore this email.
    </p>
  `);
}

function bookingConfirmTemplate({ customerName, restaurantName, tableLabel, partySize, startsAt }) {
  const formattedDate = new Date(startsAt).toLocaleString('en-IN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata'
  });
  return htmlWrap('Booking confirmed – SeatSpot', `
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#153d35;">You're all set.</h2>
    <p style="margin:0 0 24px;color:#718079;font-size:14px;line-height:1.6;">
      Hi ${customerName ?? 'there'}, your table has been reserved.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border:1px solid #dfe7e3;border-radius:8px;overflow:hidden;">
      <tr style="background:#f8faf9;">
        <td style="padding:14px 18px;font-size:11px;color:#7a8981;font-weight:700;text-transform:uppercase;letter-spacing:.08em;">Restaurant</td>
        <td style="padding:14px 18px;font-size:14px;font-weight:600;color:#1e2b28;">${restaurantName ?? '—'}</td>
      </tr>
      <tr>
        <td style="padding:14px 18px;font-size:11px;color:#7a8981;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border-top:1px solid #edf2ef;">Table</td>
        <td style="padding:14px 18px;font-size:14px;font-weight:600;color:#1e2b28;border-top:1px solid #edf2ef;">${tableLabel ?? '—'}</td>
      </tr>
      <tr style="background:#f8faf9;">
        <td style="padding:14px 18px;font-size:11px;color:#7a8981;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border-top:1px solid #edf2ef;">Party</td>
        <td style="padding:14px 18px;font-size:14px;font-weight:600;color:#1e2b28;border-top:1px solid #edf2ef;">${partySize} guest${partySize !== 1 ? 's' : ''}</td>
      </tr>
      <tr>
        <td style="padding:14px 18px;font-size:11px;color:#7a8981;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border-top:1px solid #edf2ef;">Time</td>
        <td style="padding:14px 18px;font-size:14px;font-weight:600;color:#087f70;border-top:1px solid #edf2ef;">${formattedDate}</td>
      </tr>
    </table>
    <p style="margin:20px 0 0;color:#9aa69f;font-size:12px;">
      To cancel, visit your bookings page in the SeatSpot app.
    </p>
  `);
}

function bookingCancelTemplate({ customerName, restaurantName, tableLabel, startsAt }) {
  const formattedDate = new Date(startsAt).toLocaleString('en-IN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata'
  });
  return htmlWrap('Booking cancelled – SeatSpot', `
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#153d35;">Booking cancelled.</h2>
    <p style="margin:0 0 24px;color:#718079;font-size:14px;line-height:1.6;">
      Hi ${customerName ?? 'there'}, your reservation has been cancelled.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border:1px solid #dfe7e3;border-radius:8px;overflow:hidden;">
      <tr style="background:#f8faf9;">
        <td style="padding:14px 18px;font-size:11px;color:#7a8981;font-weight:700;text-transform:uppercase;letter-spacing:.08em;">Restaurant</td>
        <td style="padding:14px 18px;font-size:14px;color:#1e2b28;">${restaurantName ?? '—'}</td>
      </tr>
      <tr>
        <td style="padding:14px 18px;font-size:11px;color:#7a8981;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border-top:1px solid #edf2ef;">Table</td>
        <td style="padding:14px 18px;font-size:14px;color:#1e2b28;border-top:1px solid #edf2ef;">${tableLabel ?? '—'}</td>
      </tr>
      <tr style="background:#f8faf9;">
        <td style="padding:14px 18px;font-size:11px;color:#7a8981;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border-top:1px solid #edf2ef;">Was booked for</td>
        <td style="padding:14px 18px;font-size:14px;color:#1e2b28;border-top:1px solid #edf2ef;">${formattedDate}</td>
      </tr>
    </table>
    <p style="margin:20px 0 0;color:#9aa69f;font-size:12px;">
      A table is available again. Book a new reservation any time in the SeatSpot app.
    </p>
  `);
}

// ---------------------------------------------------------------------------
// EmailService
// ---------------------------------------------------------------------------

export class EmailService {
  /**
   * @param {object} options
   * @param {object|null} options.transport  A nodemailer transport (or null for no-op).
   * @param {string}      options.from       Sender address, e.g. "SeatSpot <no-reply@seatspot.app>"
   * @param {string}      [options.env]      NODE_ENV – controls dev console fallback.
   * @param {object}      [options.logger]   Optional logger (defaults to console).
   */
  constructor({ transport = null, from, env = 'development', logger = console } = {}) {
    this.transport = transport;
    this.from = from ?? 'SeatSpot <no-reply@seatspot.app>';
    this.env = env;
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Send a verification OTP to a new user. Never throws.
   * @returns {Promise<boolean>} true when the code was handed to SMTP (or logged
   *   to the dev console), false when delivery was skipped or failed.
   */
  async sendOtp(toEmail, otp, { expiresMinutes = 5 } = {}) {
    // In development with no SMTP config, print to console ONLY.
    if (!this.transport) {
      if (this.env !== 'production') {
        // eslint-disable-next-line no-console
        this.logger.error(`[SeatSpot DEV] OTP for ${toEmail}: ${otp}`);
        // eslint-disable-next-line no-console
        this.logger.error('[SeatSpot] SMTP not configured: OTPs print to this console only');
        return true;
      }
      return false;
    }
    try {
      await this._send({
        to: toEmail,
        subject: 'Your SeatSpot verification code',
        html: otpTemplate({ otp, expiresMinutes })
      });
      return true;
    } catch (error) {
      try {
        this.logger.error('[SeatSpot] OTP email delivery failed for %s:', toEmail, error?.message ?? error);
        if (error?.code) {
          this.logger.error('[SeatSpot] SMTP error code:', error.code);
        }
      } catch {
        // swallow
      }
      return false;
    }
  }

  /** Fire-and-forget confirmation email. Never throws. */
  sendBookingConfirmation(toEmail, data) {
    void this._sendSafe({
      to: toEmail,
      subject: `Booking confirmed – ${data.restaurantName ?? 'SeatSpot'}`,
      html: bookingConfirmTemplate(data)
    });
  }

  /** Fire-and-forget cancellation email. Never throws. */
  sendBookingCancellation(toEmail, data) {
    void this._sendSafe({
      to: toEmail,
      subject: `Booking cancelled – ${data.restaurantName ?? 'SeatSpot'}`,
      html: bookingCancelTemplate(data)
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async _send({ to, subject, html }) {
    if (!this.transport) return;
    await this.transport.sendMail({ from: this.from, to, subject, html });
  }

  async _sendSafe(message) {
    try {
      await this._send(message);
    } catch (error) {
      try {
        this.logger.warn('[SeatSpot] Email delivery failed:', error?.message ?? error);
      } catch {
        // logger itself failed — swallow silently
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an EmailService from environment config.
 * Returns a no-op service when SMTP_HOST is absent (safe for dev / CI).
 */
export function createEmailService({ env, smtpHost, smtpPort, smtpUser, smtpPass, mailFrom } = {}) {
  let transport = null;

  if (smtpHost) {
    transport = nodemailer.createTransport({
      host: smtpHost,
      port: Number(smtpPort ?? 587),
      secure: Number(smtpPort ?? 587) === 465,
      auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined
    });
  } else if ((env ?? process.env.NODE_ENV) === 'production') {
    throw new Error('SMTP_HOST must be configured in production');
  } else if ((env ?? process.env.NODE_ENV) !== 'test') {
    try {
      console.error('[SeatSpot] SMTP not configured: OTPs print to this console only');
    } catch {
      // ignore
    }
  }

  return new EmailService({ transport, from: mailFrom, env });
}
