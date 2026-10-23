import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as c from '../dist/contracts.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hex = 'a'.repeat(64);
const at = '2026-06-01T12:00:00.000Z';
const image = (n = 1, role = 'primary') => ({ fileId: id(100 + n), contentDigest: hex, role });
const many = (count, role = 'primary') => Array.from({ length: count }, (_, n) => image(n, role));
const people = { memberIds: [id(1)], teamIds: [] };
const nobody = { memberIds: [], teamIds: [] };
const grantSet = { publish: people, analytics: people, engagement: nobody, manage: people };
const creatorInfo = {
  nickname: 'creator',
  maxVideoPostDurationSec: 600,
  privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
  commentDisabled: false,
  duetDisabled: true,
  stitchDisabled: false,
};
const choices = {
  privacy: 'PUBLIC_TO_EVERYONE',
  allowComments: true,
  allowDuet: false,
  allowStitch: false,
  commercialContent: { disclosed: false, yourBrand: false, brandedContent: false },
  creatorInfo,
};
const content = {
  linkedin: { platform: 'linkedin', text: 'Hello', media: [], visibility: 'public' },
  youtube: {
    platform: 'youtube',
    title: 'Launch',
    description: '',
    media: [image()],
    privacy: 'public',
    madeForKids: false,
  },
  facebook: { platform: 'facebook', text: 'Hello', media: [], format: 'feed' },
  instagram: { platform: 'instagram', caption: 'Hello', media: [image()], format: 'feed' },
  threads: { platform: 'threads', text: 'Hello', media: [], replyControl: 'everyone' },
  pinterest: { platform: 'pinterest', title: 'Pin', description: '', media: [image()] },
  tiktok: { platform: 'tiktok', caption: 'Hello', media: [image()] },
  x: { platform: 'x', text: 'Hello', media: [], replySettings: 'everyone' },
  reddit: { platform: 'reddit', title: 'Hello', media: [], kind: 'self', nsfw: false, spoiler: false },
};
const targets = { pinterest: { kind: 'board', boardId: 'b1' }, reddit: { kind: 'subreddit', name: 'tulips' } };
const variantInput = (platform = 'x', extra = {}) => ({
  channelId: id(10),
  expectedChannelVersion: 1,
  ...(targets[platform] ? { target: targets[platform] } : {}),
  content: content[platform],
  publishAt: null,
  ...extra,
});
const receipt = {
  id: id(40),
  variantId: id(30),
  revision: 1,
  decisionId: id(50),
  step: 'create-post',
  attemptId: id(41),
  status: 'succeeded',
  startedAt: at,
  settledAt: at,
  platformRefs: { tweet: '1' },
  platformPostId: '1',
  platformRequestId: 'req-1',
  error: null,
};
const variant = {
  id: id(30),
  postId: id(20),
  revision: 1,
  channelId: id(10),
  channelVersion: 1,
  target: null,
  content: content.x,
  publishAt: null,
  dueAt: at,
  state: 'scheduled',
  step: null,
  blockedReason: null,
  recheckAt: null,
  platformRefs: {},
  platformPostId: null,
  permalink: null,
  receipts: [],
};
const decision = {
  id: id(50),
  postId: id(20),
  revision: 1,
  batchDigest: hex,
  decision: 'approve',
  deciderMembershipId: id(1),
  decidedAt: at,
};
const sources = { dependencies: [], mcpDerived: false, privateTaskDerived: false };
const revision = {
  postId: id(20),
  number: 1,
  contentDigest: hex,
  sources,
  reviewChoices: [],
  expiresAt: at,
  decision,
  variants: [variant],
};
const channel = {
  id: id(10),
  accountId: id(11),
  platform: 'x',
  channelKind: 'x-account',
  platformChannelId: '42',
  displayName: 'TulipFarm',
  accountGeneration: 1,
  version: 1,
  enabled: true,
  engagementPolicy: 'approve-each',
  grants: grantSet,
};
const account = {
  id: id(11),
  platform: 'x',
  ownership: { kind: 'personal' },
  appSource: 'hosted',
  platformAppId: null,
  state: 'active',
  identity: { platformUserId: '42', handle: 'tulipfarm', displayName: 'TulipFarm' },
  scopes: ['tweet.write'],
  generation: 1,
  grantsVersion: 1,
  capabilities: { read: true, use: true, manage: true },
};
const engagementDecision = {
  id: id(61),
  actionId: id(60),
  digest: hex,
  decision: 'approve',
  deciderMembershipId: id(1),
  decidedAt: at,
};
const engagementReceipt = {
  status: 'succeeded',
  startedAt: at,
  settledAt: at,
  platformId: '100',
  platformRequestId: 'req-2',
  error: null,
};
const engagementAction = {
  id: id(60),
  channelId: id(10),
  kind: 'reply',
  inReplyTo: '99',
  text: 'Thanks!',
  digest: hex,
  sources,
  approvalRequired: true,
  decision: null,
  state: 'awaiting-approval',
  blockedReason: null,
  receipt: null,
};
const metric = { name: 'likes', value: 3, status: 'ok' };

