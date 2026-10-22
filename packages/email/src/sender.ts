import { observeDependency } from '@tulipfarm/observability';
import { createAcsEmailSender, type AcsEmailSenderConfig } from './acs.ts';
import { createSmtpEmailSender, type SmtpEmailSenderConfig } from './smtp.ts';
import type { RenderedEmail } from './emails.tsx';

export type EmailSenderConfig = AcsEmailSenderConfig | SmtpEmailSenderConfig;
export type EmailSender = (to: string, email: RenderedEmail) => Promise<string>;

const emailProviders = ['acs', 'smtp'] as const;
const address = /^[^\s<>@]+@[^\s<>@]+$/;

/** True when the environment selects or configures a real email transport. */
export function emailSenderConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.EMAIL_PROVIDER || env.ACS_CONNECTION_STRING || env.SMTP_HOST);
}

/**
 * Reads `EMAIL_PROVIDER` (`acs` or `smtp`). When unset, ACS is used if
 * `ACS_CONNECTION_STRING` is present, otherwise SMTP if `SMTP_HOST` is present.
 */
export function emailSenderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailSenderConfig {
  const selected = env.EMAIL_PROVIDER || (env.ACS_CONNECTION_STRING ? 'acs' : env.SMTP_HOST ? 'smtp' : undefined);
  if (selected === 'smtp') return smtpConfigFromEnv(env);
  if (selected === 'acs') {
    const connectionString = env.ACS_CONNECTION_STRING;
    const senderAddress = env.ACS_SENDER_ADDRESS;
    if (!connectionString || !senderAddress)
      throw new Error('ACS_CONNECTION_STRING and ACS_SENDER_ADDRESS must be set');
    return { provider: 'acs', connectionString, senderAddress };
  }
  if (selected) throw new Error(`EMAIL_PROVIDER must be one of: ${emailProviders.join(', ')}`);
  throw new Error(
    'Email is not configured: set EMAIL_PROVIDER=smtp with SMTP_* settings, or ACS_CONNECTION_STRING and ACS_SENDER_ADDRESS',
  );
}

function smtpConfigFromEnv(env: NodeJS.ProcessEnv): SmtpEmailSenderConfig {
  const host = env.SMTP_HOST;
  const senderAddress = env.SMTP_FROM_ADDRESS;
  if (!host || !senderAddress) throw new Error('SMTP_HOST and SMTP_FROM_ADDRESS must be set');
  if (!address.test(senderAddress)) throw new Error('SMTP_FROM_ADDRESS must be a single email address');
  const secure = booleanSetting(env, 'SMTP_SECURE', env.SMTP_PORT === '465');
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : secure ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a TCP port');
  const requireTLS = booleanSetting(env, 'SMTP_REQUIRE_TLS', true);
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASSWORD;
  if (!user !== !pass) throw new Error('SMTP_USER and SMTP_PASSWORD must be set together');
  return {
    provider: 'smtp',
    host,
    port,
    secure,
    requireTLS,
    ...(user && pass ? { auth: { user, pass } } : {}),
    senderAddress,
  };
}

function booleanSetting(env: NodeJS.ProcessEnv, key: string, fallback: boolean) {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error(`${key} must be true or false`);
}

export function createEmailSender(config: EmailSenderConfig): EmailSender {
  const send = config.provider === 'smtp' ? createSmtpEmailSender(config) : createAcsEmailSender(config);
  return (to, email) => observeDependency('email', 'send', () => send(to, email));
}
