import { z } from 'zod';
import { sourceDependencySchema } from '@tulipfarm/access/source-dependencies';
import { channelImageProblems } from '@tulipfarm/media/presets';
import { xTextLimits, xWeightedLength } from './x-text.ts';

export const platforms = [
  'linkedin',
  'youtube',
  'facebook',
  'instagram',
  'threads',
  'pinterest',
  'tiktok',
  'x',
  'reddit',
] as const;
export const platformSchema = z.enum(platforms);
export type Platform = z.infer<typeof platformSchema>;

export const appSourceSchema = z.enum(['workspace', 'hosted', 'operator']);
export type AppSource = z.infer<typeof appSourceSchema>;

export const accessTiersByPlatform = {
  linkedin: ['share', 'community-management'],
  youtube: ['unverified', 'verified'],
  facebook: ['standard', 'advanced'],
  instagram: ['standard', 'advanced'],
  threads: ['standard', 'advanced'],
  pinterest: ['trial', 'standard'],
  tiktok: ['unaudited', 'audited'],
  x: ['paid'],
  reddit: ['paid'],
} as const satisfies Record<Platform, readonly string[]>;
export const accessTierSchema = z.enum([...new Set(Object.values(accessTiersByPlatform).flat())] as [
  (typeof accessTiersByPlatform)[Platform][number],
  ...(typeof accessTiersByPlatform)[Platform][number][],
]);
export type AccessTier = z.infer<typeof accessTierSchema>;
export function isAccessTierFor(platform: Platform, tier: AccessTier): boolean {
  return (accessTiersByPlatform[platform] as readonly string[]).includes(tier);
}

export const capabilitySchema = z.enum(['publish', 'publish-public', 'analytics', 'comments', 'messages']);
export type Capability = z.infer<typeof capabilitySchema>;
const capabilitiesSchema = z
  .array(capabilitySchema)
  .max(capabilitySchema.options.length)
  .refine(values => new Set(values).size === values.length, 'duplicate-capability');

export const ownershipSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('personal') }),
  z.strictObject({ kind: z.literal('business'), owningTeamId: z.uuid() }),
]);
export type Ownership = z.infer<typeof ownershipSchema>;

export const accountStateSchema = z.enum([
  'authorizing',
  'active',
  'refreshing',
  'reconnect-required',
  'disabled',
  'disconnected',
]);
export type AccountState = z.infer<typeof accountStateSchema>;

export const channelKindsByPlatform = {
  linkedin: ['member-profile', 'organization-page'],
  youtube: ['youtube-channel'],
  facebook: ['facebook-page'],
  instagram: ['instagram-business', 'instagram-creator'],
  threads: ['threads-profile'],
  pinterest: ['pinterest-account'],
  tiktok: ['tiktok-account'],
  x: ['x-account'],
  reddit: ['reddit-user'],
} as const satisfies Record<Platform, readonly string[]>;
export const channelKindSchema = z.enum(
  Object.values(channelKindsByPlatform).flat() as [
    (typeof channelKindsByPlatform)[Platform][number],
    ...(typeof channelKindsByPlatform)[Platform][number][],
  ],
);
export type ChannelKind = z.infer<typeof channelKindSchema>;
export function isChannelKindFor(platform: Platform, kind: ChannelKind): boolean {
  return (channelKindsByPlatform[platform] as readonly string[]).includes(kind);
}

/** Platforms whose posts need a target, and its kind. Every other platform takes none. */
export const postTargetKinds = { pinterest: 'board', reddit: 'subreddit' } as const satisfies Partial<
  Record<Platform, string>
>;

const platformId = z.string().min(1).max(256);
const isoDateTime = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive();
const url = z.url().max(2048);

// Platform apps

export const platformAppCreateSchema = z
  .strictObject({
    platform: platformSchema,
    name: z.string().min(1).max(120),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096),
    accessTier: accessTierSchema,
  })
  .refine(value => isAccessTierFor(value.platform, value.accessTier), {
    path: ['accessTier'],
    message: 'access-tier-platform-mismatch',
  });
export type PlatformAppCreate = z.infer<typeof platformAppCreateSchema>;

export const platformAppMetadataSchema = z
  .strictObject({
    id: z.uuid(),
    platform: platformSchema,
    name: z.string().min(1).max(120),
    clientId: z.string().min(1).max(512),
    accessTier: accessTierSchema,
    generation: version,
    createdAt: isoDateTime,
  })
  .refine(value => isAccessTierFor(value.platform, value.accessTier), {
    path: ['accessTier'],
    message: 'access-tier-platform-mismatch',
  });
export type PlatformAppMetadata = z.infer<typeof platformAppMetadataSchema>;

export const platformAvailabilitySchema = z
  .strictObject({
    platform: platformSchema,
    available: z.boolean(),
    reason: z.enum(['workspace-app-required', 'not-configured']).nullable(),
    appSource: appSourceSchema.nullable(),
    accessTier: accessTierSchema.nullable(),
    capabilities: capabilitiesSchema,
  })
  .refine(value => value.available === (value.reason === null), { path: ['reason'], message: 'reason-mismatch' })
  .refine(value => value.accessTier === null || isAccessTierFor(value.platform, value.accessTier), {
    path: ['accessTier'],
    message: 'access-tier-platform-mismatch',
  });
export type PlatformAvailability = z.infer<typeof platformAvailabilitySchema>;

// Social connections

export const socialAccountLimits = { workspace: 100, personal: 20, business: 50 } as const;

