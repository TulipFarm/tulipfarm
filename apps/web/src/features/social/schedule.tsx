import { useState } from 'react';
import { CardSend } from 'reicon-react/icons/CardSend';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { Receipt, Variant } from '@tulipfarm/social/contracts';
import { Disclosure } from '@/components/disclosure';
import { socialError, type SocialCandidates, type SocialSchedule, type SocialSettlement } from '@/lib/social';
import { blockedReasons, formatTime, platformNames, variantFields, variantStates, variantTiming } from './presentation';
import { BlockedVariant, type BlockedVariantActions } from './variant-actions';

export type ScheduleActions = BlockedVariantActions & {
  candidates: (variantId: string) => Promise<SocialCandidates>;
  settle: (variantId: string, settlement: SocialSettlement) => Promise<unknown>;
};

const receiptStatus: Record<Receipt['status'], string> = {
  executing: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  'outcome-unknown': 'Outcome unknown',
};

/**
 * Variants by channel with their state, why a blocked one waits, receipts, and the actions a person may take:
 * resume or cancel a blocked variant, and confirm what became of an unknown outcome (PRODUCT 24, 25, 26, 39).
 */
export function SocialScheduleView({ schedule, actions }: { schedule: SocialSchedule; actions: ScheduleActions }) {
  const channels = schedule.channels.filter(channel => channel.variants.length > 0);
  if (!channels.length)
    return (
      <StatePanel
        kind="empty"
        icon={CardSend}
        title="Nothing scheduled or published yet"
        description="This lists channels you can publish to and posts you prepared. Ask chat to prepare a social post."
      />
    );
  return (
    <div className="space-y-6">
      {schedule.truncated && (
        <Alert>
          <AlertDescription>Only the newest variants are shown. Filter by channel to see older ones.</AlertDescription>
        </Alert>
      )}
      {channels.map(channel => {
        const name = channel.displayName ?? `${platformNames[channel.platform]} channel`;
        return (
          <section key={channel.channelId} aria-label={name} className="space-y-2">
            <h2 className="text-base font-medium">
              {name} <span className="text-muted-foreground">· {platformNames[channel.platform]}</span>
            </h2>
            {!channel.canPublish && (
              <p className="text-sm text-muted-foreground">
                You no longer have the publish grant here. Only your own posts are shown.
              </p>
            )}
            <ul className="divide-y rounded-lg border">
              {channel.variants.map(({ variant }) => (
                <li key={variant.id} className="space-y-2 p-3">
                  <ScheduledVariant
                    variant={variant}
                    channel={name}
                    canPublish={channel.canPublish}
                    actions={actions}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function summary(variant: Variant) {
  const text = variantFields(variant.content).find(field => field.text && field.value.trim());
  const media = variant.content.media.length;
  const value = text?.value ?? (media ? `${media} media ${media === 1 ? 'file' : 'files'}` : 'No text');
  return value.length > 160 ? `${value.slice(0, 159)}…` : value;
}

function ScheduledVariant({
  variant,
  channel,
  canPublish,
  actions,
}: {
  variant: Variant;
  channel: string;
  canPublish: boolean;
  actions: ScheduleActions;
}) {
  const state = variantStates[variant.state];
  const timing = variantTiming(variant, new Date());
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">{summary(variant)}</p>
        <Badge variant={state.variant}>{state.label}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {timing.label} {timing.value}
      </p>
      {variant.blockedReason && (
        <p className="text-sm">
          {blockedReasons[variant.blockedReason]}
          {variant.recheckAt && ` Next check ${formatTime(variant.recheckAt, '')}.`}
        </p>
      )}
      {variant.permalink && (
        <a className="text-sm underline" href={variant.permalink} target="_blank" rel="noreferrer noopener">
          View the published post
        </a>
      )}
      <BlockedVariant variant={variant} channel={channel} canPublish={canPublish} actions={actions} />
      {variant.state === 'outcome-unknown' &&
        (canPublish ? (
          <UnknownOutcome variant={variant} actions={actions} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Only someone with the publish grant on this channel can confirm what happened. Ask a channel manager.
          </p>
        ))}
      {variant.receipts.length > 0 && (
        <Disclosure title={`Receipts (${variant.receipts.length})`}>
          <ul aria-label="Receipts" className="grid gap-2 text-xs text-muted-foreground">
            {variant.receipts.map(receipt => (
              <li key={receipt.id} className="grid gap-0.5">
                <span className="font-medium text-foreground">
                  {receipt.step} · {receiptStatus[receipt.status]}
                </span>
                <span>
                  Revision {receipt.revision}, started {formatTime(receipt.startedAt, '')}
                  {receipt.settledAt && `, settled ${formatTime(receipt.settledAt, '')}`}
                </span>
                {receipt.platformPostId && <span className="font-mono">Platform post {receipt.platformPostId}</span>}
                {receipt.platformRequestId && (
                  <span className="font-mono">Platform request {receipt.platformRequestId}</span>
                )}
                {receipt.error && <span className="font-mono">Error {receipt.error.code}</span>}
                <span className="break-all font-mono">Approval {receipt.decisionId}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </>
  );
}

/** An unknown outcome is never retried; a person confirms the platform's candidate or that nothing posted. */
function UnknownOutcome({ variant, actions }: { variant: Variant; actions: ScheduleActions }) {
  const [result, setResult] = useState<SocialCandidates | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(socialError(failure));
    } finally {
      setBusy(false);
    }
  };
  const check = () =>
    run(async () => {
      setResult(await actions.candidates(variant.id));
    });
  const settle = (settlement: SocialSettlement) =>
    run(async () => {
      await actions.settle(variant.id, settlement);
    });
  const found =
    result?.kind === 'found'
      ? [{ platformPostId: result.platformPostId, permalink: null, createdAt: '' }]
      : result?.kind === 'candidates'
        ? result.items
        : [];
  return (
    <div className="space-y-2 text-sm">
      <p>
        The app could not tell whether the platform accepted this post, so it will not try again. Check the platform,
        then confirm what happened.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void check()}>
        {result ? 'Check the platform again' : 'Check the platform'}
      </Button>
      {result?.kind === 'unknown' && <p>The platform did not say. Check the channel directly.</p>}
      {result?.kind === 'absent' && <p>The platform reports that this attempt did not create a post.</p>}
      {result?.kind === 'candidates' && result.items.length === 0 && <p>The platform lists no similar posts.</p>}
      {found.length > 0 && (
        <ul aria-label="Candidate posts" className="space-y-2">
          {found.map(candidate => (
            <li key={candidate.platformPostId} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{candidate.platformPostId}</span>
              {candidate.createdAt && (
                <span className="text-xs text-muted-foreground">{formatTime(candidate.createdAt, '')}</span>
              )}
              {candidate.permalink && (
                <a className="underline" href={candidate.permalink} target="_blank" rel="noreferrer noopener">
                  Open
                </a>
              )}
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void settle({ settlement: 'published', platformPostId: candidate.platformPostId })}
              >
                This is the post
              </Button>
            </li>
          ))}
        </ul>
      )}
      {result && (
        <Button variant="ghost" disabled={busy} onClick={() => void settle({ settlement: 'not-published' })}>
          It was not published
        </Button>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
