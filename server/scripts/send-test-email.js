import nodemailer from 'nodemailer';
import { getConfig } from '../src/config/env.js';

async function main() {
  const config = getConfig();
  const recipient = process.argv[2] ?? config.smtpUser ?? 'test@example.com';
  if (config.smtpHost) {
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: Number(config.smtpPort ?? 587),
      secure: Number(config.smtpPort ?? 587) === 465,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined
    });
    try {
      await transporter.verify();
      console.log('SMTP verify succeeded');
    } catch (error) {
      console.error('SMTP verify failed:', error?.message ?? error);
      if (error?.code) console.error('SMTP error code:', error.code);
    }
    try {
      const info = await transporter.sendMail({
        from: config.mailFrom,
        to: recipient,
        subject: 'SeatSpot test email',
        text: 'This is a test message from SeatSpot.'
      });
      console.log('Sent to:', recipient);
      console.log('SendMail result:', info?.messageId);
      const previewUrl = nodemailer.getTestMessageUrl?.(info);
      if (previewUrl) console.log('Preview URL:', previewUrl);
    } catch (error) {
      console.error('SMTP sendMail failed:', error?.message ?? error);
      if (error?.code) console.error('SMTP error code:', error.code);
      throw error;
    }
    return;
  }

  const testAccount = await nodemailer.createTestAccount();
  const transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass
    }
  });
  try {
    await transporter.verify();
    console.log('Ethereal verify succeeded');
  } catch (error) {
    console.error('Ethereal verify failed:', error?.message ?? error);
    if (error?.code) console.error('SMTP error code:', error.code);
  }
  const info = await transporter.sendMail({
    from: 'SeatSpot <no-reply@seatspot.app>',
    to: recipient,
    subject: 'SeatSpot test email (Ethereal)',
    text: 'This is a test OTP/email from SeatSpot.'
  });
  console.log('MessageId:', info?.messageId);
  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) console.log('Preview URL:', previewUrl);
}

main().catch((error) => {
  console.error('Test email script failed:', error?.message ?? error);
  process.exit(1);
});


