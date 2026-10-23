import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { currentMember, protectedSourceClosure, requireProtectedSource } from '@tulipfarm/access';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { connect, denied, fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createSocialAccounts } from '../dist/accounts.js';
import { batchDigest, contentDigest } from '../dist/batch-digest.js';
import { createSocialChannels } from '../dist/channels.js';
import { postSchema } from '../dist/contracts.js';
import { mediaKind } from '../dist/media.js';
import { createPlatformApps, operatorPlatformApps } from '../dist/platform-apps.js';
import { createFakeAdapter } from '../dist/platforms/fake.js';
import { createSocialPosts } from '../dist/posts.js';

const callbackUrl = 'https://api.example.test/v1/social/oauth/callback';
const keyring = { activeKeyId: 'test', keys: { test: 'ef'.repeat(32) } };
const session = 'test-session';
const operator = (prefix, tier) => ({
  [`${prefix}_CLIENT_ID`]: `${prefix}-client`,
  [`${prefix}_CLIENT_SECRET`]: 'operator-secret',
  [`${prefix}_REDIRECT_URI`]: callbackUrl,
  [`${prefix}_ACCESS_TIER`]: tier,
});
const env = {
  ...operator('SOCIAL_LINKEDIN', 'community-management'),
  ...operator('SOCIAL_X', 'paid'),
  ...operator('SOCIAL_TIKTOK', 'unaudited'),
};
const code = expected => error => error?.code === expected;
const deniedAccess = error => error?.message === 'Resource not found';
const zod = error => error?.name === 'ZodError';
const none = { memberIds: [], teamIds: [] };
const only = person => ({ memberIds: [person.membershipId], teamIds: [] });

const discovered = {
  linkedin: [
    {
      platformChannelId: 'urn:li:person:founder',
      channelKind: 'member-profile',
      displayName: 'Founder',
      handle: 'founder',
      avatarUrl: null,
    },
    {
      platformChannelId: 'urn:li:organization:42',
      channelKind: 'organization-page',
      displayName: 'Brand',
      handle: null,
      avatarUrl: null,
    },
  ],
  x: [
    { platformChannelId: 'x-brand', channelKind: 'x-account', displayName: 'Brand', handle: 'brand', avatarUrl: null },
  ],
  tiktok: [
    {
      platformChannelId: 'tt-brand',
      channelKind: 'tiktok-account',
      displayName: 'Brand',
      handle: 'brand',
      avatarUrl: null,
    },
  ],
};
const everyChoice = ['privacy', 'allowComments', 'allowDuet', 'allowStitch', 'commercialContent'];
const creatorInfo = {
  nickname: 'Brand',
  maxVideoPostDurationSec: 600,
  privacyLevelOptions: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'],
  commentDisabled: false,
  duetDisabled: true,
  stitchDisabled: false,
};
const tiktokChoices = (privacy = 'SELF_ONLY') => ({
  privacy,
  allowComments: true,
  allowDuet: false,
  allowStitch: false,
  commercialContent: { disclosed: false, yourBrand: false, brandedContent: false },
  creatorInfo,
});

let db;
let ws;
let runtime;
let raw;
let member;
let other;
let teamId;

const table = name => qualified(ws.names.schema, name);
const admin = () => ({ userId: ws.userId, membershipId: ws.membershipId });

/** The chat source check built from the same access primitives as `requireDraftSources`. */
async function requireSources(tx, actor, sources) {
  await currentMember(tx, actor);
  for (const source of await protectedSourceClosure(tx, sources)) await requireProtectedSource(tx, actor, source);
}

