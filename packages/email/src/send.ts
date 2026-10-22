import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createEmailSender, emailSenderConfigFromEnv } from './sender.ts';
import { renderEmail, type EmailMessage } from './emails.tsx';

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    html: { type: 'string' },
    template: { type: 'string', default: 'test' },
    url: { type: 'string', default: 'http://localhost:5173/verify-email?token=example' },
  },
});

if (!values.to && !values.html)
  throw new Error(
    'Usage: send --to <address> or --html <path> [--template test|magic-link|password-reset|invitation] [--url <link>]',
  );

let message: EmailMessage;
if (values.template === 'magic-link') {
  message = {
    template: 'magic-link',
    props: { email: values.to ?? 'example@example.com', url: values.url, expiresInMinutes: 15 },
  };
} else if (values.template === 'password-reset') {
  message = {
    template: 'password-reset',
    props: { email: values.to ?? 'example@example.com', url: values.url, expiresInMinutes: 60 },
  };
} else if (values.template === 'invitation') {
  message = { template: 'invitation', props: { url: values.url } };
} else if (values.template === 'test') {
  message = { template: 'test', props: { sentAt: new Date().toUTCString(), appUrl: new URL(values.url).origin } };
} else {
  throw new Error(`Unknown template: ${values.template}`);
}

const rendered = await renderEmail(message);
if (values.html) await writeFile(values.html, rendered.html);
else if (values.to) {
  const id = await createEmailSender(emailSenderConfigFromEnv())(values.to, rendered);
  console.log(`Sent ${values.template} email ${id}`);
}
