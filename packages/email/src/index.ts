export {
  createEmailSender,
  emailSenderConfigFromEnv,
  emailSenderConfigured,
  type EmailSender,
  type EmailSenderConfig,
} from './sender.ts';
export { createAcsEmailSender, type AcsEmailSenderConfig } from './acs.ts';
export { createSmtpEmailSender, type SmtpEmailSenderConfig } from './smtp.ts';
export { renderEmail, type EmailMessage, type RenderedEmail } from './emails.tsx';
export type { CreditAlertEmailProps, CreditAlertLevel } from './templates/credit-alert-email.tsx';