function service({ now, validate } = {}) {
  const platforms = Object.fromEntries(
    Object.entries(discovered).map(([platform, channels]) => [
      platform,
      createFakeAdapter({ platform, scopes: () => ['fake.publish'], validate })
        .fallback('exchangeCode', {
          accessToken: `${platform}-access`,
          refreshToken: `${platform}-refresh`,
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: ['fake.publish'],
        })
        .fallback('identity', { platformUserId: `${platform}-person`, handle: 'person', displayName: 'Person' })
        .fallback('listChannels', channels)
        .fallback('targetRules', { postingAllowed: true, flairRequired: false, flairIds: [] })
        .fallback('reviewChoices', everyChoice),
    ]),
  );
  const platformApps = createPlatformApps({ operator: operatorPlatformApps(env), callbackUrl });
  const accounts = createSocialAccounts({ runtime, keyring, platformApps, adapters: platforms });
  const channels = createSocialChannels({ runtime, accounts, adapters: platforms });
  const posts = createSocialPosts({
    runtime,
    accounts,
    channels,
    adapters: platforms,
    requireSources,
    resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
    now,
  });
  const connectAccount = async (input, user) => {
    const started = await accounts.begin(ws.id, user, session, { ownership: { kind: 'personal' }, ...input });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    await accounts.complete('platform-code', state, session, user);
    return started.attemptId;
  };
  const grant = async (user, channel, grants) =>
    channels.setGrants(ws.id, user, channel.id, {
      expectedVersion: (await channels.get(ws.id, user, channel.id)).version,
      publish: none,
      analytics: none,
      engagement: none,
      ...grants,
    });
  /** A channel on the person's own connection that only they may publish to and manage. */
  const personal = async (platform, person = admin()) => {
    const accountId = await connectAccount({ platform }, person.userId);
    const [first] = discovered[platform];
    const channel = await channels.add(ws.id, person.userId, {
      accountId,
      expectedAccountGeneration: 1,
      platformChannelId: first.platformChannelId,
    });
    return grant(person.userId, channel, { publish: only(person), manage: only(person) });
  };
  /** The Marketing page: `member` and `other` both publish to it; `member` manages it. */
  const sharedPage = async () => {
    const accountId = await connectAccount(
      { platform: 'linkedin', ownership: { kind: 'business', owningTeamId: teamId } },
      member.userId,
    );
    const account = await accounts.status(ws.id, member.userId, accountId);
    await accounts.setGrants(ws.id, member.userId, accountId, {
      expectedVersion: account.grantsVersion,
      memberIds: [member.membershipId, other.membershipId],
      teamIds: [],
    });
    const channel = await channels.add(ws.id, member.userId, {
      accountId,
      expectedAccountGeneration: 1,
      platformChannelId: discovered.linkedin[1].platformChannelId,
    });
    return grant(member.userId, channel, {
      publish: { memberIds: [member.membershipId, other.membershipId], teamIds: [] },
      manage: only(member),
    });
  };
  return { accounts, channels, posts, platforms, personal, sharedPage, grant };
}

async function chat(person = admin()) {
  const id = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
    [id, person.userId, person.membershipId],
  );
  return id;
}
/** A ready File the person created. */
async function file(person = admin(), mediaType = 'image/png') {
  const id = randomUUID();
  const sha256 = createHash('sha256').update(id).digest('hex');
  await db.platform.query(
    `INSERT INTO ${table('tf_files')} (id,kind,creator_membership_id,name,object_key,media_type,size,sha256,ready)
     VALUES ($1,'file',$2,'media',$3,$4,10,$5,true)`,
    [id, person.membershipId, randomUUID(), mediaType, sha256],
  );
  return { fileId: id, contentDigest: sha256, role: 'primary' };
}

async function savedAgent(sponsor) {
  const agent = randomUUID();
  const revision = 'b'.repeat(64);
  const soul = randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const command = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_agents')} (id) VALUES ($1)`, [agent]);
  await db.platform.query(`INSERT INTO ${table('tf_agent_definitions')} VALUES ($1,$2,'{}')`, [agent, revision]);
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input) VALUES ($1,$2,$3,$4,$5,'{}')`,
    [command, agent, ws.membershipId, ws.userId, randomUUID()],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_soul_revisions')} (revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,'k','s')`,
    [soul, command],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
    [agent, soul, revision],
  );
  await db.platform.query(`UPDATE ${table('tf_agents')} SET saved_revision=$2, display_name='Agent' WHERE id=$1`, [
    agent,
    soul,
  ]);
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'invoke')`,
    [agent, sponsor.membershipId],
  );
  return agent;
}

const linkedin = (channel, text = 'Launching today', media = []) => ({
  channelId: channel.id,
  expectedChannelVersion: channel.version,
  content: { platform: 'linkedin', text, media, visibility: 'public' },
  publishAt: null,
});
const x = (channel, text = 'Launching today') => ({
  channelId: channel.id,
  expectedChannelVersion: channel.version,
  content: { platform: 'x', text, media: [], replySettings: 'everyone' },
  publishAt: null,
});
const tiktok = (channel, media) => ({
  channelId: channel.id,
  expectedChannelVersion: channel.version,
  content: { platform: 'tiktok', caption: 'Launch clip', media },
  publishAt: null,
});
const prepare = (conversationId, variants, commandId = randomUUID()) => ({
  commandId,
  origin: { kind: 'conversation', conversationId, messageId: randomUUID() },
  variants,
});
const sourcesOf = conversationId => ({ dependencies: [{ kind: 'private-conversation', conversationId }] });
const current = post => post.revisions.find(revision => revision.number === post.currentRevision);
const variantFor = (post, channel, number = post.currentRevision) =>
  post.revisions.find(revision => revision.number === number).variants.find(item => item.channelId === channel.id);
const submit = (post, decision = 'approve', reviewChoices) => ({
  postId: post.id,
  expectedRevision: post.currentRevision,
  contentDigest: current(post).contentDigest,
  decision,
  ...(reviewChoices ? { reviewChoices } : {}),
});
const count = async name =>
  Number((await db.platform.query(`SELECT count(*)::int AS n FROM ${table(`tf_social_${name}`)}`)).rows[0].n);

/** What the publisher (slice 5) does when it claims a variant: an attempted step leaves a receipt. */
async function attempt(variant, decisionId) {
  const attemptId = randomUUID();
  await db.platform.query(
    `UPDATE ${table('tf_social_variants')} SET state='sending',attempt_id=$2,next_attempt_at=now()+interval '1 minute',
       step='{"index":0,"kind":"create-post"}' WHERE id=$1`,
    [variant.id, attemptId],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_social_receipts')} (id,variant_id,revision,decision_id,step,attempt_id) VALUES ($1,$2,$3,$4,'create-post',$5)`,
    [randomUUID(), variant.id, variant.revision, decisionId, attemptId],
  );
}