export const beginConnectionSchema = z.strictObject({
  platform: platformSchema,
  ownership: ownershipSchema,
  platformAppId: z.uuid().optional(),
});
export const beginConnectionResultSchema = z.strictObject({ authorizationUrl: url, attemptId: z.uuid() });

export const accountIdentitySchema = z.strictObject({
  platformUserId: platformId,
  handle: z.string().min(1).max(256).nullable(),
  displayName: z.string().max(200),
});
export type AccountIdentity = z.infer<typeof accountIdentitySchema>;
const scopeSchema = z.string().min(1).max(256);
export const socialAccountMetadataSchema = z
  .strictObject({
    id: z.uuid(),
    platform: platformSchema,
    ownership: ownershipSchema,
    appSource: appSourceSchema,
    platformAppId: z.uuid().nullable(),
    state: accountStateSchema,
    identity: accountIdentitySchema.nullable(),
    scopes: z.array(scopeSchema).max(64),
    generation: version,
    grantsVersion: version,
    capabilities: z.strictObject({ read: z.boolean(), use: z.boolean(), manage: z.boolean() }),
  })
  .refine(value => (value.appSource === 'workspace') === (value.platformAppId !== null), {
    path: ['platformAppId'],
    message: 'platform-app-source-mismatch',
  });
export type SocialAccountMetadata = z.infer<typeof socialAccountMetadataSchema>;

export const socialAccountGrantsSchema = z.strictObject({
  expectedVersion: version,
  memberIds: z.array(z.uuid()).max(100),
  teamIds: z.array(z.uuid()).max(100),
  managers: z.strictObject({ memberIds: z.array(z.uuid()).max(1000), teamIds: z.array(z.uuid()).max(1000) }).optional(),
});
export type SocialAccountGrants = z.infer<typeof socialAccountGrantsSchema>;

export const disconnectResultSchema = z.strictObject({
  account: socialAccountMetadataSchema,
  providerRevocation: z.enum(['revoked', 'failed', 'manual-required']),
});

// Channels

export const discoveredChannelSchema = z.strictObject({
  platformChannelId: platformId,
  channelKind: channelKindSchema,
  displayName: z.string().max(200),
  handle: z.string().min(1).max(256).nullable(),
  avatarUrl: url.nullable(),
});
export type DiscoveredChannel = z.infer<typeof discoveredChannelSchema>;

export const addChannelSchema = z.strictObject({
  accountId: z.uuid(),
  expectedAccountGeneration: version,
  platformChannelId: platformId,
});

export const principalSetSchema = z.strictObject({
  memberIds: z.array(z.uuid()).max(1000),
  teamIds: z.array(z.uuid()).max(1000),
});
const channelGrantFields = {
  publish: principalSetSchema,
  analytics: principalSetSchema,
  engagement: principalSetSchema,
  manage: principalSetSchema,
};
const hasManager = (grants: { manage: z.infer<typeof principalSetSchema> }) =>
  grants.manage.memberIds.length + grants.manage.teamIds.length > 0;
/** Whether a removed or emptied team leaves an active manager is checked against storage, not here. */
export const channelGrantSetSchema = z
  .strictObject(channelGrantFields)
  .refine(hasManager, { path: ['manage'], message: 'manager-required' });
export const channelGrantsSchema = z
  .strictObject({ expectedVersion: version, ...channelGrantFields })
  .refine(hasManager, { path: ['manage'], message: 'manager-required' });
export type ChannelGrants = z.infer<typeof channelGrantsSchema>;

export const engagementPolicySchema = z.enum(['approve-each', 'automatic-within-authorization']);
export const defaultEngagementPolicy = 'approve-each' satisfies z.infer<typeof engagementPolicySchema>;

export const channelSchema = z
  .strictObject({
    id: z.uuid(),
    accountId: z.uuid(),
    platform: platformSchema,
    channelKind: channelKindSchema,
    platformChannelId: platformId,
    displayName: z.string().max(200),
    accountGeneration: version,
    version,
    enabled: z.boolean(),
    engagementPolicy: engagementPolicySchema,
    grants: channelGrantSetSchema,
  })
  .refine(value => isChannelKindFor(value.platform, value.channelKind), {
    path: ['channelKind'],
    message: 'channel-kind-platform-mismatch',
  });
export type Channel = z.infer<typeof channelSchema>;

// Content

export const mediaItemSchema = z.strictObject({
  fileId: z.uuid(),
  contentDigest: sha256,
  role: z.enum(['primary', 'cover', 'thumbnail']),
  altText: z.string().max(1000).optional(),
});
export type MediaItem = z.infer<typeof mediaItemSchema>;
/** Media kinds come from the bound File, not from the content itself. */
export type MediaKind = 'image' | 'video' | 'gif' | 'document';

export const contentLimits = {
  linkedin: { text: 3000, images: 20 },
  youtube: { title: 100, description: 5000, tags: 500 },
  facebook: { text: 63206, images: 10 },
  instagram: { caption: 2200, hashtags: 30, carousel: 10, collaborators: 3 },
  threads: { text: 500, carousel: 20 },
  pinterest: { title: 100, description: 800, images: 5, altText: 500 },
  tiktok: { caption: 2200, images: 35 },
  x: { text: xTextLimits.standard, premiumText: xTextLimits.premium, images: 4 },
  reddit: { title: 300, body: 40000 },
} as const;

