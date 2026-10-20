import { EmailButton } from '../components/ui/email-button.tsx';
import { EmailChecklist } from '../components/ui/email-checklist.tsx';
import { EmailHero } from '../components/ui/email-hero.tsx';
import { EmailSection } from '../components/ui/email-section.tsx';
import { EmailShell } from '../components/ui/email-shell.tsx';
import { EmailText } from '../components/ui/email-text.tsx';

export interface TestEmailProps {
  sentAt: string;
  appUrl?: string | undefined;
}

export function TestEmail({ sentAt, appUrl }: TestEmailProps) {
  return (
    <EmailShell preview="TulipFarm can send email. Sender, domain, and templates all check out." appUrl={appUrl}>
      <EmailHero
        eyebrow="Delivery check"
        title="Email is working"
        description="This message reached you from TulipFarm through your configured email provider."
      >
        {appUrl ? <EmailButton href={appUrl}>Open TulipFarm</EmailButton> : null}
      </EmailHero>
      <EmailSection>
        <EmailChecklist
          items={[
            { label: 'Sender', detail: 'Your configured sender address accepted the message.' },
            { label: 'Domain', detail: 'Your sending domain passed delivery to your inbox.' },
            { label: 'Templates', detail: 'HTML and plain-text versions rendered from React Email.' },
          ]}
        />
        <EmailText variant="muted">Sent {sentAt}.</EmailText>
      </EmailSection>
    </EmailShell>
  );
}