before(async () => {
  db = await fixture();
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    maxPools: 2,
    connectionsPerPool: 4,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => {
      const workspace = db.workspaces.find(candidate => candidate.id === id);
      if (!workspace) throw new Error('unknown-workspace');
      return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
    },
  });
});

// `member` is in the Marketing team; `other` is a member outside it.
beforeEach(async () => {
  ws = await db.create();
  raw = await connect(db.login(ws));
  member = { userId: randomUUID(), membershipId: randomUUID() };
  other = { userId: randomUUID(), membershipId: randomUUID() };
  teamId = randomUUID();
  for (const person of [member, other])
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      person.membershipId,
      person.userId,
    ]);
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Marketing')`, [teamId]);
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    member.membershipId,
    teamId,
  ]);
});

afterEach(async () => {
  await raw?.end();
});

after(async () => {
  await runtime?.close();
  await db?.close();
});

test('PRODUCT 13: each variant is checked against its channel’s rules before it can be submitted for approval', async () => {
  const { posts, personal } = service({
    validate: variant =>
      variant.content.text === 'adapter says no' ? [{ path: ['content', 'text'], code: 'fake-rule' }] : [],
  });
  const profile = await personal('linkedin');
  const handle = await personal('x');
  const conversationId = await chat();
  const image = await file();

  // One variant per channel, each with its platform's fields, checked by the adapter and the content rules.
  const prepared = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile, 'Launching today', [image]), x(handle)]),
    sourcesOf(conversationId),
  );
  assert.equal(postSchema.parse(prepared.post).id, prepared.post.id);
  assert.deepEqual(
    prepared.variants.map(item => item.valid),
    [true, true],
  );
  assert.deepEqual(
    current(prepared.post)
      .variants.map(item => [item.content.platform, item.state])
      .sort(),
    [
      ['linkedin', 'awaiting-approval'],
      ['x', 'awaiting-approval'],
    ],
  );
  assert.equal(prepared.post.authorMembershipId, admin().membershipId);

  // A variant that fails its channel's rules keeps every variant in draft, so the revision cannot be approved.
  const failing = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile, 'adapter says no'), x(handle, 'a'.repeat(281))]),
    sourcesOf(conversationId),
  );
  assert.deepEqual(
    failing.variants.map(item => [item.channelId, item.valid, item.errors.map(error => error.code)]),
    [
      [profile.id, false, ['fake-rule']],
      // The standard 280 limit: no channel reports an X Premium subscription yet.
      [handle.id, false, ['text-too-long']],
    ],
  );
  assert.deepEqual(
    current(failing.post).variants.map(item => item.state),
    ['draft', 'draft'],
  );
  await assert.rejects(posts.decide(ws.id, admin().userId, submit(failing.post)), code('variant-invalid'));

  // A media type the platform cannot take is reported from the File's media type, not the item.
  const pdf = await file(admin(), 'application/pdf');
  const shaped = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile, 'Deck', [pdf])]),
    sourcesOf(conversationId),
  );
  assert.deepEqual(shaped.variants[0].errors, [{ path: ['content', 'media'], code: 'media-shape' }]);
  assert.equal(mediaKind('image/gif'), 'gif');
  assert.equal(mediaKind('video/mp4'), 'video');
  assert.equal(mediaKind('application/pdf'), 'document');
  assert.equal(mediaKind('text/plain'), null);

  // Malformed content and a stale channel version write nothing.
  const before = await count('posts');
  await assert.rejects(
    posts.prepare(
      ws.id,
      admin().userId,
      prepare(conversationId, [linkedin(profile, 'a'.repeat(3001))]),
      sourcesOf(conversationId),
    ),
    zod,
  );
  await assert.rejects(
    posts.prepare(
      ws.id,
      admin().userId,
      prepare(conversationId, [{ ...linkedin(profile), expectedChannelVersion: profile.version + 1 }]),
      sourcesOf(conversationId),
    ),
    code('channel-conflict'),
  );
  // Publishing needs the channel's publish grant.
  await assert.rejects(
    posts.prepare(ws.id, member.userId, prepare(await chat(member), [linkedin(profile)]), sourcesOf(conversationId)),
    deniedAccess,
  );
  assert.equal(await count('posts'), before);

  // Repeating a command returns its post; the same command with other content is refused.
  const commandId = randomUUID();
  const first = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile)], commandId),
    sourcesOf(conversationId),
  );
  const again = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile)], commandId),
    sourcesOf(conversationId),
  );
  assert.equal(again.post.id, first.post.id);
  await assert.rejects(
    posts.prepare(
      ws.id,
      admin().userId,
      prepare(conversationId, [linkedin(profile, 'Different')], commandId),
      sourcesOf(conversationId),
    ),
    code('post-conflict'),
  );
});