const primary = (media: MediaItem[]) => media.filter(item => item.role === 'primary');
const hashtags = (text: string) => text.match(/(?:^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu)?.length ?? 0;
type Issues = z.core.$RefinementCtx;
function issue(ctx: Issues, path: (string | number)[], message: string) {
  ctx.addIssue({ code: 'custom', path, message });
}
function onlyRoles(ctx: Issues, media: MediaItem[], roles: MediaItem['role'][]) {
  media.forEach((item, index) => {
    if (!roles.includes(item.role)) issue(ctx, ['media', index, 'role'], 'media-role-not-allowed');
  });
}

const linkedinContentSchema = z
  .strictObject({
    platform: z.literal('linkedin'),
    text: z.string().max(contentLimits.linkedin.text),
    media: z.array(mediaItemSchema).max(contentLimits.linkedin.images),
    title: z.string().min(1).max(400).optional(),
    visibility: z.enum(['public', 'connections']),
  })
  .superRefine((value, ctx) => {
    onlyRoles(ctx, value.media, ['primary']);
    if (!value.text.trim() && value.media.length === 0) issue(ctx, ['text'], 'content-empty');
  });

const youtubeContentSchema = z
  .strictObject({
    platform: z.literal('youtube'),
    title: z.string().min(1).max(contentLimits.youtube.title),
    description: z.string().max(contentLimits.youtube.description),
    media: z.array(mediaItemSchema).min(1).max(2),
    privacy: z.enum(['public', 'unlisted', 'private']),
    madeForKids: z.boolean(),
    tags: z.array(z.string().min(1).max(contentLimits.youtube.tags)).optional(),
    categoryId: platformId.optional(),
  })
  .superRefine((value, ctx) => {
    onlyRoles(ctx, value.media, ['primary', 'thumbnail']);
    if (primary(value.media).length !== 1) issue(ctx, ['media'], 'video-required');
    if (value.media.filter(item => item.role === 'thumbnail').length > 1) issue(ctx, ['media'], 'one-thumbnail');
    if ((value.tags ?? []).reduce((total, tag) => total + tag.length, 0) > contentLimits.youtube.tags)
      issue(ctx, ['tags'], 'tags-too-long');
  });

const facebookContentSchema = z
  .strictObject({
    platform: z.literal('facebook'),
    text: z.string().max(contentLimits.facebook.text),
    media: z.array(mediaItemSchema).max(contentLimits.facebook.images),
    format: z.enum(['feed', 'story']),
    link: url.optional(),
  })
  .superRefine((value, ctx) => {
    onlyRoles(ctx, value.media, ['primary']);
    if (value.format === 'story') {
      if (value.media.length !== 1) issue(ctx, ['media'], 'story-needs-one-media');
      if (value.text) issue(ctx, ['text'], 'story-has-no-text');
      if (value.link) issue(ctx, ['link'], 'story-has-no-link');
    } else if (!value.text.trim() && value.media.length === 0) issue(ctx, ['text'], 'content-empty');
  });

const instagramContentSchema = z
  .strictObject({
    platform: z.literal('instagram'),
    caption: z.string().max(contentLimits.instagram.caption),
    media: z.array(mediaItemSchema).min(1).max(contentLimits.instagram.carousel),
    format: z.enum(['feed', 'carousel', 'reel', 'story']),
    shareReelToFeed: z.boolean().optional(),
    collaborators: z.array(z.string().min(1).max(30)).max(contentLimits.instagram.collaborators).optional(),
  })
  .superRefine((value, ctx) => {
    onlyRoles(ctx, value.media, value.format === 'reel' ? ['primary', 'cover'] : ['primary']);
    const items = primary(value.media).length;
    if (value.format === 'carousel' ? items < 2 : items !== 1) issue(ctx, ['media'], 'media-count');
    if (hashtags(value.caption) > contentLimits.instagram.hashtags) issue(ctx, ['caption'], 'too-many-hashtags');
    if (value.shareReelToFeed !== undefined && value.format !== 'reel') issue(ctx, ['shareReelToFeed'], 'reel-only');
    if (value.format === 'story' && value.caption) issue(ctx, ['caption'], 'story-has-no-caption');
  });

const threadsContentSchema = z
  .strictObject({
    platform: z.literal('threads'),
    text: z.string().max(contentLimits.threads.text),
    media: z.array(mediaItemSchema).max(contentLimits.threads.carousel),
    replyControl: z.enum(['everyone', 'accounts-you-follow', 'mentioned-only']),
  })
  .superRefine((value, ctx) => {
    onlyRoles(ctx, value.media, ['primary']);
    if (!value.text.trim() && value.media.length === 0) issue(ctx, ['text'], 'content-empty');
  });

const pinterestContentSchema = z
  .strictObject({
    platform: z.literal('pinterest'),
    title: z.string().max(contentLimits.pinterest.title),
    description: z.string().max(contentLimits.pinterest.description),
    media: z
      .array(mediaItemSchema)
      .min(1)
      .max(contentLimits.pinterest.images + 1),
    link: url.optional(),
    altText: z.string().max(contentLimits.pinterest.altText).optional(),
  })
  .superRefine((value, ctx) => {
    onlyRoles(ctx, value.media, ['primary', 'cover']);
    const items = primary(value.media).length;
    const covers = value.media.length - items;
    if (items < 1 || items > contentLimits.pinterest.images) issue(ctx, ['media'], 'media-count');
    if (covers > 1 || (covers === 1 && items !== 1)) issue(ctx, ['media'], 'cover-needs-one-video');
  });

const tiktokContentSchema = z
  .strictObject({
    platform: z.literal('tiktok'),
    caption: z.string().max(contentLimits.tiktok.caption),
    media: z.array(mediaItemSchema).min(1).max(contentLimits.tiktok.images),
  })
  .superRefine((value, ctx) => onlyRoles(ctx, value.media, ['primary']));

const xContentSchema = z
  .strictObject({
    platform: z.literal('x'),
    text: z.string().refine(text => xWeightedLength(text) <= xTextLimits.premium, 'text-too-long'),
    media: z.array(mediaItemSchema).max(contentLimits.x.images),
    replySettings: z.enum(['everyone', 'following', 'mentioned']),
  })
  .superRefine((value, ctx) => {
    onlyRoles(ctx, value.media, ['primary']);
    if (!value.text.trim() && value.media.length === 0) issue(ctx, ['text'], 'content-empty');
  });

const redditContentSchema = z
  .strictObject({
    platform: z.literal('reddit'),
    title: z.string().min(1).max(contentLimits.reddit.title),
    body: z.string().max(contentLimits.reddit.body).optional(),
    media: z.array(mediaItemSchema).max(1),
    kind: z.enum(['self', 'link', 'image', 'video']),
    link: url.optional(),
    nsfw: z.boolean(),
    spoiler: z.boolean(),
  })
  .superRefine((value, ctx) => {
    onlyRoles(ctx, value.media, ['primary']);
    if ((value.kind === 'link') !== (value.link !== undefined)) issue(ctx, ['link'], 'link-kind-mismatch');
    if ((value.kind === 'image' || value.kind === 'video') !== (value.media.length === 1))
      issue(ctx, ['media'], 'media-kind-mismatch');
  });

export const platformContentSchema = z.discriminatedUnion('platform', [
  linkedinContentSchema,
  youtubeContentSchema,
  facebookContentSchema,
  instagramContentSchema,
  threadsContentSchema,
  pinterestContentSchema,
  tiktokContentSchema,
  xContentSchema,
  redditContentSchema,
]);
export type PlatformContent = z.infer<typeof platformContentSchema>;

export type ContentContext = {
  channelKind: ChannelKind;
  /** The kind of each media item's File, by `fileId`. Items without a known kind are reported. */
  mediaKinds: ReadonlyMap<string, MediaKind>;
  /** Each media item's File type and size, by `fileId`; image Files are held to the platform's image rules. */
  mediaFiles?: ReadonlyMap<string, { mediaType: string; size: number }>;
  /** Whether the X account reported a Premium subscription when its channel was added or refreshed. */
  xPremium?: boolean;
};
export type ContentIssue = { path: (string | number)[]; code: string };

/** The content rules that need the channel or the bound Files, which the schema alone cannot see. */
export function contentIssues(content: PlatformContent, context: ContentContext): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const add = (path: (string | number)[], code: string) => issues.push({ path, code });
  if (!isChannelKindFor(content.platform, context.channelKind)) add(['platform'], 'channel-platform-mismatch');
  const kinds = content.media.map(item => context.mediaKinds.get(item.fileId));
  content.media.forEach((item, index) => {
    if (!context.mediaKinds.has(item.fileId)) add(['media', index], 'media-kind-unknown');
    const file = context.mediaFiles?.get(item.fileId);
    // The rules images.generate checks for a channel (Images PRODUCT 50); Files keep no dimensions, so not the ratio.
    if (file && kinds[index] === 'image')
      for (const code of channelImageProblems(content.platform, file)) add(['media', index], code);
  });
  const primaryKinds = content.media.flatMap((item, index) => (item.role === 'primary' ? [kinds[index]] : []));
  const roleKinds = (role: MediaItem['role']) =>
    content.media.flatMap((item, index) => (item.role === role ? [kinds[index]] : []));
  const all = (expected: MediaKind[]) => primaryKinds.every(kind => kind && expected.includes(kind));
  const single = (expected: MediaKind[]) => primaryKinds.length === 1 && all(expected);
  switch (content.platform) {
    case 'linkedin':
      if (
        !(
          primaryKinds.length === 0 ||
          all(['image']) ||
          (single(['video']) && !content.title) ||
          (single(['document']) && content.title)
        )
      )
        add(['media'], 'media-shape');
      if (content.title && !single(['document'])) add(['title'], 'title-only-for-document');
      if (content.visibility === 'connections' && context.channelKind !== 'member-profile')
        add(['visibility'], 'connections-only-for-member-profile');
      break;
    case 'youtube':
      if (!single(['video'])) add(['media'], 'video-required');
      if (!roleKinds('thumbnail').every(kind => kind === 'image')) add(['media'], 'thumbnail-must-be-image');
      break;
    case 'facebook':
      if (!(primaryKinds.length === 0 || all(['image', 'gif']) || single(['video']))) add(['media'], 'media-shape');
      break;
    case 'instagram':
      if (content.format === 'reel' && !single(['video'])) add(['media'], 'reel-needs-video');
      if (content.format === 'feed' && !single(['image'])) add(['media'], 'feed-needs-image');
      if (content.format === 'carousel' && !all(['image', 'video'])) add(['media'], 'media-shape');
      if (content.format === 'story' && !single(['image', 'video'])) add(['media'], 'media-shape');
      if (!roleKinds('cover').every(kind => kind === 'image')) add(['media'], 'cover-must-be-image');
      break;
    case 'threads':
      if (primaryKinds.length === 1 && !all(['image', 'video'])) add(['media'], 'media-shape');
      if (primaryKinds.length > 1 && !all(['image', 'video'])) add(['media'], 'media-shape');
      break;
    case 'pinterest': {
      const covers = roleKinds('cover');
      if (single(['video'])) {
        if (covers.length !== 1) add(['media'], 'video-needs-cover');
        else if (covers[0] !== 'image') add(['media'], 'cover-must-be-image');
      } else if (!all(['image'])) add(['media'], 'media-shape');
      break;
    }
    case 'tiktok':
      if (!(single(['video']) || all(['image']))) add(['media'], 'media-shape');
      break;
    case 'x': {
      const limit = context.xPremium ? xTextLimits.premium : xTextLimits.standard;
      if (xWeightedLength(content.text) > limit) add(['text'], 'text-too-long');
      if (!(primaryKinds.length === 0 || all(['image']) || single(['video', 'gif']))) add(['media'], 'media-shape');
      break;
    }
    case 'reddit':
      if (content.kind === 'image' && !single(['image', 'gif'])) add(['media'], 'media-kind-mismatch');
      if (content.kind === 'video' && !single(['video'])) add(['media'], 'media-kind-mismatch');
      break;
  }
  return issues;
}

