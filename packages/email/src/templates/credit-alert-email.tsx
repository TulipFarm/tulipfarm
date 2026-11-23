import { EmailButton } from '../components/ui/email-button.tsx';
import { EmailHero } from '../components/ui/email-hero.tsx';
import { EmailLinkFallback } from '../components/ui/email-link-fallback.tsx';
import { EmailSection } from '../components/ui/email-section.tsx';
import { EmailShell } from '../components/ui/email-shell.tsx';
import { EmailStrong, EmailText } from '../components/ui/email-text.tsx';

/** `low`: 90% of granted credits used. `grace`: the balance reached zero and grace credits are in use. `stopped`: nothing left. */
export type CreditAlertLevel = 'low' | 'grace' | 'stopped';

export interface CreditAlertEmailProps {
  level: CreditAlertLevel;
  workspaceName: string;
  /** The true balance in credits; below zero while grace credits are in use. */
  available: number;
  /** Credits granted so far, or null when not tracked. */
  granted: number | null;
  /** How far below zero the workspace may spend, in credits, or null without grace. */
  grace: number | null;
  /** Settings → Usage for the workspace. */
  url: string;
  /** Where admins write to add credits; without one the button opens Settings → Usage. */
  supportEmail?: string | null;
}

const amount = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const credits = (value: number) => `${amount(value)} ${value === 1 ? 'credit' : 'credits'}`;

export function creditAlertSubject({ level, workspaceName }: Pick<CreditAlertEmailProps, 'level' | 'workspaceName'>) {
  if (level === 'low') return `${workspaceName} has used 90% of its credits`;
  if (level === 'grace') return `${workspaceName} is out of credits and running on grace`;
  return `Work is paused in ${workspaceName}: out of credits`;
}

export function CreditAlertEmail({
  level,
  workspaceName,
  available,
  granted,
  grace,
  url,
  supportEmail,
}: CreditAlertEmailProps) {
  const add = supportEmail ? 'Contact us to add credits' : 'Add credits';
  const action = supportEmail
    ? `mailto:${supportEmail}?subject=${encodeURIComponent(`Add credits: ${workspaceName}`)}`
    : url;
  const graceLeft = grace === null ? 0 : Math.max(0, Math.min(grace, available + grace));
  const stops = 'model calls, agent runs and sandboxes';
  const hero =
    level === 'low'
      ? {
          eyebrow: 'Credits running low',
          title: `${credits(available)} left`,
          description: `${workspaceName} has used 90% of its credits. Add credits so ${stops} keep running.`,
        }
      : level === 'grace'
        ? {
            eyebrow: 'Running on grace credits',
            title: `${workspaceName} is out of credits`,
            description: `Work continues on grace credits for now. When they run out, ${stops} pause until you add credits.`,
          }
        : {
            eyebrow: 'Work paused',
            title: `${workspaceName} is out of credits`,
            description: 'Model calls, agent runs and sandboxes are paused until you add credits.',
          };
  return (
    <EmailShell preview={creditAlertSubject({ level, workspaceName })} appUrl={new URL(url).origin}>
      <EmailHero eyebrow={hero.eyebrow} title={hero.title} description={hero.description}>
        <EmailButton href={action}>{add}</EmailButton>
      </EmailHero>
      <EmailSection>
        <EmailText>
          Balance: <EmailStrong>{credits(available)}</EmailStrong>
          {granted !== null && <> of {credits(granted)} granted so far</>}.
        </EmailText>
        {grace !== null && (
          <EmailText>
            Grace credits: <EmailStrong>{amount(graceLeft)}</EmailStrong> of {credits(grace)} left. Work stops when they
            run out.
          </EmailText>
        )}
        {level !== 'low' && <EmailText>Storage is still charged each day, so the balance can keep falling.</EmailText>}
        {supportEmail ? (
          <>
            <EmailText>
              To add credits, email <EmailStrong>{supportEmail}</EmailStrong>. See usage in Settings → Usage.
            </EmailText>
            <EmailLinkFallback label="Usage:" href={url} />
          </>
        ) : (
          <>
            <EmailText>See usage and add credits in Settings → Usage.</EmailText>
            <EmailLinkFallback label="Button not working? Paste this link into your browser:" href={url} />
          </>
        )}
        <EmailText variant="muted">
          You get this email because you are an admin of {workspaceName}. We send it once each time the balance crosses
          this level.
        </EmailText>
      </EmailSection>
    </EmailShell>
  );
}