test('PRODUCT 14: publishing needs a person’s approval of the exact content, even when an agent wrote it', async () => {
  const { posts, personal } = service();
  const profile = await personal('linkedin');
  const conversationId = await chat();
  const agentId = await savedAgent(admin());
  const agent = { kind: 'agent', agentId, sponsor: admin().userId };

  // An agent prepares through its sponsor's publish grant; the sponsor is the author.
  const { post } = await posts.prepare(
    ws.id,
    agent,
    prepare(conversationId, [linkedin(profile)]),
    sourcesOf(conversationId),
  );
  assert.equal(post.authorMembershipId, admin().membershipId);
  const variant = variantFor(post, profile);
  assert.equal(variant.state, 'awaiting-approval');

  // No path moves a variant towards publishing without an approve decision.
  await assert.rejects(
    db.platform.query(`UPDATE ${table('tf_social_variants')} SET state='scheduled',due_at=now() WHERE id=$1`, [
      variant.id,
    ]),
    /requires an approved revision/,
  );
  await denied(
    raw,
    `INSERT INTO ${table('tf_social_decisions')} (id,post_id,revision,content_digest,batch_digest,decision,decider_membership_id)
     VALUES ('${randomUUID()}','${post.id}',1,'${current(post).contentDigest}','${'a'.repeat(64)}','approve','${admin().membershipId}')`,
  );
  // An agent cannot approve, not even its own sponsor's post.
  await assert.rejects(posts.decide(ws.id, agent, submit(post)), deniedAccess);
  assert.equal(await count('decisions'), 0);

  const approved = await posts.decide(ws.id, admin().userId, submit(post));
  const decision = current(approved).decision;
  assert.equal(decision.decision, 'approve');
  assert.equal(decision.deciderMembershipId, admin().membershipId);
  const scheduled = variantFor(approved, profile);
  assert.equal(scheduled.state, 'scheduled');
  // `dueAt` is the approval time when there is no publish time.
  assert.equal(scheduled.dueAt, decision.decidedAt);
});

test('PRODUCT 15: the variants are approved together as one fixed revision, bound by its digest', async () => {
  const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  const { posts, personal } = service();
  const profile = await personal('linkedin');
  const handle = await personal('x');
  const conversationId = await chat();
  const publishAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const variants = [{ ...linkedin(profile), publishAt }, x(handle)];
  const { post } = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, variants),
    sourcesOf(conversationId),
  );
  const revision = current(post);
  // The digest covers each variant's text, media, target, channel version and publish time.
  assert.equal(
    revision.contentDigest,
    contentDigest(
      variants.map(item => ({
        channelId: item.channelId,
        channelVersion: item.expectedChannelVersion,
        target: null,
        content: item.content,
        publishAt: item.publishAt,
      })),
    ),
  );
  // A revision waits at most until its earliest publish time.
  assert.equal(revision.expiresAt, new Date(publishAt).toISOString());

  // A decision must name the exact current revision and its content digest.
  await assert.rejects(
    posts.decide(ws.id, admin().userId, { ...submit(post), contentDigest: 'f'.repeat(64) }),
    code('revision-conflict'),
  );
  await assert.rejects(
    posts.decide(ws.id, admin().userId, { ...submit(post), expectedRevision: 2 }),
    code('revision-conflict'),
  );
  // An expired revision cannot be decided.
  const expired = service({ now: () => later });
  await assert.rejects(expired.posts.decide(ws.id, admin().userId, submit(post)), code('revision-expired'));

  const approved = await posts.decide(ws.id, admin().userId, submit(post));
  const decision = current(approved).decision;
  assert.equal(decision.batchDigest, batchDigest(revision.contentDigest, []));
  assert.deepEqual(
    current(approved).variants.map(item => item.state),
    ['scheduled', 'scheduled'],
  );
  assert.equal(variantFor(approved, profile).dueAt, new Date(publishAt).toISOString());
  // The same decision again changes nothing; a different one is refused.
  const repeated = await posts.decide(ws.id, admin().userId, submit(post));
  assert.equal(current(repeated).decision.id, decision.id);
  await assert.rejects(posts.decide(ws.id, admin().userId, submit(post, 'reject')), code('post-conflict'));
  assert.equal(await count('decisions'), 1);

  // Every publish attempt records the revision and approval it ran under.
  await attempt(variantFor(approved, handle), decision.id);
  const receipt = variantFor(await posts.get(ws.id, admin().userId, post.id), handle).receipts[0];
  assert.equal(receipt.revision, 1);
  assert.equal(receipt.decisionId, decision.id);
  await assert.rejects(
    db.platform.query(
      `INSERT INTO ${table('tf_social_receipts')} (id,variant_id,revision,decision_id,step,attempt_id) VALUES ($1,$2,2,$3,'create-post',$4)`,
      [randomUUID(), variantFor(approved, profile).id, decision.id, randomUUID()],
    ),
    /approved revision/,
  );
});