const shapes = {
  platformSchema: ['x', ['mastodon']],
  appSourceSchema: ['operator', ['self']],
  accessTierSchema: ['audited', ['gold']],
  capabilitySchema: ['messages', ['dm']],
  ownershipSchema: [{ kind: 'business', owningTeamId: id(2) }, [{ kind: 'business' }, { kind: 'personal', x: 1 }]],
  accountStateSchema: ['reconnect-required', ['expired']],
  channelKindSchema: ['organization-page', ['group']],
  platformAppCreateSchema: [
    { platform: 'tiktok', name: 'Ours', clientId: 'cid', clientSecret: 'secret', accessTier: 'audited' },
    [
      { platform: 'tiktok', name: 'Ours', clientId: 'cid', clientSecret: 'secret', accessTier: 'paid' },
      { platform: 'tiktok', name: 'Ours', clientId: 'cid', accessTier: 'audited' },
    ],
  ],
  platformAppMetadataSchema: [
    { id: id(3), platform: 'x', name: 'X', clientId: 'cid', accessTier: 'paid', generation: 1, createdAt: at },
    [
      {
        id: id(3),
        platform: 'x',
        name: 'X',
        clientId: 'cid',
        clientSecret: 's',
        accessTier: 'paid',
        generation: 1,
        createdAt: at,
      },
    ],
  ],
  platformAvailabilitySchema: [
    {
      platform: 'x',
      available: false,
      reason: 'workspace-app-required',
      appSource: null,
      accessTier: null,
      capabilities: [],
    },
    [
      {
        platform: 'x',
        available: true,
        reason: 'not-configured',
        appSource: null,
        accessTier: null,
        capabilities: [],
      },
      {
        platform: 'x',
        available: true,
        reason: null,
        appSource: 'hosted',
        accessTier: 'paid',
        capabilities: ['publish', 'publish'],
      },
    ],
  ],
  beginConnectionSchema: [
    { platform: 'linkedin', ownership: { kind: 'personal' } },
    [{ platform: 'linkedin', ownership: { kind: 'shared' } }],
  ],
  beginConnectionResultSchema: [
    { authorizationUrl: 'https://x.com/i/oauth2/authorize', attemptId: id(4) },
    [{ authorizationUrl: 'not a url', attemptId: id(4) }],
  ],
  socialAccountMetadataSchema: [
    account,
    [
      { ...account, appSource: 'workspace' },
      { ...account, scopes: ['a'].concat(Array(64).fill('b')) },
    ],
  ],
  socialAccountGrantsSchema: [
    { expectedVersion: 1, memberIds: [id(1)], teamIds: [] },
    [{ expectedVersion: 0, memberIds: [], teamIds: [] }],
  ],
  disconnectResultSchema: [
    { account: { ...account, state: 'disconnected' }, providerRevocation: 'manual-required' },
    [{ account, providerRevocation: 'maybe' }],
  ],
  discoveredChannelSchema: [
    { platformChannelId: '42', channelKind: 'x-account', displayName: 'T', handle: null, avatarUrl: null },
    [{ platformChannelId: '', channelKind: 'x-account', displayName: 'T', handle: null, avatarUrl: null }],
  ],
  addChannelSchema: [
    { accountId: id(11), expectedAccountGeneration: 1, platformChannelId: '42' },
    [{ accountId: id(11), platformChannelId: '42' }],
  ],
  channelGrantsSchema: [{ expectedVersion: 2, ...grantSet }, [{ expectedVersion: 2, ...grantSet, manage: nobody }]],
  engagementPolicySchema: ['automatic-within-authorization', ['automatic']],
  channelSchema: [
    channel,
    [
      { ...channel, channelKind: 'facebook-page' },
      { ...channel, grants: { ...grantSet, manage: nobody } },
    ],
  ],
  mediaItemSchema: [
    image(),
    [
      { ...image(), role: 'banner' },
      { ...image(), contentDigest: 'abc' },
    ],
  ],
  platformContentSchema: [
    content.x,
    [
      { ...content.x, platform: 'mastodon' },
      { ...content.x, extra: true },
    ],
  ],
  targetSchema: [targets.pinterest, [{ kind: 'subreddit', name: 'ab' }]],
  originSchema: [
    { kind: 'workflow-run', runId: id(5), stepId: 'post' },
    [
      { kind: 'task', taskId: id(5) },
      { kind: 'email', id: id(5) },
    ],
  ],
  variantInputSchema: [
    variantInput('pinterest'),
    [variantInput('x', { target: targets.pinterest }), { ...variantInput('reddit'), target: undefined }],
  ],
  sourcesSchema: [
    { dependencies: [{ kind: 'table', tableId: id(6) }], mcpDerived: true, privateTaskDerived: false },
    [{ dependencies: [{ kind: 'table' }], mcpDerived: true, privateTaskDerived: false }],
  ],
  tiktokCreatorInfoSchema: [creatorInfo, [{ ...creatorInfo, privacyLevelOptions: [] }]],
  tiktokReviewChoicesSchema: [choices, [{ ...choices, privacy: undefined }]],
  reviewChoiceEntrySchema: [
    { variantId: id(30), platform: 'tiktok', required: ['privacy'], values: choices },
    [{ variantId: id(30), platform: 'x', required: ['privacy'], values: null }],
  ],
  decisionSubmitSchema: [
    {
      postId: id(20),
      expectedRevision: 1,
      contentDigest: hex,
      decision: 'approve',
      reviewChoices: [{ variantId: id(30), values: choices }],
    },
    [
      { postId: id(20), expectedRevision: 1, contentDigest: hex, decision: 'reject', reviewChoices: [] },
      { postId: id(20), expectedRevision: 1, contentDigest: 'XYZ', decision: 'approve' },
      { postId: id(20), expectedRevision: 1, contentDigest: hex, batchDigest: hex, decision: 'approve' },
      { postId: id(20), expectedRevision: 1, batchDigest: hex, decision: 'approve' },
    ],
  ],
  decisionSchema: [
    decision,
    [
      { ...decision, decision: 'expired' },
      { ...decision, batchDigest: undefined, contentDigest: hex },
    ],
  ],
  variantStateSchema: ['outcome-unknown', ['unknown']],
  blockedReasonSchema: ['daily-cap', ['quota']],
  stepKindSchema: ['publish-container', ['await']],
  stepSchema: [
    { kind: 'await', for: 'video-processed', maxSeconds: 3600 },
    [
      { kind: 'await', for: 'video-processed' },
      { kind: 'create-post', mode: 'await' },
    ],
  ],
  variantStepSchema: [
    { index: 0, kind: 'await' },
    [
      { index: -1, kind: 'create-post' },
      { index: 1.5, kind: 'create-post' },
      { index: 0, kind: 'publish' },
      { kind: 'create-post', mode: 'mutate' },
      { index: 0, kind: 'create-post', mode: 'mutate' },
    ],
  ],
  platformRefsSchema: [{ container: 'c1' }, [Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`k${n}`, 'v']))]],
  errorClassSchema: ['reconnect', ['fatal']],
  receiptSchema: [
    receipt,
    [
      { ...receipt, status: 'executing' },
      { ...receipt, error: { class: 'rejected', code: 'duplicate' } },
    ],
  ],
  variantSchema: [
    { ...variant, state: 'processing', step: { index: 1, kind: 'publish-container' } },
    [
      { ...variant, step: { kind: 'create-post', mode: 'mutate' } },
      { ...variant, state: 'blocked' },
      { ...variant, state: 'blocked', blockedReason: 'grant-removed', recheckAt: at },
      { ...variant, state: 'blocked', blockedReason: 'daily-cap' },
      { ...variant, state: 'published' },
    ],
  ],
  revisionSchema: [
    revision,
    [
      { ...revision, variants: [] },
      { ...revision, contentDigest: undefined, batchDigest: hex },
      { ...revision, variants: Array(11).fill(variant) },
    ],
  ],
  postSchema: [
    {
      id: id(20),
      origin: { kind: 'conversation', conversationId: id(7), messageId: id(8) },
      authorMembershipId: id(1),
      currentRevision: 1,
      revisions: [revision],
    },
    [
      {
        id: id(20),
        origin: { kind: 'conversation', conversationId: id(7), messageId: id(8) },
        authorMembershipId: id(1),
        currentRevision: 1,
        revisions: [],
      },
    ],
  ],
  variantCommandSchema: [{ variantId: id(30), expectedState: 'blocked' }, [{ variantId: id(30) }]],
  settleCommandSchema: [
    { variantId: id(30), settlement: 'published', platformPostId: '1' },
    [
      { variantId: id(30), settlement: 'published' },
      { variantId: id(30), settlement: 'failed' },
    ],
  ],
  engagementReadSchema: [
    { channelId: id(10), kind: 'comments', limit: 100 },
    [{ channelId: id(10), kind: 'comments', limit: 101 }],
  ],
  engagementResultSchema: [
    {
      untrusted: true,
      sources: [],
      items: [
        { platformId: '1', parentId: null, author: { platformUserId: '2', handle: null }, text: 'hi', createdAt: at },
      ],
      nextCursor: null,
    },
    [{ untrusted: false, sources: [], items: [], nextCursor: null }],
  ],
  engagementPrepareSchema: [
    { commandId: id(9), channelId: id(10), expectedChannelVersion: 1, kind: 'reply', inReplyTo: '1', text: 'hi' },
    [
      { commandId: id(9), channelId: id(10), expectedChannelVersion: 1, kind: 'reply', inReplyTo: '1', text: '' },
      {
        commandId: id(9),
        channelId: id(10),
        expectedChannelVersion: 1,
        kind: 'reply',
        inReplyTo: '1',
        text: 'a'.repeat(c.engagementTextMaximum + 1),
      },
    ],
  ],
  engagementStateSchema: ['not-sent', ['queued']],
  engagementDecisionSchema: [
    engagementDecision,
    [
      { ...engagementDecision, decision: 'expired' },
      { ...engagementDecision, digest: 'abc' },
      { ...engagementDecision, id: undefined },
    ],
  ],
  engagementReceiptSchema: [
    { ...engagementReceipt, status: 'failed', platformId: null, error: { class: 'rejected', code: 'duplicate' } },
    [
      { ...engagementReceipt, status: 'executing' },
      { ...engagementReceipt, error: { class: 'rejected', code: 'duplicate' } },
      { ...engagementReceipt, error: { class: 'rejected', code: 'a'.repeat(201) } },
      { ...engagementReceipt, attemptId: id(62) },
    ],
  ],
  engagementActionSchema: [
    { ...engagementAction, state: 'sent', decision: engagementDecision, receipt: engagementReceipt },
    [
      { ...engagementAction, state: 'blocked' },
      { ...engagementAction, approvalRequired: false, decision: engagementDecision },
      { ...engagementAction, decision: { ...engagementDecision, actionId: id(63) } },
      { ...engagementAction, decision: { ...engagementDecision, digest: 'b'.repeat(64) } },
      { ...engagementAction, decision: { decision: 'approve', deciderMembershipId: id(1), decidedAt: at } },
    ],
  ],
  metricNameSchema: ['watch-time-seconds', ['ctr']],
  analyticsReadSchema: [
    { channelId: id(10), from: at, to: at },
    [{ channelId: id(10), from: '2026-06-02T00:00:00Z', to: at }],
  ],
  metricResultSchema: [
    { name: 'views', value: null, status: 'unsupported' },
    [
      { name: 'views', value: null, status: 'ok' },
      { name: 'views', value: 1, status: 'unavailable' },
    ],
  ],
  analyticsResultSchema: [{ metrics: [metric] }, [{ metrics: [metric, metric] }]],
  analyticsSnapshotSchema: [
    { channelId: id(10), variantId: null, capturedAt: at, metrics: [metric] },
    [{ channelId: id(10), capturedAt: at, metrics: [metric] }],
  ],
  validationErrorSchema: [{ path: ['content', 'text'], code: 'text-too-long' }, [{ path: [], code: '' }]],
};

