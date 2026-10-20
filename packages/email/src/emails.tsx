import { render } from 'react-email';
import { MagicLinkEmail, type MagicLinkEmailProps } from './templates/magic-link-email.tsx';
import { TestEmail, type TestEmailProps } from './templates/test-email.tsx';
import { InvitationEmail, type InvitationEmailProps } from './templates/invitation-email.tsx';
import { PasswordResetEmail, type PasswordResetEmailProps } from './templates/password-reset-email.tsx';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type EmailMessage =
  | { template: 'test'; props: TestEmailProps }
  | { template: 'invitation'; props: InvitationEmailProps }
  | { template: 'magic-link'; props: MagicLinkEmailProps }
  | { template: 'password-reset'; props: PasswordResetEmailProps };

function select(message: EmailMessage) {
  switch (message.template) {
    case 'invitation':
      return {
        subject: "You're invited to TulipFarm",
        element: (
          <InvitationEmail
            url={message.props.url}
            email={message.props.email}
            workspaceName={message.props.workspaceName}
            expiresAt={message.props.expiresAt}
          />
        ),
      };
    case 'test':
      return {
        subject: 'TulipFarm test email',
        element: <TestEmail sentAt={message.props.sentAt} appUrl={message.props.appUrl} />,
      };
    case 'magic-link':
      return {
        subject: 'Sign in to TulipFarm',
        element: (
          <MagicLinkEmail
            email={message.props.email}
            url={message.props.url}
            expiresInMinutes={message.props.expiresInMinutes}
          />
        ),
      };
    case 'password-reset':
      return {
        subject: 'Reset your TulipFarm password',
        element: (
          <PasswordResetEmail
            email={message.props.email}
            url={message.props.url}
            expiresInMinutes={message.props.expiresInMinutes}
          />
        ),
      };
  }
}

export async function renderEmail(message: EmailMessage): Promise<RenderedEmail> {
  const { subject, element } = select(message);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject, html, text };
}
