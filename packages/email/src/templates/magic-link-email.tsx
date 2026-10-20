import { EmailButton } from '../components/ui/email-button.tsx';
import { EmailHero } from '../components/ui/email-hero.tsx';
import { EmailLinkFallback } from '../components/ui/email-link-fallback.tsx';
import { EmailSection } from '../components/ui/email-section.tsx';
import { EmailShell } from '../components/ui/email-shell.tsx';
import { EmailStrong, EmailText } from '../components/ui/email-text.tsx';

export interface MagicLinkEmailProps {
  email: string;
  url: string;
  expiresInMinutes: number;
}

export function MagicLinkEmail({ email, url, expiresInMinutes }: MagicLinkEmailProps) {
  return (
    <EmailShell preview={`Your sign-in link expires in ${expiresInMinutes} minutes.`} appUrl={new URL(url).origin}>
      <EmailHero
        eyebrow="Sign in"
        title="Your sign-in link"
        description={
          <>
            Use this link to sign in as <EmailStrong>{email}</EmailStrong>. It works once and expires in{' '}
            {expiresInMinutes} minutes.
          </>
        }
      >
        <EmailButton href={url}>Sign in to TulipFarm</EmailButton>
      </EmailHero>
      <EmailSection>
        <EmailLinkFallback label="Button not working? Paste this link into your browser:" href={url} />
        <EmailText variant="emphasis">Didn't request this?</EmailText>
        <EmailText variant="muted">
          You can ignore this email. Nobody can sign in to your account without this link.
        </EmailText>
      </EmailSection>
    </EmailShell>
  );
}
