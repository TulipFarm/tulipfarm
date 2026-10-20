import { EmailButton } from '../components/ui/email-button.tsx';
import { EmailHero } from '../components/ui/email-hero.tsx';
import { EmailLinkFallback } from '../components/ui/email-link-fallback.tsx';
import { EmailSection } from '../components/ui/email-section.tsx';
import { EmailShell } from '../components/ui/email-shell.tsx';
import { EmailStrong, EmailText } from '../components/ui/email-text.tsx';

export interface PasswordResetEmailProps {
  email: string;
  url: string;
  expiresInMinutes: number;
}

export function PasswordResetEmail({ email, url, expiresInMinutes }: PasswordResetEmailProps) {
  return (
    <EmailShell
      preview={`Your password reset link expires in ${expiresInMinutes} minutes.`}
      appUrl={new URL(url).origin}
    >
      <EmailHero
        eyebrow="Password"
        title="Reset your password"
        description={
          <>
            Use this link to choose a new password for <EmailStrong>{email}</EmailStrong>. It works once and expires in{' '}
            {expiresInMinutes} minutes.
          </>
        }
      >
        <EmailButton href={url}>Choose a new password</EmailButton>
      </EmailHero>
      <EmailSection>
        <EmailLinkFallback label="Button not working? Paste this link into your browser:" href={url} />
        <EmailText variant="emphasis">Didn't request this?</EmailText>
        <EmailText variant="muted">
          You can ignore this email. Your password stays the same unless someone opens this link.
        </EmailText>
      </EmailSection>
    </EmailShell>
  );
}
