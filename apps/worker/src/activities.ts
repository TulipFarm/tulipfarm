import { observeCall } from '@tulipfarm/observability';
import { createEmailSender, emailSenderConfigFromEnv, renderEmail, type EmailMessage } from '@tulipfarm/email';

export async function ping() {
  return observeCall('activity', 'ping', async () => 'ok');
}

export async function sendEmail(to: string, message: EmailMessage): Promise<string> {
  try {
    return await createEmailSender(emailSenderConfigFromEnv())(to, await renderEmail(message));
  } catch {
    throw new Error('Email delivery failed');
  }
}