test('exit check, PRODUCT 16: revisions are immutable', async () => {
  const { posts, personal } = service();
  const profile = await personal('linkedin');
  const conversationId = await chat();
  const { post } = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile)]),
    sourcesOf(conversationId),
  );
  const approved = await posts.decide(ws.id, admin().userId, submit(post));
  const first = current(approved);

  // The runtime can only add revisions, never change or remove one.
  await denied(
    raw,
    `UPDATE ${table('tf_social_revisions')} SET content_digest='${'a'.repeat(64)}' WHERE post_id='${post.id}'`,
  );
  await denied(raw, `UPDATE ${table('tf_social_revisions')} SET mcp_derived=false WHERE post_id='${post.id}'`);
  await denied(raw, `DELETE FROM ${table('tf_social_revisions')} WHERE post_id='${post.id}'`);
  await denied(raw, `UPDATE ${table('tf_social_decisions')} SET decision='reject' WHERE post_id='${post.id}'`);

  // Changing an approved post writes revision 2, which needs its own approval.
  const edited = await posts.revise(ws.id, admin().userId, post.id, {
    expectedRevision: 1,
    variants: [linkedin(profile, 'Launching tomorrow')],
  });
  assert.equal(edited.post.currentRevision, 2);
  const [one, two] = edited.post.revisions;
  assert.deepEqual(
    { ...one, variants: one.variants.map(item => item.id) },
    { ...first, variants: first.variants.map(item => item.id) },
  );
  assert.equal(one.variants[0].state, 'superseded');
  assert.equal(two.decision, null);
  assert.notEqual(two.contentDigest, one.contentDigest);
  assert.equal(two.variants[0].state, 'awaiting-approval');
  assert.equal(two.variants[0].content.text, 'Launching tomorrow');
  // The old revision can no longer be decided, and a stale edit is refused.
  await assert.rejects(posts.decide(ws.id, admin().userId, submit(post, 'reject')), code('revision-conflict'));
  await assert.rejects(
    posts.revise(ws.id, admin().userId, post.id, { expectedRevision: 1, variants: [linkedin(profile, 'Again')] }),
    code('revision-conflict'),
  );
  // Only the author edits.
  await assert.rejects(
    posts.revise(ws.id, member.userId, post.id, { expectedRevision: 2, variants: [linkedin(profile, 'Mine')] }),
    deniedAccess,
  );
  const reapproved = await posts.decide(ws.id, admin().userId, submit(edited.post));
  assert.equal(variantFor(reapproved, profile).state, 'scheduled');
  assert.equal(current(reapproved).decision.revision, 2);
});

test('exit check, PRODUCT 16: an edit after partial publishing leaves attempted variants alone', async () => {
  const { posts, personal } = service();
  const profile = await personal('linkedin');
  const handle = await personal('x');
  const conversationId = await chat();
  const { post } = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile), x(handle)]),
    sourcesOf(conversationId),
  );
  const approved = await posts.decide(ws.id, admin().userId, submit(post));
  const decision = current(approved).decision;
  // The X variant has been sent; the LinkedIn variant is still scheduled.
  await attempt(variantFor(approved, handle), decision.id);

  // Editing the sent variant is refused.
  await assert.rejects(
    posts.revise(ws.id, admin().userId, post.id, { expectedRevision: 1, variants: [x(handle, 'Fixed typo')] }),
    code('variant-not-editable'),
  );
  const edited = await posts.revise(ws.id, admin().userId, post.id, {
    expectedRevision: 1,
    variants: [linkedin(profile, 'Launching tomorrow')],
  });
  const [one, two] = edited.post.revisions;
  // The new revision covers only the unattempted variant.
  assert.deepEqual(
    two.variants.map(item => [item.channelId, item.state]),
    [[profile.id, 'awaiting-approval']],
  );
  // The sent variant keeps its revision, approval, state and receipt.
  const sent = variantFor(edited.post, handle, 1);
  assert.equal(sent.state, 'sending');
  assert.equal(sent.receipts.length, 1);
  assert.equal(sent.receipts[0].decisionId, decision.id);
  assert.equal(one.decision.id, decision.id);
  assert.equal(variantFor(edited.post, profile, 1).state, 'superseded');
  // An attempted variant can never be superseded.
  await assert.rejects(
    db.platform.query(`UPDATE ${table('tf_social_variants')} SET state='superseded' WHERE id=$1`, [sent.id]),
    /attempted step/,
  );
  // With every variant attempted, there is nothing left to edit.
  const reapproved = await posts.decide(ws.id, admin().userId, submit(edited.post));
  await attempt(variantFor(reapproved, profile), current(reapproved).decision.id);
  await assert.rejects(
    posts.revise(ws.id, admin().userId, post.id, { expectedRevision: 2, variants: [linkedin(profile, 'Late')] }),
    code('variant-not-editable'),
  );
});

