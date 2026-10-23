import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { CardSend } from 'reicon-react/icons/CardSend';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { ChoiceGroup } from '@tulipfarm/sprout/field';
import { ReviewCard, ReviewRow, ReviewRows, type ReviewCardBadge } from '@tulipfarm/sprout/review-card';
import { Skeleton, SkeletonGroup } from '@tulipfarm/sprout/skeleton';
import type { DecisionReviewChoice, Post, Revision, TikTokReviewChoices, Variant } from '@tulipfarm/social/contracts';
import { Disclosure } from '@/components/disclosure';
import { useKnownFlag } from '@/lib/feature-flags';
import { useFeatureRead } from '@/lib/query';
import { socialApi, socialError, type SocialChannel } from '@/lib/social';
import {
  blockingSources,
  blockedReasons,
  currentRevision,
  formatTime,
  platformNames,
  privacyLabels,
  reviewChoice,
  reviewStatus,
  sourceLabel,
  variantFields,
  variantStates,
  variantTiming,
  type ChoiceDraft,
  type ReviewStatus,
} from './presentation';
import { BlockedVariant, type BlockedVariantActions } from './variant-actions';

type CreatorInfo = TikTokReviewChoices['creatorInfo'];

const badges: Record<ReviewStatus, ReviewCardBadge> = {
  pending: { label: 'Needs approval', variant: 'warning' },
  approved: { label: 'Approved', variant: 'info' },
  rejected: { label: 'Rejected', variant: 'secondary' },
  expired: { label: 'Expired', variant: 'secondary' },
  'checks-failed': { label: 'Needs changes', variant: 'warning' },
  'needs-attention': { label: 'Needs attention', variant: 'warning' },
  published: { label: 'Published', variant: 'success' },
  'partly-published': { label: 'Partly published', variant: 'warning' },
  failed: { label: 'Not published', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'secondary' },
};
const finished = new Set<ReviewStatus>(['rejected', 'expired', 'published', 'partly-published', 'failed', 'cancelled']);
const unsettled = new Set(['scheduled', 'sending', 'processing']);