// Posts, revisions and variants

export const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('board'), boardId: platformId, sectionId: platformId.optional() }),
  z.strictObject({ kind: z.literal('subreddit'), name: z.string().min(3).max(21), flairId: platformId.optional() }),
]);
export type Target = z.infer<typeof targetSchema>;

/** The target rule for a platform: Pinterest needs a board, Reddit a subreddit, and others none. */
export function targetIssue(platform: Platform, target: Target | null | undefined): string | null {
  const expected = (postTargetKinds as Partial<Record<Platform, Target['kind']>>)[platform];
  if (!expected) return target ? 'target-not-allowed' : null;
  if (!target) return 'target-required';
  return target.kind === expected ? null : 'target-kind-mismatch';
}

export const originSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversation'), conversationId: z.uuid(), messageId: z.uuid() }),
  z.strictObject({ kind: z.literal('task'), taskId: z.uuid(), generation: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('workflow-run'), runId: z.uuid(), stepId: z.string().min(1).max(64) }),
]);
export type Origin = z.infer<typeof originSchema>;

export const publishAtBounds = { minimumMs: 2 * 60 * 1000, maximumMs: 180 * 24 * 60 * 60 * 1000 } as const;
export function publishAtIssue(publishAt: string | null, now: Date): string | null {
  if (publishAt === null) return null;
  const offset = Date.parse(publishAt) - now.getTime();
  if (offset < publishAtBounds.minimumMs) return 'publish-at-too-soon';
  if (offset > publishAtBounds.maximumMs) return 'publish-at-too-late';
  return null;
}