test('PRODUCT 17: only a person makes TikTok’s review choices, from the creator’s options, and they are part of the approval', async () => {
  const { posts, personal } = service();
  const account = await personal('tiktok');
  const conversationId = await chat();
  const clip = await file(admin(), 'video/mp4');
  const { post } = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [tiktok(account, [clip])]),
    sourcesOf(conversationId),
  );
  const variant = variantFor(post, account);
  // Every choice is required and none is preselected.
  assert.deepEqual(current(post).reviewChoices, [
    { variantId: variant.id, platform: 'tiktok', required: everyChoice, values: null },
  ]);
  await assert.rejects(posts.decide(ws.id, admin().userId, submit(post)), code('review-choices-invalid'));
  // An agent cannot choose them.
  const agentId = await savedAgent(admin());
  await assert.rejects(
    posts.decide(
      ws.id,
      { kind: 'agent', agentId, sponsor: admin().userId },
      submit(post, 'approve', [{ variantId: variant.id, values: tiktokChoices() }]),
    ),
    deniedAccess,
  );
  // A choice the creator did not offer, or a disabled interaction, is refused.
  await assert.rejects(
    posts.decide(
      ws.id,
      admin().userId,
      submit(post, 'approve', [{ variantId: variant.id, values: tiktokChoices('FOLLOWER_OF_CREATOR') }]),
    ),
    zod,
  );
  await assert.rejects(
    posts.decide(
      ws.id,
      admin().userId,
      submit(post, 'approve', [{ variantId: variant.id, values: { ...tiktokChoices(), allowDuet: true } }]),
    ),
    zod,
  );
  // An unaudited app may only post privately.
  await assert.rejects(
    posts.decide(
      ws.id,
      admin().userId,
      submit(post, 'approve', [{ variantId: variant.id, values: tiktokChoices('PUBLIC_TO_EVERYONE') }]),
    ),
    code('review-choices-invalid'),
  );
  // Choices for a variant that is not in the revision are refused.
  await assert.rejects(
    posts.decide(
      ws.id,
      admin().userId,
      submit(post, 'approve', [
        { variantId: variant.id, values: tiktokChoices() },
        { variantId: randomUUID(), values: tiktokChoices() },
      ]),
    ),
    code('review-choices-invalid'),
  );
  // A rejection carries no choices.
  await assert.rejects(
    posts.decide(ws.id, admin().userId, submit(post, 'reject', [{ variantId: variant.id, values: tiktokChoices() }])),
    zod,
  );
  assert.equal(await count('decisions'), 0);

  const choices = [{ variantId: variant.id, values: tiktokChoices() }];
  const approved = await posts.decide(ws.id, admin().userId, submit(post, 'approve', choices));
  const decision = current(approved).decision;
  assert.deepEqual(decision.reviewChoices, choices);
  assert.equal(decision.batchDigest, batchDigest(current(post).contentDigest, choices));
  // Other choices are a different approval.
  await assert.rejects(
    posts.decide(
      ws.id,
      admin().userId,
      submit(post, 'approve', [{ variantId: variant.id, values: { ...tiktokChoices(), allowComments: false } }]),
    ),
    code('post-conflict'),
  );
});

