import { getConfig } from '../src/config/env.js';
import { sendEmail } from '../src/services/emailService.js';

async function main() {
  const config = getConfig();
  if (!config.brevoApiKey || !config.emailFrom) {
    throw new Error('BREVO_API_KEY and EMAIL_FROM are required to send a test email');
  }

  const recipient = process.argv[2] ?? config.emailFrom;
  await sendEmail(
    recipient,
    'SeatSpot test email',
    '<p>This is a test message from SeatSpot.</p>'
  );
  console.info(`Test email sent to ${recipient}`);
}

main().catch((error) => {
  console.error('Test email script failed:', error?.message ?? error);
  process.exit(1);
});