export const variantInputSchema = z
  .strictObject({
    channelId: z.uuid(),
    expectedChannelVersion: version,
    target: targetSchema.optional(),
    content: platformContentSchema,
    publishAt: isoDateTime.nullable(),
  })
  .superRefine((value, ctx) => {
    const problem = targetIssue(value.content.platform, value.target);
    if (problem) issue(ctx, ['target'], problem);
  });
export type VariantInput = z.infer<typeof variantInputSchema>;

const variantsSchema = z
  .array(variantInputSchema)
  .min(1)
  .max(10)
  .refine(variants => new Set(variants.map(variant => variant.channelId)).size === variants.length, {
    message: 'duplicate-channel',
  });

const prepareFields = { commandId: z.uuid(), origin: originSchema, variants: variantsSchema };
function checkPublishAt(now: Date) {
  return (value: { variants: VariantInput[] }, ctx: z.RefinementCtx) => {
    value.variants.forEach((variant, index) => {
      const problem = publishAtIssue(variant.publishAt, now);
      if (problem) issue(ctx, ['variants', index, 'publishAt'], problem);
    });
  };
}
/** Prepare input with `publishAt` checked against `now`. */
export function prepareInputSchema(now: Date) {
  return z.strictObject(prepareFields).superRefine(checkPublishAt(now));
}
export type PrepareInput = z.infer<ReturnType<typeof prepareInputSchema>>;
/** The prepare request's shape; the service checks `publishAt` against the time it runs. */
export const prepareBodySchema = z.strictObject(prepareFields);

const reviseFields = { expectedRevision: version, variants: variantsSchema };
/**
 * Editing a post: replacement content for some of the current revision's unattempted variants. Variants left
 * out are copied unchanged into the new revision (PRODUCT 16).
 */
export function reviseInputSchema(now: Date) {
  return z.strictObject(reviseFields).superRefine(checkPublishAt(now));
}
export const reviseBodySchema = z.strictObject(reviseFields);

export const sourcesSchema = z.strictObject({
  dependencies: z.array(sourceDependencySchema).max(256),
  mcpDerived: z.boolean(),
  privateTaskDerived: z.boolean(),
});

export const privacyLevelSchema = z.enum([
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
]);
export const reviewChoiceFieldSchema = z.enum([
  'privacy',
  'allowComments',
  'allowDuet',
  'allowStitch',
  'commercialContent',
]);
export type ReviewChoiceField = z.infer<typeof reviewChoiceFieldSchema>;

export const tiktokCreatorInfoSchema = z.strictObject({
  nickname: z.string().max(256),
  maxVideoPostDurationSec: z.number().int().positive(),
  privacyLevelOptions: z.array(privacyLevelSchema).min(1).max(privacyLevelSchema.options.length),
  commentDisabled: z.boolean(),
  duetDisabled: z.boolean(),
  stitchDisabled: z.boolean(),
});