for (const [name, [valid, invalid]] of Object.entries(shapes)) {
  test(`${name} accepts a valid fixture and refuses invalid ones`, () => {
    const schema = c[name];
    assert.ok(schema, `${name} is exported`);
    const parsed = schema.safeParse(valid);
    assert.ok(parsed.success, `${name}: ${parsed.error?.message}`);
    for (const value of invalid)
      assert.equal(schema.safeParse(value).success, false, `${name}: ${JSON.stringify(value)}`);
  });
}

test('agent tool schemas cover every tool with a valid and invalid input and result', () => {
  const inputs = {
    social_list_channels: [{ platform: 'x' }, { platform: 'myspace' }],
    social_prepare_post: [{ variants: [variantInput()] }, { variants: [] }],
    social_read_analytics: [{ channelId: id(10), from: at, to: at }, { channelId: id(10) }],
    social_read_engagement: [
      { channelId: id(10), kind: 'messages', limit: 1 },
      { channelId: id(10), kind: 'dm', limit: 1 },
    ],
    social_prepare_reply: [
      { channelId: id(10), expectedChannelVersion: 1, kind: 'message', inReplyTo: '1', text: 'hi' },
      { commandId: id(9), channelId: id(10), expectedChannelVersion: 1, kind: 'message', inReplyTo: '1', text: 'hi' },
    ],
  };
  const results = {
    social_list_channels: [{ channels: [channel] }, { channels: [{ ...channel, enabled: 'yes' }] }],
    social_prepare_post: [
      { postId: id(20), approvalId: id(21), variants: [{ channelId: id(10), valid: true, errors: [] }] },
      { postId: id(20), approvalId: id(21), variants: [] },
    ],
    social_read_analytics: [{ metrics: [] }, { metrics: [{ name: 'likes', value: -1, status: 'ok' }] }],
    social_read_engagement: [
      { untrusted: true, sources: [], items: [], nextCursor: null },
      { sources: [], items: [] },
    ],
    social_prepare_reply: [{ actionId: id(60), approvalRequired: false }, { actionId: id(60) }],
  };
  assert.deepEqual(Object.keys(c.agentToolInputSchemas).sort(), Object.keys(inputs).sort());
  assert.deepEqual(Object.keys(c.agentToolResultSchemas).sort(), Object.keys(results).sort());
  for (const [tool, [valid, invalid]] of Object.entries(inputs)) {
    assert.ok(c.agentToolInputSchemas[tool].safeParse(valid).success, tool);
    assert.equal(c.agentToolInputSchemas[tool].safeParse(invalid).success, false, tool);
  }
  for (const [tool, [valid, invalid]] of Object.entries(results)) {
    assert.ok(c.agentToolResultSchemas[tool].safeParse(valid).success, tool);
    assert.equal(c.agentToolResultSchemas[tool].safeParse(invalid).success, false, tool);
  }
});

