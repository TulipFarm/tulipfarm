import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { NoticeBanner } from '@tulipfarm/sprout/notice-banner';
import { useOwnMembership } from '@/features/governance/queries';
import { creditLevel, useCreditBalance } from '@/lib/credit-balance';

const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL;
const amount = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
const plural = (value: number) => `${amount(value)} ${value === 1 ? 'credit' : 'credits'}`;

/** Tells every member when the workspace's credits run low, run on grace, or run out. Hidden when credits are unlimited. */
export function CreditsBanner({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const balance = useCreditBalance(workspaceId);
  const membership = useOwnMembership(workspaceId);
  if (balance.state.kind !== 'ready') return null;
  const data = balance.state.data;
  const level = creditLevel(data);
  if (level === 'unlimited' || level === 'ok' || data.available === null) return null;
  const admin = membership.state.kind === 'ready' && membership.state.data.role === 'admin';
  const ask = 'Ask a workspace admin to add credits.';
  const add = supportEmail ? 'Contact us to add credits' : 'Add credits';
  const [headline, detail] =
    level === 'low'
      ? [`${plural(data.available)} left.`, admin ? `${add} to keep work running.` : ask]
      : level === 'grace'
        ? [
            'Out of credits.',
            `Work continues on grace credits, ${amount(data.available + (data.grace ?? 0))} left. ${admin ? `${add} before they run out.` : ask}`,
          ]
        : [
            'Work is paused: out of credits.',
            `Model calls, agent runs and sandboxes are paused until credits are added. ${admin ? (supportEmail ? `${add}.` : '') : ask}`.trim(),
          ];
  return (
    <NoticeBanner
      aria-label="Workspace credits"
      compact="sm"
      actions={
        admin && (
          <Button
            variant={level === 'low' ? 'outline' : 'default'}
            size="sm"
            nativeButton={false}
            render={
              supportEmail ? (
                <a href={`mailto:${supportEmail}?subject=${encodeURIComponent(`Add credits: ${slug}`)}`} />
              ) : (
                <Link to="/$workspaceSlug/settings/usage" params={{ workspaceSlug: slug }} />
              )
            }
          >
            {add}
          </Button>
        )
      }
    >
      <p role={level === 'stopped' ? 'alert' : 'status'}>
        <span className={`font-medium ${level === 'low' ? 'text-warning' : 'text-destructive'}`}>{headline}</span>{' '}
        {detail}
      </p>
    </NoticeBanner>
  );
}