/** Set only by a person on the review card. No field has a default. */
export const tiktokReviewChoicesSchema = z
  .strictObject({
    privacy: privacyLevelSchema,
    allowComments: z.boolean(),
    allowDuet: z.boolean(),
    allowStitch: z.boolean(),
    commercialContent: z.strictObject({
      disclosed: z.boolean(),
      yourBrand: z.boolean(),
      brandedContent: z.boolean(),
    }),
    creatorInfo: tiktokCreatorInfoSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.creatorInfo.privacyLevelOptions.includes(value.privacy)) issue(ctx, ['privacy'], 'privacy-not-offered');
    if (value.creatorInfo.commentDisabled && value.allowComments) issue(ctx, ['allowComments'], 'option-disabled');
    if (value.creatorInfo.duetDisabled && value.allowDuet) issue(ctx, ['allowDuet'], 'option-disabled');
    if (value.creatorInfo.stitchDisabled && value.allowStitch) issue(ctx, ['allowStitch'], 'option-disabled');
    const commercial = value.commercialContent;
    if (commercial.disclosed && !commercial.yourBrand && !commercial.brandedContent)
      issue(ctx, ['commercialContent'], 'disclosure-needs-a-kind');
    if (commercial.brandedContent && value.privacy === 'SELF_ONLY')
      issue(ctx, ['commercialContent', 'brandedContent'], 'branded-content-not-private');
  });
export type TikTokReviewChoices = z.infer<typeof tiktokReviewChoicesSchema>;

/** Review choices that also depend on the app's access tier. */
export function tiktokReviewChoiceIssues(choices: TikTokReviewChoices, tier: AccessTier): string[] {
  return choices.privacy !== 'SELF_ONLY' && tier !== 'audited' ? ['audited-app-required'] : [];
}

export const reviewChoiceEntrySchema = z
  .strictObject({
    variantId: z.uuid(),
    platform: platformSchema,
    required: z.array(reviewChoiceFieldSchema).max(reviewChoiceFieldSchema.options.length),
    values: tiktokReviewChoicesSchema.nullable(),
  })
  .refine(value => value.platform === 'tiktok' || (value.required.length === 0 && value.values === null), {
    message: 'review-choices-tiktok-only',
  });

export const decisionReviewChoiceSchema = z.strictObject({ variantId: z.uuid(), values: tiktokReviewChoicesSchema });
export type DecisionReviewChoice = z.infer<typeof decisionReviewChoiceSchema>;

export const decisionSubmitSchema = z
  .strictObject({
    postId: z.uuid(),
    expectedRevision: version,
    contentDigest: sha256,
    decision: z.enum(['approve', 'reject']),
    reviewChoices: z.array(decisionReviewChoiceSchema).max(10).optional(),
  })
  .refine(value => value.decision === 'approve' || value.reviewChoices === undefined, {
    path: ['reviewChoices'],
    message: 'reject-has-no-review-choices',
  });

export const decisionSchema = z.strictObject({
  id: z.uuid(),
  postId: z.uuid(),
  revision: version,
  batchDigest: sha256,
  decision: z.enum(['approve', 'reject']),
  reviewChoices: z.array(decisionReviewChoiceSchema).max(10).optional(),
  deciderMembershipId: z.uuid(),
  decidedAt: isoDateTime,
});
export type Decision = z.infer<typeof decisionSchema>;

export const variantStateSchema = z.enum([
  'draft',
  'awaiting-approval',
  'scheduled',
  'sending',
  'processing',
  'blocked',
  'outcome-unknown',
  'published',
  'failed',
  'not-published',
  'superseded',
  'cancelled',
]);
export type VariantState = z.infer<typeof variantStateSchema>;

export const blockedReasonSchema = z.enum([
  'origin-revoked',
  'sponsor-removed',
  'grant-removed',
  'account-reconnect',
  'channel-changed',
  'source-lost',
  'media-changed',
  'media-unreadable',
  'review-choices-changed',
  'target-rules-changed',
  'daily-cap',
  'rate-limited',
]);
export type BlockedReason = z.infer<typeof blockedReasonSchema>;
export const temporaryBlockedReasons: ReadonlySet<BlockedReason> = new Set(['daily-cap', 'rate-limited']);

export const stepKindSchema = z.enum([
  'upload-media',
  'create-container',
  'publish-container',
  'create-post',
  'upload-video',
  'init-post',
]);
export type StepKind = z.infer<typeof stepKindSchema>;

export const mutateStepSchema = z.strictObject({ kind: stepKindSchema, mode: z.literal('mutate') });
export const awaitStepSchema = z.strictObject({
  kind: z.literal('await'),
  for: z.enum(['container-ready', 'video-processed', 'publish-status']),
  maxSeconds: z.number().int().positive(),
});
export const stepSchema = z.union([mutateStepSchema, awaitStepSchema]);
/** A variant's position in its adapter's plan. */
export const variantStepSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  kind: z.union([stepKindSchema, z.literal('await')]),
});
export type VariantStep = z.infer<typeof variantStepSchema>;

export const platformRefsSchema = z
  .record(z.string().min(1).max(64), z.string().min(1).max(2048))
  .refine(value => Object.keys(value).length <= 16, 'too-many-platform-refs');
export type PlatformRefs = z.infer<typeof platformRefsSchema>;

export const errorClassSchema = z.enum(['retry', 'rate-limited', 'rejected', 'reconnect', 'unknown']);
export type ErrorClass = z.infer<typeof errorClassSchema>;