test('access tiers and channel kinds belong to one platform each', () => {
  assert.ok(c.isAccessTierFor('tiktok', 'audited'));
  assert.equal(c.isAccessTierFor('x', 'audited'), false);
  assert.ok(c.isChannelKindFor('instagram', 'instagram-creator'));
  assert.equal(c.isChannelKindFor('threads', 'instagram-creator'), false);
  assert.deepEqual(Object.keys(c.accessTiersByPlatform).sort(), [...c.platforms].sort());
  assert.deepEqual(Object.keys(c.channelKindsByPlatform).sort(), [...c.platforms].sort());
});

test('only Pinterest and Reddit posts take a target, of their own kind', () => {
  assert.equal(c.targetIssue('pinterest', targets.pinterest), null);
  assert.equal(c.targetIssue('pinterest', null), 'target-required');
  assert.equal(c.targetIssue('pinterest', targets.reddit), 'target-kind-mismatch');
  assert.equal(c.targetIssue('reddit', targets.reddit), null);
  for (const platform of ['linkedin', 'youtube', 'facebook', 'instagram', 'threads', 'tiktok', 'x']) {
    assert.equal(c.targetIssue(platform, undefined), null);
    assert.equal(c.targetIssue(platform, targets.pinterest), 'target-not-allowed');
  }
});

