import { EmailClient, KnownEmailSendStatus } from '@azure/communication-email';
import type { RenderedEmail } from './emails.tsx';

export interface AcsEmailSenderConfig {
  provider: 'acs';
  connectionString: string;
  senderAddress: string;
}

export function createAcsEmailSender({ connectionString, senderAddress }: AcsEmailSenderConfig) {
  const client = new EmailClient(connectionString);
  return async function sendEmail(to: string, email: RenderedEmail): Promise<string> {
    const poller = await client.beginSend(
      {
        senderAddress,
        recipients: { to: [{ address: to }] },
        content: { subject: email.subject, html: email.html, plainText: email.text },
      },
      { updateIntervalInMs: 1000 },
    );
    const result = await poller.pollUntilDone();
    if (result.status !== KnownEmailSendStatus.Succeeded) {
      throw new Error(`Email ${result.id} ended with status ${result.status}: ${result.error?.message ?? 'no detail'}`);
    }
    return result.id;
  };
}