export const receiptStatusSchema = z.enum(['executing', 'succeeded', 'failed', 'outcome-unknown']);
const receiptErrorSchema = z.strictObject({ class: errorClassSchema, code: z.string().min(1).max(200) });
export const receiptSchema = z
  .strictObject({
    id: z.uuid(),
    variantId: z.uuid(),
    revision: version,
    decisionId: z.uuid(),
    step: stepKindSchema,
    attemptId: z.uuid(),
    status: receiptStatusSchema,
    startedAt: isoDateTime,
    settledAt: isoDateTime.nullable(),
    platformRefs: platformRefsSchema,
    platformPostId: platformId.nullable(),
    platformRequestId: z.string().min(1).max(256).nullable(),
    error: receiptErrorSchema.nullable(),
  })
  .refine(value => (value.status === 'executing') === (value.settledAt === null), {
    path: ['settledAt'],
    message: 'settled-at-mismatch',
  })
  .refine(value => value.error === null || value.status === 'failed' || value.status === 'outcome-unknown', {
    path: ['error'],
    message: 'error-only-when-unsuccessful',
  });
export type Receipt = z.infer<typeof receiptSchema>;

export const variantSchema = z
  .strictObject({
    id: z.uuid(),
    postId: z.uuid(),
    revision: version,
    channelId: z.uuid(),
    channelVersion: version,
    target: targetSchema.nullable(),
    content: platformContentSchema,
    publishAt: isoDateTime.nullable(),
    dueAt: isoDateTime.nullable(),
    state: variantStateSchema,
    step: variantStepSchema.nullable(),
    blockedReason: blockedReasonSchema.nullable(),
    recheckAt: isoDateTime.nullable(),
    platformRefs: platformRefsSchema,
    platformPostId: platformId.nullable(),
    permalink: url.nullable(),
    receipts: z.array(receiptSchema).max(64),
  })
  .superRefine((value, ctx) => {
    if ((value.state === 'blocked') !== (value.blockedReason !== null)) issue(ctx, ['blockedReason'], 'blocked-reason');
    const temporary = value.blockedReason !== null && temporaryBlockedReasons.has(value.blockedReason);
    if (temporary !== (value.recheckAt !== null)) issue(ctx, ['recheckAt'], 'recheck-only-when-temporary');
    if (value.state === 'published' && value.platformPostId === null)
      issue(ctx, ['platformPostId'], 'published-needs-platform-post');
    const problem = targetIssue(value.content.platform, value.target);
    if (problem) issue(ctx, ['target'], problem);
  });
export type Variant = z.infer<typeof variantSchema>;

export const revisionSchema = z.strictObject({
  postId: z.uuid(),
  number: version,
  contentDigest: sha256,
  sources: sourcesSchema,
  reviewChoices: z.array(reviewChoiceEntrySchema).max(10),
  expiresAt: isoDateTime,
  decision: decisionSchema.nullable(),
  variants: z.array(variantSchema).min(1).max(10),
});
export type Revision = z.infer<typeof revisionSchema>;

/** The latest moment a revision can wait for a decision: 7 days, or the earliest `publishAt` if sooner. */
export const revisionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
export function revisionExpiresAt(createdAt: Date, publishAts: readonly (string | null)[]): Date {
  const deadlines = [createdAt.getTime() + revisionLifetimeMs];
  for (const publishAt of publishAts) if (publishAt !== null) deadlines.push(Date.parse(publishAt));
  return new Date(Math.min(...deadlines));
}

export const postSchema = z.strictObject({
  id: z.uuid(),
  origin: originSchema,
  authorMembershipId: z.uuid(),
  currentRevision: version,
  revisions: z.array(revisionSchema).min(1),
});
export type Post = z.infer<typeof postSchema>;

// Commands

export const variantCommandSchema = z.strictObject({ variantId: z.uuid(), expectedState: variantStateSchema });
export const settleCommandSchema = z.discriminatedUnion('settlement', [
  z.strictObject({ variantId: z.uuid(), settlement: z.literal('published'), platformPostId: platformId }),
  z.strictObject({ variantId: z.uuid(), settlement: z.literal('not-published') }),
]);

// Engagement

export const engagementReadSchema = z.strictObject({
  channelId: z.uuid(),
  kind: z.enum(['comments', 'messages']),
  platformPostId: platformId.optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100),
});
export type EngagementRead = z.infer<typeof engagementReadSchema>;

