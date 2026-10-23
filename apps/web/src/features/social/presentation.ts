import type {
  BlockedReason,
  DecisionReviewChoice,
  Platform,
  PlatformContent,
  Post,
  Revision,
  TikTokReviewChoices,
  VariantState,
} from '@tulipfarm/social/contracts';
import { tiktokReviewChoicesSchema } from '@tulipfarm/social/contracts';
import type { BadgeVariant } from '@tulipfarm/sprout/badge';

type SourceDependency = Revision['sources']['dependencies'][number];

export const platformNames: Record<Platform, string> = {
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  pinterest: 'Pinterest',
  tiktok: 'TikTok',
  x: 'X',
  reddit: 'Reddit',
};

export const variantStates: Record<VariantState, { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  'awaiting-approval': { label: 'Awaiting approval', variant: 'warning' },
  scheduled: { label: 'Scheduled', variant: 'info' },
  sending: { label: 'Sending', variant: 'info' },
  processing: { label: 'Processing', variant: 'info' },
  blocked: { label: 'Blocked', variant: 'warning' },
  'outcome-unknown': { label: 'Outcome unknown', variant: 'warning' },
  published: { label: 'Published', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  'not-published': { label: 'Not published', variant: 'secondary' },
  superseded: { label: 'Replaced by a newer revision', variant: 'secondary' },
  cancelled: { label: 'Cancelled', variant: 'secondary' },
};

/** What blocked a variant (PRODUCT 25). */
export const blockedReasons: Record<BlockedReason, string> = {
  'origin-revoked': 'The chat, task or workflow that prepared this post is no longer available.',
  'sponsor-removed': 'The person it publishes on behalf of is no longer a member.',
  'grant-removed': 'The publish grant on this channel was removed.',
  'account-reconnect': 'The connected account needs reconnecting.',
  'channel-changed': 'The channel changed after approval.',
  'source-lost': 'Someone lost access to a source of this post.',
  'media-changed': 'A media file changed after approval.',
  'media-unreadable': 'A media file can no longer be read.',
  'review-choices-changed': 'The platform no longer offers a choice made at approval.',
  'target-rules-changed': 'The board or community rules changed after approval.',
  'daily-cap': 'The platform’s daily limit was reached. It is checked again automatically.',
  'rate-limited': 'The platform asked to slow down. It is checked again automatically.',
};

const fieldLabels: Record<string, string> = {
  title: 'Title',
  text: 'Text',
  caption: 'Caption',
  description: 'Description',
  body: 'Body',
  link: 'Link',
  visibility: 'Visibility',
  privacy: 'Privacy',
  madeForKids: 'Made for kids',
  tags: 'Tags',
  categoryId: 'Category',
  format: 'Format',
  shareReelToFeed: 'Share reel to feed',
  collaborators: 'Collaborators',
  replyControl: 'Who can reply',
  replySettings: 'Who can reply',
  altText: 'Alt text',
  kind: 'Post type',
  nsfw: 'NSFW',
  spoiler: 'Spoiler',
};
const textFields = new Set(['title', 'text', 'caption', 'description', 'body']);

export type PreviewField = { name: string; label: string; value: string; text: boolean };

/**
 * Every field a variant publishes, unchanged and in the platform's own order (PRODUCT 38). Empty text stays
 * visible, so a person sees exactly what goes out.
 */
export function variantFields(content: PlatformContent): PreviewField[] {
  return Object.entries(content).flatMap(([name, value]) => {
    if (name === 'platform' || name === 'media' || value === undefined) return [];
    const shown = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : Array.isArray(value) ? value.join(', ') : value;
    return [{ name, label: fieldLabels[name] ?? name, value: String(shown), text: textFields.has(name) }];
  });
}

export function currentRevision(post: Post): Revision {
  const revision = post.revisions.find(item => item.number === post.currentRevision);
  if (!revision) throw new Error('current-revision-missing');
  return revision;
}

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'checks-failed';
export function reviewStatus(revision: Revision, now: Date): ReviewStatus {
  if (revision.decision) return revision.decision.decision === 'approve' ? 'approved' : 'rejected';
  if (Date.parse(revision.expiresAt) <= now.getTime()) return 'expired';
  return revision.variants.every(variant => variant.state === 'awaiting-approval') ? 'pending' : 'checks-failed';
}

/** Sources that block approval: content that may not leave the workspace (PRODUCT 20). */
export function blockingSources(revision: Revision) {
  const blocked: string[] = [];
  if (revision.sources.mcpDerived) blocked.push('MCP connection output');
  if (revision.sources.privateTaskDerived) blocked.push('a private task result');
  return blocked;
}

export function sourceLabel(source: SourceDependency): string {
  switch (source.kind) {
    case 'private-conversation':
      return 'This chat';
    case 'tulipfarm-file':
      return 'A file';
    case 'google-file':
    case 'google-integration':
      return 'Google Workspace';
    case 'knowledge-document':
      return 'Knowledge';
    case 'public-web':
      return source.url;
    case 'table':
    case 'table-rows':
    case 'table-schema':
      return 'A table';
    case 'mcp-integration':
      return 'MCP connection output';
    case 'private-task':
      return 'A private task result';
    case 'github-personal':
    case 'github-source':
      return 'GitHub';
    case 'atlassian-source':
      return 'Atlassian';
    case 'personal-memory':
      return 'Personal memory';
    default:
      return 'Other workspace content';
  }
}

/** The TikTok choices a person is making; every field starts unset (PRODUCT 17). */
export type ChoiceDraft = {
  privacy?: TikTokReviewChoices['privacy'];
  allowComments?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  disclosed?: boolean;
  yourBrand?: boolean;
  brandedContent?: boolean;
};

/**
 * A complete, valid choice, or null while a required field is unset or contradicts the creator's options. An
 * interaction the creator turned off can only be off, so it needs no answer.
 */
export function reviewChoice(
  variantId: string,
  draft: ChoiceDraft,
  creatorInfo: TikTokReviewChoices['creatorInfo'],
): DecisionReviewChoice | null {
  const disclosed = draft.disclosed;
  const parsed = tiktokReviewChoicesSchema.safeParse({
    privacy: draft.privacy,
    allowComments: creatorInfo.commentDisabled ? false : draft.allowComments,
    allowDuet: creatorInfo.duetDisabled ? false : draft.allowDuet,
    allowStitch: creatorInfo.stitchDisabled ? false : draft.allowStitch,
    commercialContent:
      disclosed === undefined
        ? undefined
        : { disclosed, yourBrand: disclosed && !!draft.yourBrand, brandedContent: disclosed && !!draft.brandedContent },
    creatorInfo,
  });
  return parsed.success ? { variantId, values: parsed.data } : null;
}

export const privacyLabels: Record<TikTokReviewChoices['privacy'], string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};

export function formatTime(value: string | null, fallback: string) {
  if (!value) return fallback;
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