test('PRODUCT 18: each variant keeps its own state and outcome', async () => {
  const { posts, personal } = service();
  const profile = await personal('linkedin');
  const handle = await personal('x');
  const conversationId = await chat();
  const { post } = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile), x(handle)]),
    sourcesOf(conversationId),
  );
  const approved = await posts.decide(ws.id, admin().userId, submit(post));
  const decision = current(approved).decision;
  // The LinkedIn variant fails; the X variant is published; neither changes the other.
  await attempt(variantFor(approved, profile), decision.id);
  await db.platform.query(`UPDATE ${table('tf_social_variants')} SET state='failed' WHERE id=$1`, [
    variantFor(approved, profile).id,
  ]);
  await attempt(variantFor(approved, handle), decision.id);
  await db.platform.query(
    `UPDATE ${table('tf_social_variants')} SET state='published',platform_post_id='x-1' WHERE id=$1`,
    [variantFor(approved, handle).id],
  );
  const shown = await posts.get(ws.id, admin().userId, post.id);
  assert.deepEqual([variantFor(shown, profile).state, variantFor(shown, handle).state], ['failed', 'published']);
  assert.equal(variantFor(shown, handle).platformPostId, 'x-1');

  // Rejecting a revision cancels only its own unsent variants.
  const second = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile), x(handle)]),
    sourcesOf(conversationId),
  );
  const rejected = await posts.decide(ws.id, admin().userId, submit(second.post, 'reject'));
  assert.equal(current(rejected).decision.decision, 'reject');
  assert.equal(current(rejected).decision.reviewChoices, undefined);
  assert.deepEqual(
    current(rejected).variants.map(item => item.state),
    ['cancelled', 'cancelled'],
  );
  assert.deepEqual(
    current(await posts.get(ws.id, admin().userId, post.id))
      .variants.map(item => item.state)
      .sort(),
    ['failed', 'published'],
  );
});

test('PRODUCT 19: attaching a file does not widen access to it, and the approval binds its bytes', async () => {
  const { posts, sharedPage } = service();
  const page = await sharedPage();
  const conversationId = await chat(member);
  // A File only `other` can read cannot be attached by `member`.
  const hidden = await file(other);
  const prepared = await posts.prepare(
    ws.id,
    member.userId,
    prepare(conversationId, [linkedin(page, 'Photo', [hidden])]),
    sourcesOf(conversationId),
  );
  assert.deepEqual(prepared.variants[0].errors[0], { path: ['content', 'media', 0], code: 'media-unreadable' });
  assert.equal(current(prepared.post).variants[0].state, 'draft');
  // An item whose digest is not the File's current bytes is refused.
  const image = await file(member);
  const stale = await posts.prepare(
    ws.id,
    member.userId,
    prepare(conversationId, [linkedin(page, 'Photo', [{ ...image, contentDigest: 'c'.repeat(64) }])]),
    sourcesOf(conversationId),
  );
  assert.deepEqual(stale.variants[0].errors[0], { path: ['content', 'media', 0], code: 'media-changed' });

  const { post } = await posts.prepare(
    ws.id,
    member.userId,
    prepare(conversationId, [linkedin(page, 'Photo', [image])]),
    sourcesOf(conversationId),
  );
  assert.equal(current(post).variants[0].state, 'awaiting-approval');
  // The bytes changed after preparing: approval is refused.
  await db.platform.query(`UPDATE ${table('tf_files')} SET sha256=$2 WHERE id=$1`, [image.fileId, 'd'.repeat(64)]);
  await assert.rejects(posts.decide(ws.id, member.userId, submit(post)), code('media-changed'));
  await db.platform.query(`UPDATE ${table('tf_files')} SET sha256=$2 WHERE id=$1`, [image.fileId, image.contentDigest]);
  // Approving does not reach a File the approver cannot read.
  await db.platform.query(
    `UPDATE ${table('tf_conversations')} SET owner_user_id=$2,owner_membership_id=$3 WHERE id=$1`,
    [conversationId, other.userId, other.membershipId],
  );
  await assert.rejects(posts.decide(ws.id, other.userId, submit(post)), code('media-unreadable'));
  assert.equal(await count('decisions'), 0);
});

test('PRODUCT 20: a post is approved only by a person who can read every source', async () => {
  const { posts, sharedPage } = service();
  const page = await sharedPage();
  const conversationId = await chat(member);
  const { post } = await posts.prepare(
    ws.id,
    member.userId,
    prepare(conversationId, [linkedin(page)]),
    sourcesOf(conversationId),
  );
  assert.deepEqual(current(post).sources, {
    dependencies: [{ kind: 'private-conversation', conversationId }],
    mcpDerived: false,
    privateTaskDerived: false,
  });
  // `other` may publish to the page but cannot read `member`'s chat: they can neither see nor approve the post.
  await assert.rejects(posts.get(ws.id, other.userId, post.id), deniedAccess);
  await assert.rejects(posts.decide(ws.id, other.userId, submit(post)), code('source-unreadable'));
  assert.equal(await count('decisions'), 0);
  // A source the author cannot read is refused when preparing.
  await assert.rejects(
    posts.prepare(ws.id, other.userId, prepare(conversationId, [linkedin(page)]), sourcesOf(conversationId)),
    code('source-unreadable'),
  );
  const approved = await posts.decide(ws.id, member.userId, submit(post));
  assert.equal(current(approved).decision.deciderMembershipId, member.membershipId);
});