test('connection limits are exported constants', () => {
  assert.deepEqual(c.socialAccountLimits, { workspace: 100, personal: 20, business: 50 });
});

test('prepare input takes 1 to 10 variants on distinct channels and bounds publishAt by now', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const schema = c.prepareInputSchema(now);
  const input = variants => ({ commandId: id(9), origin: { kind: 'task', taskId: id(5), generation: 0 }, variants });
  const distinct = n => Array.from({ length: n }, (_, i) => variantInput('x', { channelId: id(200 + i) }));
  assert.ok(schema.safeParse(input(distinct(1))).success);
  assert.ok(schema.safeParse(input(distinct(10))).success);
  assert.equal(schema.safeParse(input([])).success, false);
  assert.equal(schema.safeParse(input(distinct(11))).success, false);
  assert.equal(schema.safeParse(input([variantInput(), variantInput()])).success, false);
  const at = ms => new Date(now.getTime() + ms).toISOString();
  const { minimumMs, maximumMs } = c.publishAtBounds;
  assert.equal(minimumMs, 2 * 60 * 1000);
  assert.equal(maximumMs, 180 * 24 * 60 * 60 * 1000);
  assert.ok(schema.safeParse(input([variantInput('x', { publishAt: at(minimumMs) })])).success);
  assert.ok(schema.safeParse(input([variantInput('x', { publishAt: at(maximumMs) })])).success);
  assert.equal(c.publishAtIssue(at(minimumMs - 1), now), 'publish-at-too-soon');
  assert.equal(c.publishAtIssue(at(maximumMs + 1), now), 'publish-at-too-late');
  assert.equal(schema.safeParse(input([variantInput('x', { publishAt: at(minimumMs - 1) })])).success, false);
  assert.equal(c.publishAtIssue(null, now), null);
});

