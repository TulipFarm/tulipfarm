import { createTransport, type Transporter } from 'nodemailer';
import type { RenderedEmail } from './emails.tsx';

export interface SmtpEmailSenderConfig {
  provider: 'smtp';
  host: string;
  port: number;
  /** Implicit TLS from connection start, usually port 465. */
  secure: boolean;
  /** Refuse to send unless the server upgrades with STARTTLS. Ignored when `secure` is true. */
  requireTLS: boolean;
  auth?: { user: string; pass: string };
  senderAddress: string;
}

export function createSmtpEmailSender(config: SmtpEmailSenderConfig, options: { transport?: Transporter } = {}) {
  const transport =
    options.transport ??
    createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure && config.requireTLS,
      ...(config.auth ? { auth: config.auth } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  return async function sendEmail(to: string, email: RenderedEmail): Promise<string> {
    const info = await transport.sendMail({
      from: config.senderAddress,
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    if (info.rejected?.length || !info.accepted?.length) throw new Error('SMTP server did not accept the recipient');
    return info.messageId;
  };
}