test('exit check, PRODUCT 20: an MCP-derived source blocks approval', async () => {
  const { posts, personal } = service();
  const profile = await personal('linkedin');
  const conversationId = await chat();
  const mcp = { kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 };
  const { post } = await posts.prepare(ws.id, admin().userId, prepare(conversationId, [linkedin(profile)]), {
    dependencies: [{ kind: 'private-conversation', conversationId }, mcp],
  });
  assert.equal(current(post).sources.mcpDerived, true);
  assert.equal(current(post).variants[0].state, 'awaiting-approval');
  await assert.rejects(posts.decide(ws.id, admin().userId, submit(post)), code('source-blocked'));
  // An edit keeps the MCP source, so no later revision can be approved either.
  const edited = await posts.revise(ws.id, admin().userId, post.id, {
    expectedRevision: 1,
    variants: [linkedin(profile, 'Rewritten by hand')],
  });
  assert.equal(current(edited.post).sources.mcpDerived, true);
  await assert.rejects(posts.decide(ws.id, admin().userId, submit(edited.post)), code('source-blocked'));
  assert.equal(await count('decisions'), 0);

  // A private task result blocks approval the same way.
  const task = await posts.prepare(ws.id, admin().userId, prepare(conversationId, [linkedin(profile)]), {
    dependencies: [{ kind: 'private-task', taskId: randomUUID() }],
  });
  assert.equal(current(task.post).sources.privateTaskDerived, true);
  await assert.rejects(posts.decide(ws.id, admin().userId, submit(task.post)), code('source-blocked'));
  // Such a post can still be rejected.
  const rejected = await posts.decide(ws.id, admin().userId, submit(edited.post, 'reject'));
  assert.deepEqual(
    current(rejected).variants.map(item => item.state),
    ['cancelled'],
  );
});

test('PRODUCT 21: the sources are checked again at approval, and kept on every revision for the publish checks', async () => {
  const { posts, personal } = service();
  const profile = await personal('linkedin');
  const conversationId = await chat();
  const { post } = await posts.prepare(
    ws.id,
    admin().userId,
    prepare(conversationId, [linkedin(profile)]),
    sourcesOf(conversationId),
  );
  // An edit adds its own sources to those already recorded.
  const later = await chat();
  const edited = await posts.revise(
    ws.id,
    admin().userId,
    post.id,
    { expectedRevision: 1, variants: [linkedin(profile, 'With more context')] },
    sourcesOf(later),
  );
  assert.deepEqual(current(edited.post).sources.dependencies, [
    { kind: 'private-conversation', conversationId },
    { kind: 'private-conversation', conversationId: later },
  ]);
  // The approver lost access to a source after the post was prepared.
  await db.platform.query(`UPDATE ${table('tf_conversations')} SET deleted_at=now() WHERE id=$1`, [conversationId]);
  await assert.rejects(posts.decide(ws.id, admin().userId, submit(edited.post)), code('source-unreadable'));
  assert.equal(await count('decisions'), 0);
});

test('PRODUCT 39: the schedule lists variants by channel and state, only to people who may publish there and read the post', async () => {
  const { posts, sharedPage } = service();
  const page = await sharedPage();
  const conversationId = await chat(member);
  const { post } = await posts.prepare(
    ws.id,
    member.userId,
    prepare(conversationId, [linkedin(page)]),
    sourcesOf(conversationId),
  );
  // A revision waiting for approval is not on the schedule.
  assert.deepEqual(
    (await posts.schedule(ws.id, member.userId)).channels.map(channel => channel.variants.length),
    [0],
  );
  const approved = await posts.decide(ws.id, member.userId, submit(post));
  const variant = variantFor(approved, page);
  await db.platform.query(
    `UPDATE ${table('tf_social_variants')} SET state='blocked',blocked_reason='account-reconnect' WHERE id=$1`,
    [variant.id],
  );
  const schedule = await posts.schedule(ws.id, member.userId);
  assert.equal(schedule.truncated, false);
  assert.deepEqual(
    schedule.channels.map(channel => ({
      channelId: channel.channelId,
      platform: channel.platform,
      variants: channel.variants.map(item => [item.postId, item.variant.state, item.variant.blockedReason]),
    })),
    [{ channelId: page.id, platform: 'linkedin', variants: [[post.id, 'blocked', 'account-reconnect']] }],
  );
  assert.deepEqual((await posts.schedule(ws.id, member.userId, { states: ['published'] })).channels[0].variants, []);
  // `other` may publish to the page but cannot read the member's chat, so the post's content stays hidden.
  assert.deepEqual(
    (await posts.schedule(ws.id, other.userId)).channels.map(channel => [channel.channelId, channel.variants]),
    [[page.id, []]],
  );
  // The workspace admin holds no grant on the page, so it is not listed at all.
  assert.deepEqual((await posts.schedule(ws.id, admin().userId)).channels, []);
  await assert.rejects(posts.schedule(ws.id, member.userId, { states: ['unknown'] }), zod);
});