export const engagementItemSchema = z.strictObject({
  platformId,
  parentId: platformId.nullable(),
  author: z.strictObject({ platformUserId: platformId, handle: z.string().min(1).max(256).nullable() }),
  text: z.string().max(65536),
  createdAt: isoDateTime,
});
export const engagementResultSchema = z.strictObject({
  untrusted: z.literal(true),
  sources: z.array(sourceDependencySchema).max(256),
  items: z.array(engagementItemSchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
});
export type EngagementResult = z.infer<typeof engagementResultSchema>;

/**
 * The storage bound for reply and message text, matching the column check. The limit that applies is the
 * adapter's `engagementTextLimit`, checked by `engagementTextIssue`.
 */
export const engagementTextMaximum = 63206;
/** Checks text against the adapter's declared limit; an adapter without one cannot send engagement. */
export function engagementTextIssue(text: string, engagementTextLimit: number | undefined): string | null {
  if (engagementTextLimit === undefined) return 'engagement-unsupported';
  return text.length > engagementTextLimit ? 'text-too-long' : null;
}
export const engagementPrepareSchema = z.strictObject({
  commandId: z.uuid(),
  channelId: z.uuid(),
  expectedChannelVersion: version,
  kind: z.enum(['reply', 'message']),
  inReplyTo: platformId,
  text: z.string().min(1).max(engagementTextMaximum),
});

export const engagementStateSchema = z.enum([
  'prepared',
  'awaiting-approval',
  'approved',
  'sending',
  'sent',
  'failed',
  'blocked',
  'outcome-unknown',
  'not-sent',
  'rejected',
  'expired',
]);
/** Binds the action's `digest`. */
export const engagementDecisionSchema = z.strictObject({
  id: z.uuid(),
  actionId: z.uuid(),
  digest: sha256,
  decision: z.enum(['approve', 'reject']),
  deciderMembershipId: z.uuid(),
  decidedAt: isoDateTime,
});
export type EngagementDecision = z.infer<typeof engagementDecisionSchema>;

/** Held on the action, because an action has one send. */
export const engagementReceiptSchema = z
  .strictObject({
    status: receiptStatusSchema,
    startedAt: isoDateTime,
    settledAt: isoDateTime.nullable(),
    platformId: platformId.nullable(),
    platformRequestId: z.string().min(1).max(256).nullable(),
    error: receiptErrorSchema.nullable(),
  })
  .refine(value => (value.status === 'executing') === (value.settledAt === null), {
    path: ['settledAt'],
    message: 'settled-at-mismatch',
  })
  .refine(value => value.error === null || value.status === 'failed' || value.status === 'outcome-unknown', {
    path: ['error'],
    message: 'error-only-when-unsuccessful',
  });
export type EngagementReceipt = z.infer<typeof engagementReceiptSchema>;

export const engagementActionSchema = z
  .strictObject({
    id: z.uuid(),
    channelId: z.uuid(),
    kind: z.enum(['reply', 'message']),
    inReplyTo: platformId,
    text: z.string().min(1).max(engagementTextMaximum),
    digest: sha256,
    sources: sourcesSchema,
    approvalRequired: z.boolean(),
    decision: engagementDecisionSchema.nullable(),
    state: engagementStateSchema,
    blockedReason: blockedReasonSchema.nullable(),
    receipt: engagementReceiptSchema.nullable(),
  })
  .refine(value => (value.state === 'blocked') === (value.blockedReason !== null), {
    path: ['blockedReason'],
    message: 'blocked-reason',
  })
  .refine(value => value.approvalRequired || value.decision === null, {
    path: ['decision'],
    message: 'decision-without-approval',
  })
  .refine(
    value =>
      value.decision === null || (value.decision.actionId === value.id && value.decision.digest === value.digest),
    {
      path: ['decision'],
      message: 'decision-binds-action-digest',
    },
  );
export type EngagementAction = z.infer<typeof engagementActionSchema>;

// Analytics

export const metricNameSchema = z.enum([
  'impressions',
  'reach',
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'clicks',
  'followers',
  'watch-time-seconds',
]);
export const analyticsReadSchema = z
  .strictObject({ channelId: z.uuid(), platformPostId: platformId.optional(), from: isoDateTime, to: isoDateTime })
  .refine(value => Date.parse(value.from) <= Date.parse(value.to), { path: ['to'], message: 'range-reversed' });
export type AnalyticsRead = z.infer<typeof analyticsReadSchema>;
export const metricResultSchema = z
  .strictObject({
    name: metricNameSchema,
    value: z.number().nonnegative().nullable(),
    status: z.enum(['ok', 'unsupported', 'unavailable']),
  })
  .refine(value => (value.status === 'ok') === (value.value !== null), { path: ['value'], message: 'value-status' });
export type MetricResult = z.infer<typeof metricResultSchema>;
const metricsSchema = z
  .array(metricResultSchema)
  .max(metricNameSchema.options.length)
  .refine(metrics => new Set(metrics.map(metric => metric.name)).size === metrics.length, 'duplicate-metric');
export const analyticsResultSchema = z.strictObject({ metrics: metricsSchema });
export const analyticsSnapshotSchema = z.strictObject({
  channelId: z.uuid(),
  variantId: z.uuid().nullable(),
  capturedAt: isoDateTime,
  metrics: metricsSchema,
});

// Agent tools

export const validationErrorSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number()])).max(16),
  code: z.string().min(1).max(200),
});
export type ValidationError = z.infer<typeof validationErrorSchema>;

/** Each variant's checks when a revision is written; any error keeps every variant in `draft` (PRODUCT 13). */
export const variantChecksSchema = z
  .array(z.strictObject({ channelId: z.uuid(), valid: z.boolean(), errors: z.array(validationErrorSchema).max(64) }))
  .min(1)
  .max(10);
export const preparedPostSchema = z.strictObject({ post: postSchema, variants: variantChecksSchema });
export type PreparedPost = z.infer<typeof preparedPostSchema>;

export const agentToolInputSchemas = {
  social_list_channels: z.strictObject({ platform: platformSchema.optional() }),
  social_prepare_post: z.strictObject({ variants: variantsSchema }),
  social_read_analytics: analyticsReadSchema,
  social_read_engagement: engagementReadSchema,
  social_prepare_reply: engagementPrepareSchema.omit({ commandId: true }),
} as const;
export const agentToolResultSchemas = {
  social_list_channels: z.strictObject({ channels: z.array(channelSchema).max(1000) }),
  social_prepare_post: z.strictObject({
    postId: z.uuid(),
    approvalId: z.uuid(),
    variants: z
      .array(
        z.strictObject({ channelId: z.uuid(), valid: z.boolean(), errors: z.array(validationErrorSchema).max(64) }),
      )
      .min(1)
      .max(10),
  }),
  social_read_analytics: analyticsResultSchema,
  social_read_engagement: engagementResultSchema,
  social_prepare_reply: z.strictObject({ actionId: z.uuid(), approvalRequired: z.boolean() }),
} as const;
export type AgentToolName = keyof typeof agentToolInputSchemas;