test('a revision expires after 7 days or at its earliest publishAt', () => {
  const created = new Date('2026-06-01T00:00:00.000Z');
  assert.equal(c.revisionExpiresAt(created, [null]).toISOString(), '2026-06-08T00:00:00.000Z');
  assert.equal(
    c.revisionExpiresAt(created, ['2026-06-03T00:00:00.000Z', '2026-06-02T00:00:00.000Z']).toISOString(),
    '2026-06-02T00:00:00.000Z',
  );
});

const ok = value => c.platformContentSchema.safeParse(value).success;
const text = n => 'a'.repeat(n);
const textLimits = [
  ['linkedin', 'text', 3000],
  ['youtube', 'title', 100],
  ['youtube', 'description', 5000],
  ['facebook', 'text', 63206],
  ['instagram', 'caption', 2200],
  ['threads', 'text', 500],
  ['pinterest', 'title', 100],
  ['pinterest', 'description', 800],
  ['pinterest', 'altText', 500],
  ['tiktok', 'caption', 2200],
  ['reddit', 'title', 300],
  ['reddit', 'body', 40000],
];
for (const [platform, field, limit] of textLimits) {
  test(`${platform} ${field} allows ${limit} characters and refuses ${limit + 1}`, () => {
    assert.ok(ok({ ...content[platform], [field]: text(limit) }));
    assert.equal(ok({ ...content[platform], [field]: text(limit + 1) }), false);
  });
}

const countLimits = [
  ['linkedin', 20, 'primary'],
  ['facebook', 10, 'primary'],
  ['threads', 20, 'primary'],
  ['tiktok', 35, 'primary'],
  ['x', 4, 'primary'],
];
for (const [platform, limit] of countLimits) {
  test(`${platform} allows ${limit} media items and refuses ${limit + 1}`, () => {
    assert.ok(ok({ ...content[platform], media: many(limit) }));
    assert.equal(ok({ ...content[platform], media: many(limit + 1) }), false);
  });
}

test('Instagram carousels take 2 to 10 items, 30 hashtags and 3 collaborators', () => {
  const carousel = media => ({ ...content.instagram, format: 'carousel', media });
  assert.ok(ok(carousel(many(2))));
  assert.ok(ok(carousel(many(10))));
  assert.equal(ok(carousel(many(1))), false);
  assert.equal(ok(carousel(many(11))), false);
  const tags = n => Array.from({ length: n }, (_, i) => `#t${i}`).join(' ');
  assert.ok(ok({ ...content.instagram, caption: tags(30) }));
  assert.equal(ok({ ...content.instagram, caption: tags(31) }), false);
  assert.ok(ok({ ...content.instagram, collaborators: ['a', 'b', 'c'] }));
  assert.equal(ok({ ...content.instagram, collaborators: ['a', 'b', 'c', 'd'] }), false);
  assert.ok(ok({ ...content.instagram, format: 'reel', shareReelToFeed: true, media: [image(), image(2, 'cover')] }));
  assert.equal(ok({ ...content.instagram, shareReelToFeed: true }), false);
  assert.equal(ok({ ...content.instagram, format: 'story', caption: 'no' }), false);
});

test('Pinterest takes 1 to 5 images, or one video with one cover', () => {
  assert.ok(ok({ ...content.pinterest, media: many(5) }));
  assert.equal(ok({ ...content.pinterest, media: many(6) }), false);
  assert.ok(ok({ ...content.pinterest, media: [image(), image(2, 'cover')] }));
  assert.equal(ok({ ...content.pinterest, media: [image(), image(2), image(3, 'cover')] }), false);
});