/** The post a social tool prepared, read under the viewer's own grants; hidden while the flag is off. */
export function SocialPostCard({ workspaceId, slug, postId }: { workspaceId: string; slug: string; postId: string }) {
  // Nothing is requested until the workspace's flag is known to be on.
  const enabled = useKnownFlag('social-publishing', slug) === true;
  const post = useFeatureRead({
    key: ['social', 'post', postId],
    load: signal => socialApi.post(workspaceId, postId, signal),
    enabled,
    pollWhile: data => currentRevision(data).variants.some(variant => unsettled.has(variant.state)),
    interval: 5000,
  });
  const channels = useFeatureRead({
    key: ['social', 'channels'],
    load: signal => socialApi.channels(workspaceId, signal),
    enabled,
  });
  // Who may resume or cancel a blocked variant: the schedule lists the channels the viewer can publish to.
  const blocked =
    post.state.kind === 'ready' &&
    currentRevision(post.state.data).variants.some(variant => variant.state === 'blocked');
  const publishable = useFeatureRead({
    key: ['social', 'schedule', 'blocked', postId],
    load: signal => socialApi.schedule(workspaceId, { states: ['blocked'] }, signal),
    enabled: enabled && blocked,
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!enabled) return null;
  const state = post.state;
  if (state.kind === 'loading')
    return (
      <SkeletonGroup label="Loading social post">
        <Skeleton shape="title" />
        <Skeleton shape="panel" />
      </SkeletonGroup>
    );
  if (state.kind === 'unavailable')
    return <p className="text-sm text-muted-foreground">This social post is unavailable to you.</p>;
  if (state.kind === 'error')
    return (
      <Alert variant="destructive">
        <AlertDescription>
          The social post could not be loaded.{' '}
          <Button variant="link" onClick={() => void post.refresh()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  const decide = async (decision: 'approve' | 'reject', choices: DecisionReviewChoice[]) => {
    setSending(true);
    setError(null);
    try {
      await socialApi.decide(workspaceId, state.data, decision, choices);
    } catch (failure) {
      setError(socialError(failure));
    } finally {
      setSending(false);
      await post.refresh();
    }
  };
  const after = (action: (workspaceId: string, variantId: string) => Promise<Variant>) => async (variantId: string) => {
    try {
      return await action(workspaceId, variantId);
    } finally {
      await Promise.all([post.refresh(), publishable.refresh()]);
    }
  };
  return (
    <SocialPostReview
      post={state.data}
      channels={channels.state.kind === 'ready' ? channels.state.data : []}
      slug={slug}
      now={new Date()}
      sending={sending}
      error={error ?? state.error}
      onDecide={decide}
      publishable={
        publishable.state.kind === 'ready'
          ? new Set(publishable.state.data.channels.filter(item => item.canPublish).map(item => item.channelId))
          : publishable.state.kind === 'unavailable'
            ? new Set()
            : undefined
      }
      variantActions={{ resume: after(socialApi.resume), cancel: after(socialApi.cancel) }}
    />
  );
}

/**
 * The review card: every variant exactly as it will publish, its sources and the choices only a person may make,
 * approved or rejected together as one revision (PRODUCT 15, 17, 38). The decision names the revision and its
 * content digest, so a changed post is never approved by an older card.
 */
export function SocialPostReview({
  post,
  channels,
  slug,
  now,
  sending,
  error,
  onDecide,
  creatorInfo = {},
  publishable,
  variantActions,
}: {
  post: Post;
  channels: readonly SocialChannel[];
  slug: string;
  now: Date;
  sending: boolean;
  error: string | null;
  onDecide: (decision: 'approve' | 'reject', choices: DecisionReviewChoice[]) => void;
  /** The creator's current TikTok options by variant, when a platform read supplied them. */
  creatorInfo?: Readonly<Record<string, CreatorInfo>>;
  /** Channels the viewer may publish to, once known, so a blocked variant offers resume and cancel there. */
  publishable?: ReadonlySet<string> | undefined;
  variantActions?: BlockedVariantActions | undefined;
}) {
  const revision = currentRevision(post);
  const status = reviewStatus(revision, now);
  const [drafts, setDrafts] = useState<Record<string, ChoiceDraft>>({});
  const required = revision.reviewChoices.filter(entry => entry.required.length > 0);
  const choices = required.map(entry => {
    const info = creatorInfo[entry.variantId];
    return info ? reviewChoice(entry.variantId, drafts[entry.variantId] ?? {}, info) : null;
  });
  const complete = choices.every(choice => choice !== null);
  const blocked = blockingSources(revision);
  const pending = status === 'pending';
  const channelName = (variant: Variant) =>
    channels.find(channel => channel.id === variant.channelId)?.displayName ?? platformNames[variant.content.platform];
  return (
    <ReviewCard
      label="Review social post"
      icon={<CardSend size={16} />}
      title={`Publish to ${revision.variants.length} ${revision.variants.length === 1 ? 'channel' : 'channels'}`}
      badge={badges[status]}
      settled={finished.has(status)}
      actions={
        pending ? (
          <>
            <Button
              disabled={sending || blocked.length > 0 || !complete}
              aria-busy={sending}
              onClick={() =>
                onDecide(
                  'approve',
                  choices.filter(choice => choice !== null),
                )
              }
            >
              Approve and publish
            </Button>
            <Button variant="ghost" disabled={sending} onClick={() => onDecide('reject', [])}>
              Reject
            </Button>
          </>
        ) : undefined
      }
      status={
        <div className="space-y-2 text-sm" role="status">
          {status === 'pending' && (
            <p>
              Nothing is published until you approve. Approval covers every variant below, exactly as shown, and
              publishes on your behalf.
            </p>
          )}
          {status === 'approved' && <p>Approved. Each variant publishes, or fails, on its own.</p>}
          {status === 'needs-attention' && <p>A variant could not publish. The reason is on the variant.</p>}
          {status === 'published' && <p>Published to every channel.</p>}
          {status === 'partly-published' && <p>Some variants were published. See each one below.</p>}
          {status === 'failed' && <p>Not published. See each variant below.</p>}
          {status === 'cancelled' && <p>Cancelled. Nothing was published.</p>}
          {revision.variants.map(
            variant =>
              variant.permalink && (
                <p key={variant.id}>
                  <a className="underline" href={variant.permalink} target="_blank" rel="noreferrer noopener">
                    View the post on {channelName(variant)}
                  </a>
                </p>
              ),
          )}
          {status === 'rejected' && <p>Rejected. Nothing was published.</p>}
          {status === 'expired' && <p>This review expired. Nothing was published. Ask chat to prepare it again.</p>}
          {status === 'checks-failed' && (
            <p>A variant does not pass its channel’s checks. Ask chat to revise the post.</p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!pending && (
            <Button
              variant="link"
              nativeButton={false}
              render={<Link to="/$workspaceSlug/social/schedule" params={{ workspaceSlug: slug }} />}
            >
              Open the schedule
            </Button>
          )}
        </div>
      }
    >
      {revision.variants.map(variant => (
        <VariantPreview
          key={variant.id}
          variant={variant}
          channel={channelName(variant)}
          slug={slug}
          now={now}
          blocked={
            variantActions && publishable
              ? { canPublish: publishable.has(variant.channelId), actions: variantActions }
              : undefined
          }
        />
      ))}
      <Sources revision={revision} blocked={blocked} />
      {required.map(entry => (
        <ReviewChoices
          key={entry.variantId}
          variantId={entry.variantId}
          channel={channelName(revision.variants.find(variant => variant.id === entry.variantId)!)}
          decided={entry.values ?? revision.decision?.reviewChoices?.find(c => c.variantId === entry.variantId)?.values}
          info={creatorInfo[entry.variantId]}
          draft={drafts[entry.variantId] ?? {}}
          disabled={!pending || sending}
          change={draft => setDrafts(current => ({ ...current, [entry.variantId]: draft }))}
        />
      ))}
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          <Detail term="Post ID">{post.id}</Detail>
          <Detail term="Revision">{revision.number}</Detail>
          <Detail term="Content SHA-256">{revision.contentDigest}</Detail>
          <Detail term="Review expires">{formatTime(revision.expiresAt, '')}</Detail>
        </dl>
      </Disclosure>
    </ReviewCard>
  );
}

function VariantPreview({
  variant,
  channel,
  slug,
  now,
  blocked,
}: {
  variant: Variant;
  channel: string;
  slug: string;
  now: Date;
  blocked: { canPublish: boolean; actions: BlockedVariantActions } | undefined;
}) {
  const state = variantStates[variant.state];
  const timing = variantTiming(variant, now);
  const { content } = variant;
  return (
    <section aria-label={`${channel} variant`} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {channel} <span className="text-muted-foreground">· {platformNames[content.platform]}</span>
        </h3>
        <Badge variant={state.variant}>{state.label}</Badge>
      </div>
      <ReviewRows>
        <ReviewRow label={timing.label}>{timing.value}</ReviewRow>
        {variant.target && (
          <ReviewRow label={variant.target.kind === 'board' ? 'Board' : 'Community'}>
            {variant.target.kind === 'board' ? variant.target.boardId : `r/${variant.target.name}`}
          </ReviewRow>
        )}
        {variantFields(content).map(field => (
          <ReviewRow key={field.name} label={field.label}>
            <span className={field.text ? 'whitespace-pre-wrap break-words text-left' : 'break-words'}>
              {field.value}
            </span>
          </ReviewRow>
        ))}
        {content.media.map((item, index) => (
          <ReviewRow key={`${item.fileId}:${index}`} label={item.role === 'primary' ? `Media ${index + 1}` : item.role}>
            <span className="grid justify-items-end gap-0.5">
              <Link to="/$workspaceSlug/files/$fileId" params={{ workspaceSlug: slug, fileId: item.fileId }}>
                Open file
              </Link>
              {item.altText && <span className="text-xs text-muted-foreground">Alt text: {item.altText}</span>}
            </span>
          </ReviewRow>
        ))}
      </ReviewRows>
      {variant.blockedReason && <p className="text-sm">{blockedReasons[variant.blockedReason]}</p>}
      {variant.permalink && (
        <a className="text-sm underline" href={variant.permalink} target="_blank" rel="noreferrer noopener">
          View the published post
        </a>
      )}
      {blocked && (
        <BlockedVariant variant={variant} channel={channel} canPublish={blocked.canPublish} actions={blocked.actions} />
      )}
    </section>
  );
}

function Sources({ revision, blocked }: { revision: Revision; blocked: string[] }) {
  const labels = [...new Set(revision.sources.dependencies.map(sourceLabel))];
  return (
    <section aria-label="Sources" className="space-y-1 text-sm">
      <h3 className="font-medium">Sources</h3>
      {labels.length ? (
        <ul className="list-disc pl-5 text-muted-foreground">
          {labels.map(label => (
            <li key={label} className="break-all">
              {label}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No recorded sources.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Publishing discloses this content outside the workspace. You can approve only if you can read every source.
      </p>
      {blocked.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            This post uses {blocked.join(' and ')}, which may not leave the workspace. It cannot be approved.
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}

/** TikTok's required choices: none preselected, offered only from the creator's current options (PRODUCT 17). */
function ReviewChoices({
  variantId,
  channel,
  decided,
  info,
  draft,
  disabled,
  change,
}: {
  variantId: string;
  channel: string;
  decided: TikTokReviewChoices | undefined;
  info: CreatorInfo | undefined;
  draft: ChoiceDraft;
  disabled: boolean;
  change: (draft: ChoiceDraft) => void;
}) {
  const heading = <h3 className="font-medium">Choices for {channel}</h3>;
  if (decided)
    return (
      <section aria-label={`Choices for ${channel}`} className="space-y-1 text-sm">
        {heading}
        <ReviewRows>
          <ReviewRow label="Who can view">{privacyLabels[decided.privacy]}</ReviewRow>
          <ReviewRow label="Comments">{decided.allowComments ? 'Allowed' : 'Off'}</ReviewRow>
          <ReviewRow label="Duet">{decided.allowDuet ? 'Allowed' : 'Off'}</ReviewRow>
          <ReviewRow label="Stitch">{decided.allowStitch ? 'Allowed' : 'Off'}</ReviewRow>
          <ReviewRow label="Commercial content">{decided.commercialContent.disclosed ? 'Disclosed' : 'None'}</ReviewRow>
        </ReviewRows>
      </section>
    );
  if (!info)
    return (
      <section aria-label={`Choices for ${channel}`} className="space-y-1 text-sm">
        {heading}
        <Alert>
          <AlertDescription>
            {channel} needs choices only you can make, from the creator’s current options. Those options cannot be read
            yet, so this post cannot be approved.
          </AlertDescription>
        </Alert>
      </section>
    );
  // A yes-or-no choice with neither answer preselected; an option the creator turned off can only be off.
  const choice = (field: Exclude<keyof ChoiceDraft, 'privacy'>, legend: string, off = false) => (
    <ChoiceGroup<'yes' | 'no' | ''>
      type="radio"
      required
      legend={legend}
      helper={off ? 'Turned off by the creator' : undefined}
      layout="columns"
      options={[
        { value: 'yes', label: 'Yes', disabled: off },
        { value: 'no', label: 'No' },
      ]}
      value={off ? 'no' : draft[field] === undefined ? '' : draft[field] ? 'yes' : 'no'}
      disabled={disabled || off}
      onValueChange={value => value && change({ ...draft, [field]: value === 'yes' })}
    />
  );
  return (
    <fieldset aria-label={`Choices for ${channel}`} className="space-y-3 text-sm" data-variant={variantId}>
      {heading}
      <p className="text-xs text-muted-foreground">Posting as {info.nickname}. Nothing is preselected.</p>
      <ChoiceGroup<TikTokReviewChoices['privacy'] | ''>
        type="radio"
        required
        legend="Who can view"
        options={info.privacyLevelOptions.map(option => ({ value: option, label: privacyLabels[option] }))}
        value={draft.privacy ?? ''}
        disabled={disabled}
        onValueChange={privacy => privacy && change({ ...draft, privacy })}
      />
      {choice('allowComments', 'Allow comments', info.commentDisabled)}
      {choice('allowDuet', 'Allow Duet', info.duetDisabled)}
      {choice('allowStitch', 'Allow Stitch', info.stitchDisabled)}
      {choice('disclosed', 'Promotes a brand, product or service')}
      {draft.disclosed && (
        <div className="space-y-1 pl-6">
          {choice('yourBrand', 'Your brand')}
          {choice('brandedContent', 'Branded content for a third party')}
        </div>
      )}
    </fieldset>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="font-medium text-foreground">{term}</dt>
      <dd className="break-all font-mono">{children}</dd>
    </div>
  );
}
