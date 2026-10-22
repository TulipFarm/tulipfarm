import { EmailButton } from '../components/ui/email-button.tsx';
import { EmailHero } from '../components/ui/email-hero.tsx';
import { EmailLinkFallback } from '../components/ui/email-link-fallback.tsx';
import { EmailSection } from '../components/ui/email-section.tsx';
import { EmailShell } from '../components/ui/email-shell.tsx';
import { EmailText } from '../components/ui/email-text.tsx';

export interface InvitationEmailProps {
  url: string;
  email?: string | undefined;
  workspaceName?: string | undefined;
  expiresAt?: string | undefined;
}
export function InvitationEmail({ url, email, workspaceName, expiresAt }: InvitationEmailProps) {
  return (
    <EmailShell preview="You have been invited to a TulipFarm workspace." appUrl={new URL(url).origin}>
      <EmailHero
        eyebrow="Workspace invitation"
        title={workspaceName ? `Join ${workspaceName}` : "You're invited to TulipFarm"}
        description={
          email
            ? `Sign in with ${email} to join this workspace. Only this verified email can use the link once.`
            : 'Sign in with this email address to join the workspace. This invitation expires seven days after it was created.'
        }
      >
        <EmailButton href={url}>Accept Invite</EmailButton>
      </EmailHero>
      <EmailSection>
        <EmailLinkFallback label="Button not working? Paste this link into your browser:" href={url} />
        <EmailText>You will join as a member. An admin assigns teams separately.</EmailText>
        {expiresAt && <EmailText>Expires {new Date(expiresAt).toUTCString()}.</EmailText>}
        <EmailText variant="muted">If you weren't expecting this invitation, you can ignore this email.</EmailText>
      </EmailSection>
    </EmailShell>
  );
}