test('YouTube needs one video, an optional thumbnail and 500 characters of tags', () => {
  assert.ok(ok({ ...content.youtube, media: [image(), image(2, 'thumbnail')], tags: [text(250), text(250)] }));
  assert.equal(ok({ ...content.youtube, tags: [text(250), text(251)] }), false);
  assert.equal(ok({ ...content.youtube, media: [image(2, 'thumbnail')] }), false);
});

test('Facebook stories have one media item and no text or link', () => {
  assert.ok(ok({ ...content.facebook, format: 'story', text: '', media: [image()] }));
  assert.equal(ok({ ...content.facebook, format: 'story', text: 'hi', media: [image()] }), false);
  assert.equal(ok({ ...content.facebook, format: 'story', text: '', media: [] }), false);
});

test('Reddit kinds match their link and media', () => {
  assert.ok(ok({ ...content.reddit, kind: 'link', link: 'https://example.com' }));
  assert.equal(ok({ ...content.reddit, kind: 'link' }), false);
  assert.ok(ok({ ...content.reddit, kind: 'image', media: [image()] }));
  assert.equal(ok({ ...content.reddit, kind: 'image' }), false);
});

test('X counts weighted characters: 280 unless the account reports Premium, then 25,000', () => {
  const kinds = new Map();
  const issues = (value, xPremium) =>
    c.contentIssues({ ...content.x, text: value }, { channelKind: 'x-account', mediaKinds: kinds, xPremium });
  assert.deepEqual(
    c.contentIssues({ ...content.x, text: text(281) }, { channelKind: 'x-account', mediaKinds: kinds }),
    [{ path: ['text'], code: 'text-too-long' }],
  );
  assert.deepEqual(issues(text(280), false), []);
  assert.deepEqual(issues(text(281), false), [{ path: ['text'], code: 'text-too-long' }]);
  assert.deepEqual(issues(text(281), true), []);
  assert.deepEqual(issues('日'.repeat(140), false), []);
  assert.equal(issues('日'.repeat(141), false).length, 1);
  assert.ok(ok({ ...content.x, text: text(25000) }));
  assert.equal(ok({ ...content.x, text: text(25001) }), false);
});

test('content rules that need the channel and File kinds', () => {
  const kinds = entries => new Map(entries.map(([n, kind]) => [image(n).fileId, kind]));
  const linkedin = { ...content.linkedin, visibility: 'connections' };
  assert.deepEqual(c.contentIssues(linkedin, { channelKind: 'member-profile', mediaKinds: kinds([]) }), []);
  assert.deepEqual(c.contentIssues(linkedin, { channelKind: 'organization-page', mediaKinds: kinds([]) }), [
    { path: ['visibility'], code: 'connections-only-for-member-profile' },
  ]);
  const document = { ...content.linkedin, title: 'Deck', media: [image(1)] };
  assert.deepEqual(
    c.contentIssues(document, { channelKind: 'member-profile', mediaKinds: kinds([[1, 'document']]) }),
    [],
  );
  assert.ok(c.contentIssues(document, { channelKind: 'member-profile', mediaKinds: kinds([[1, 'image']]) }).length);
  const reel = { ...content.instagram, format: 'reel' };
  assert.deepEqual(c.contentIssues(reel, { channelKind: 'instagram-creator', mediaKinds: kinds([[1, 'image']]) }), [
    { path: ['media'], code: 'reel-needs-video' },
  ]);
  const pin = { ...content.pinterest, media: [image(1)] };
  assert.deepEqual(c.contentIssues(pin, { channelKind: 'pinterest-account', mediaKinds: kinds([[1, 'video']]) }), [
    { path: ['media'], code: 'video-needs-cover' },
  ]);
  assert.deepEqual(
    c.contentIssues(content.tiktok, { channelKind: 'tiktok-account', mediaKinds: kinds([]) }).map(i => i.code),
    ['media-kind-unknown', 'media-shape'],
  );
  assert.deepEqual(c.contentIssues(content.x, { channelKind: 'facebook-page', mediaKinds: kinds([]) }), [
    { path: ['platform'], code: 'channel-platform-mismatch' },
  ]);
});

test('TikTok review choices have no defaults and follow the disclosure rules', () => {
  const parse = value => c.tiktokReviewChoicesSchema.safeParse(value);
  for (const field of ['privacy', 'allowComments', 'allowDuet', 'allowStitch', 'commercialContent']) {
    const { [field]: _, ...missing } = choices;
    assert.equal(parse(missing).success, false, `${field} has no default`);
  }
  const commercial = value => ({ ...choices, commercialContent: value });
  assert.equal(parse(commercial({ disclosed: true, yourBrand: false, brandedContent: false })).success, false);
  assert.ok(parse(commercial({ disclosed: true, yourBrand: true, brandedContent: false })).success);
  assert.ok(parse(commercial({ disclosed: true, yourBrand: false, brandedContent: true })).success);
  assert.equal(
    parse({ ...commercial({ disclosed: true, yourBrand: false, brandedContent: true }), privacy: 'SELF_ONLY' }).success,
    false,
  );
  assert.equal(parse({ ...choices, privacy: 'FOLLOWER_OF_CREATOR' }).success, false);
  assert.equal(parse({ ...choices, allowDuet: true }).success, false);
  assert.deepEqual(c.tiktokReviewChoiceIssues(choices, 'unaudited'), ['audited-app-required']);
  assert.deepEqual(c.tiktokReviewChoiceIssues({ ...choices, privacy: 'SELF_ONLY' }, 'unaudited'), []);
  assert.deepEqual(c.tiktokReviewChoiceIssues(choices, 'audited'), []);
});

test('only rate limits and daily caps are temporary blocked reasons', () => {
  assert.deepEqual([...c.temporaryBlockedReasons].sort(), ['daily-cap', 'rate-limited']);
  for (const reason of c.temporaryBlockedReasons) assert.ok(c.blockedReasonSchema.options.includes(reason));
});

test('LinkedIn, Facebook feed, Threads and X posts need text or at least one media item', () => {
  for (const platform of ['linkedin', 'facebook', 'threads', 'x']) {
    const field = 'text';
    assert.equal(ok({ ...content[platform], [field]: '' }), false, `${platform} empty`);
    assert.equal(ok({ ...content[platform], [field]: '  ' }), false, `${platform} blank`);
    assert.ok(ok({ ...content[platform], [field]: '', media: [image()] }), `${platform} media only`);
  }
  assert.equal(ok({ ...content.facebook, text: '', link: 'https://example.com' }), false);
  assert.ok(ok({ ...content.facebook, link: 'https://example.com' }));
});

test('platform identifiers are strings of 1 to 256 characters', () => {
  const id256 = text(256);
  assert.ok(c.targetSchema.safeParse({ kind: 'board', boardId: id256, sectionId: id256 }).success);
  assert.equal(c.targetSchema.safeParse({ kind: 'board', boardId: text(257) }).success, false);
  assert.equal(c.targetSchema.safeParse({ kind: 'board', boardId: '' }).success, false);
  assert.equal(c.targetSchema.safeParse({ kind: 'subreddit', name: 'tulips', flairId: text(257) }).success, false);
  assert.ok(ok({ ...content.youtube, categoryId: id256 }));
  assert.equal(ok({ ...content.youtube, categoryId: text(257) }), false);
  assert.ok(
    c.addChannelSchema.safeParse({ accountId: id(11), expectedAccountGeneration: 1, platformChannelId: id256 }).success,
  );
  assert.equal(
    c.addChannelSchema.safeParse({ accountId: id(11), expectedAccountGeneration: 1, platformChannelId: text(257) })
      .success,
    false,
  );
});

test('media items carry no kind; it comes from the File', () => {
  assert.equal(c.mediaItemSchema.safeParse({ ...image(), kind: 'image' }).success, false);
  assert.deepEqual(Object.keys(c.mediaItemSchema.shape).sort(), ['altText', 'contentDigest', 'fileId', 'role']);
});

test('engagement text is checked against the adapter limit, within the storage maximum', () => {
  assert.equal(c.engagementTextMaximum, 63206);
  assert.equal(c.engagementTextIssue(text(280), 280), null);
  assert.equal(c.engagementTextIssue(text(281), 280), 'text-too-long');
  assert.equal(c.engagementTextIssue('hi', undefined), 'engagement-unsupported');
});

test('channel grants have only member and team subjects', () => {
  assert.deepEqual(Object.keys(c.principalSetSchema.shape).sort(), ['memberIds', 'teamIds']);
  assert.equal(c.principalSetSchema.safeParse({ memberIds: [], teamIds: [], agentIds: [] }).success, false);
  assert.equal(
    c.socialAccountGrantsSchema.safeParse({ expectedVersion: 1, memberIds: [], teamIds: [], agentIds: [] }).success,
    false,
  );
});
