import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { currentMember, protectedSourceClosure, requireProtectedSource } from '@tulipfarm/access';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createSocialAccounts } from '../dist/accounts.js';
import { createSocialChannels } from '../dist/channels.js';
import { variantSchema } from '../dist/contracts.js';
import { createPlatformApps, operatorPlatformApps } from '../dist/platform-apps.js';
import { createFakeAdapter } from '../dist/platforms/fake.js';
import { createSocialPosts } from '../dist/posts.js';
import { createSocialPublisher, dailyCaps, rateLimitRecheckSeconds } from '../dist/publisher.js';

const callbackUrl = 'https://api.example.test/v1/social/oauth/callback';
const keyring = { activeKeyId: 'test', keys: { test: 'ef'.repeat(32) } };
const session = 'test-session';
const operator = (prefix, tier) => ({
  [`${prefix}_CLIENT_ID`]: `${prefix}-client`,
  [`${prefix}_CLIENT_SECRET`]: 'operator-secret',
  [`${prefix}_REDIRECT_URI`]: callbackUrl,
  [`${prefix}_ACCESS_TIER`]: tier,
});
const env = { ...operator('SOCIAL_LINKEDIN', 'community-management'), ...operator('SOCIAL_THREADS', 'standard') };
const code = expected => error => error?.code === expected;
const deniedAccess = error => error?.message === 'Resource not found';
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
  threads: [
    {
      platformChannelId: 'threads-brand',
      channelKind: 'threads-profile',
      displayName: 'Brand',
      handle: 'brand',
      avatarUrl: null,
    },
  ],
};
/** Instagram-style publishing: upload into a container, wait for it, then publish it with a separate call. */
const containerPlan = () => [
  { kind: 'create-container', mode: 'mutate' },
  { kind: 'await', for: 'container-ready', maxSeconds: 600 },
  { kind: 'publish-container', mode: 'mutate' },
];

let db;
let ws;
let runtime;
let member;
let teamId;

const table = name => qualified(ws.names.schema, name);
const admin = () => ({ userId: ws.userId, membershipId: ws.membershipId });

async function requireSources(tx, actor, sources) {
  await currentMember(tx, actor);
  for (const source of await protectedSourceClosure(tx, sources)) await requireProtectedSource(tx, actor, source);
}

function service({ plan, mediaUrl, wrap = adapter => adapter } = {}) {
  const fakes = Object.fromEntries(
    Object.entries(discovered).map(([platform, found]) => [
      platform,
      createFakeAdapter({ platform, scopes: () => ['fake.publish'], ...(plan ? { plan } : {}) })
        .fallback('exchangeCode', {
          accessToken: `${platform}-access`,
          refreshToken: `${platform}-refresh`,
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: ['fake.publish'],
        })
        .fallback('identity', { platformUserId: `${platform}-person`, handle: 'person', displayName: 'Person' })
        .fallback('listChannels', found)
        .fallback('targetRules', { postingAllowed: true, flairRequired: false, flairIds: [] })
        .fallback('reviewChoices', []),
    ]),
  );
  const adapters = Object.fromEntries(Object.entries(fakes).map(([platform, fake]) => [platform, wrap(fake)]));
  const platformApps = createPlatformApps({ operator: operatorPlatformApps(env), callbackUrl });
  const accounts = createSocialAccounts({ runtime, keyring, platformApps, adapters });
  const channels = createSocialChannels({ runtime, accounts, adapters });
  const posts = createSocialPosts({
    runtime,
    accounts,
    channels,
    adapters,
    requireSources,
    resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
  });
  const publisher = createSocialPublisher({
    runtime,
    accounts,
    channels,
    adapters,
    requireSources,
    ...(mediaUrl ? { mediaUrl } : {}),
  });
  const grant = async (user, channel, grants) =>
    channels.setGrants(ws.id, user, channel.id, {
      expectedVersion: (await channels.get(ws.id, user, channel.id)).version,
      publish: none,
      analytics: none,
      engagement: none,
      ...grants,
    });
  /** A channel on the person's own connection that only they may publish to and manage. */
  const connect = async (person, input) => {
    const started = await accounts.begin(ws.id, person.userId, session, { ownership: { kind: 'personal' }, ...input });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    await accounts.complete('platform-code', state, session, person.userId);
    return started.attemptId;
  };
  const personal = async (platform = 'linkedin', person = admin()) => {
    const channel = await channels.add(ws.id, person.userId, {
      accountId: await connect(person, { platform }),
      expectedAccountGeneration: 1,
      platformChannelId: discovered[platform][0].platformChannelId,
    });
    return grant(person.userId, channel, { publish: only(person), manage: only(person) });
  };
  /** The Marketing team's page: `member` publishes to it through the team and manages it. */
  const teamPage = async () => {
    const accountId = await connect(member, {
      platform: 'linkedin',
      ownership: { kind: 'business', owningTeamId: teamId },
    });
    const account = await accounts.status(ws.id, member.userId, accountId);
    await accounts.setGrants(ws.id, member.userId, accountId, {
      expectedVersion: account.grantsVersion,
      memberIds: [member.membershipId],
      teamIds: [],
    });
    const channel = await channels.add(ws.id, member.userId, {
      accountId,
      expectedAccountGeneration: 1,
      platformChannelId: discovered.linkedin[1].platformChannelId,
    });
    return grant(member.userId, channel, { publish: { memberIds: [], teamIds: [teamId] }, manage: only(member) });
  };
  /**
   * Prepares and approves a post from a chat with one variant per content. The sources default to the chat.
   * Returns the variant ids in the order of `contents`.
   */
  const approved = async (person, contents, { origin, sources } = {}) => {
    const conversationId = await chat(person);
    const { post } = await posts.prepare(
      ws.id,
      person.userId,
      {
        commandId: randomUUID(),
        origin: origin ?? { kind: 'conversation', conversationId, messageId: randomUUID() },
        variants: contents,
      },
      sources ?? { dependencies: [{ kind: 'private-conversation', conversationId }] },
    );
    const revision = post.revisions.find(item => item.number === post.currentRevision);
    await posts.decide(ws.id, person.userId, {
      postId: post.id,
      expectedRevision: post.currentRevision,
      contentDigest: revision.contentDigest,
      decision: 'approve',
    });
    const ids = contents.map(content => revision.variants.find(item => item.channelId === content.channelId).id);
    return { post, conversationId, ids, id: ids[0] };
  };
  return { fakes, accounts, channels, posts, publisher, personal, teamPage, approved };
}

async function chat(person = admin()) {
  const id = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
    [id, person.userId, person.membershipId],
  );
  return id;
}
async function file(person = admin()) {
  const id = randomUUID();
  const sha256 = createHash('sha256').update(id).digest('hex');
  await db.platform.query(
    `INSERT INTO ${table('tf_files')} (id,kind,creator_membership_id,name,object_key,media_type,size,sha256,ready)
     VALUES ($1,'file',$2,'media',$3,'image/png',10,$4,true)`,
    [id, person.membershipId, randomUUID(), sha256],
  );
  return { fileId: id, contentDigest: sha256, role: 'primary' };
}

const linkedin = (channel, { text = 'Launching today', media = [], publishAt = null } = {}) => ({
  channelId: channel.id,
  expectedChannelVersion: channel.version,
  content: { platform: 'linkedin', text, media, visibility: 'public' },
  publishAt,
});
const threads = channel => ({
  channelId: channel.id,
  expectedChannelVersion: channel.version,
  content: { platform: 'threads', text: 'Launching today', media: [], replyControl: 'everyone' },
  publishAt: null,
});

const variant = async id =>
  (
    await db.platform.query(
      `SELECT state,step,blocked_reason,recheck_at,attempt_id,next_attempt_at,platform_refs,platform_post_id,permalink,
              due_at,recheck_at > now() + interval '1 minute' AS recheck_later
         FROM ${table('tf_social_variants')} WHERE id=$1`,
      [id],
    )
  ).rows[0];
const receipts = async id =>
  (
    await db.platform.query(
      `SELECT r.revision,r.decision_id,r.step,r.attempt_id,r.status,r.settled_at IS NOT NULL AS settled,r.platform_refs,
              r.platform_post_id,r.error_class,r.error_code,v.channel_id,d.post_id
         FROM ${table('tf_social_receipts')} r
         JOIN ${table('tf_social_variants')} v ON v.id=r.variant_id
         JOIN ${table('tf_social_decisions')} d ON d.id=r.decision_id
        WHERE r.variant_id=$1 ORDER BY r.started_at`,
      [id],
    )
  ).rows;
/** Moves a variant's clocks into the past, as if the sweep ran later. */
async function later(id, column = 'next_attempt_at') {
  await db.platform.query(
    `UPDATE ${table('tf_social_variants')} SET ${column}=${column}-interval '1 day' WHERE id=$1`,
    [id],
  );
}
const calls = (fake, method) => fake.calls.filter(call => call.method === method);
const state = async id => (await variant(id)).state;

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

// `member` is in the Marketing team.
beforeEach(async () => {
  ws = await db.create();
  member = { userId: randomUUID(), membershipId: randomUUID() };
  teamId = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member.membershipId,
    member.userId,
  ]);
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Marketing')`, [teamId]);
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    member.membershipId,
    teamId,
  ]);
});

after(async () => {
  await runtime?.close();
  await db?.close();
});

test('exit check, PRODUCT 22: an approved post is published for its approver, immediately or at its publish time', async () => {
  const { fakes, publisher, personal, approved } = service();
  const fake = fakes.linkedin;
  const profile = await personal();
  fake.script('mutate', { kind: 'published', platformPostId: 'li-1', permalink: 'https://linkedin.example/li-1' });
  const now = await approved(admin(), [linkedin(profile)]);
  assert.equal(await state(now.id), 'scheduled');

  await publisher.sweep(ws.id);
  const published = await variant(now.id);
  assert.equal(published.state, 'published');
  assert.equal(published.platform_post_id, 'li-1');
  assert.equal(published.permalink, 'https://linkedin.example/li-1');
  const [sent] = calls(fake, 'mutate');
  assert.deepEqual(sent.args[0], { kind: 'create-post', mode: 'mutate' });
  assert.equal(sent.args[1].variant.id, now.id);
  assert.equal(sent.args[1].attemptId, published.attempt_id);
  assert.equal(sent.args[1].idempotencyKey, `${now.id}:create-post`);
  assert.equal(sent.args[1].token.accessToken, 'linkedin-access');

  // A scheduled variant waits for its publish time.
  const publishAt = new Date(Date.now() + 3_600_000).toISOString();
  const scheduled = await approved(admin(), [linkedin(profile, { text: 'Tomorrow', publishAt })]);
  await publisher.sweep(ws.id);
  assert.equal(await state(scheduled.id), 'scheduled');
  assert.equal(calls(fake, 'mutate').length, 1);
  fake.script('mutate', { kind: 'published', platformPostId: 'li-2', permalink: null });
  await later(scheduled.id, 'due_at');
  await publisher.sweep(ws.id);
  assert.equal(await state(scheduled.id), 'published');
  assert.equal(calls(fake, 'mutate').length, 2);

  // Done is final: another sweep sends nothing.
  await publisher.sweep(ws.id);
  assert.equal(calls(fake, 'mutate').length, 2);
  const view = await publisher.candidates(ws.id, admin().userId, now.id).catch(error => error);
  assert.equal(view.code, 'variant-conflict');
});

test('PRODUCT 22: the sponsor, grant, connection, sources and origin are checked before every changing step', async () => {
  const { fakes, publisher, personal, teamPage, approved } = service();
  const fake = fakes.linkedin;
  // The member publishes to the Marketing page through the team's grant.
  const profile = await teamPage();
  const contents = [linkedin(profile)];

  const deletedChat = await approved(member, contents);
  await db.platform.query(`UPDATE ${table('tf_conversations')} SET deleted_at=now() WHERE id=$1`, [
    deletedChat.conversationId,
  ]);
  const sourceChat = await chat(member);
  const lostSource = await approved(member, contents, {
    sources: { dependencies: [{ kind: 'private-conversation', conversationId: sourceChat }] },
  });
  await db.platform.query(`UPDATE ${table('tf_conversations')} SET deleted_at=now() WHERE id=$1`, [sourceChat]);
  // Task and Workflow origins are checked against their task and activation, or their run.
  const missingTask = await approved(member, contents, {
    origin: { kind: 'task', taskId: randomUUID(), generation: 0 },
  });
  const missingRun = await approved(member, contents, {
    origin: { kind: 'workflow-run', runId: randomUUID(), stepId: 'post' },
  });
  await publisher.sweep(ws.id);
  assert.equal((await variant(deletedChat.id)).blocked_reason, 'origin-revoked');
  assert.equal((await variant(lostSource.id)).blocked_reason, 'source-lost');
  assert.equal((await variant(missingTask.id)).blocked_reason, 'origin-revoked');
  assert.equal((await variant(missingRun.id)).blocked_reason, 'origin-revoked');
  assert.equal(calls(fake, 'mutate').length, 0);
  assert.equal((await receipts(deletedChat.id)).length, 0);

  // The grant came through a team the sponsor has since left.
  const leftTeam = await approved(member, contents);
  await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1`, [member.membershipId]);
  await publisher.sweep(ws.id);
  assert.equal((await variant(leftTeam.id)).blocked_reason, 'grant-removed');
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    member.membershipId,
    teamId,
  ]);

  // The connection is rejected while the step is sent: nothing reached the platform, so the variant blocks.
  const gone = await approved(member, contents);
  await db.platform.query(`UPDATE ${table('tf_social_variants')} SET due_at=now()+interval '1 hour' WHERE id=$1`, [
    gone.id,
  ]);
  fake.script('mutate', { throw: 'reconnect', phase: 'before-send' });
  const rejectedToken = await approved(member, contents);
  await publisher.sweep(ws.id);
  assert.equal((await variant(rejectedToken.id)).blocked_reason, 'account-reconnect');
  assert.deepEqual(
    (await receipts(rejectedToken.id)).map(item => [item.status, item.error_class]),
    [['failed', 'reconnect']],
  );

  // A changed channel blocks a variant approved for the old version.
  const changed = await approved(admin(), [threads(await personal('threads'))]);
  const adminChannel = (
    await db.platform.query(`SELECT channel_id FROM ${table('tf_social_variants')} WHERE id=$1`, [changed.id])
  ).rows[0].channel_id;
  await db.platform.query(`UPDATE ${table('tf_social_channels')} SET version=version+1 WHERE id=$1`, [adminChannel]);
  await publisher.sweep(ws.id);
  assert.equal((await variant(changed.id)).blocked_reason, 'channel-changed');

  // The sponsor left the workspace.
  await later(gone.id, 'due_at');
  await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [member.membershipId]);
  await publisher.sweep(ws.id);
  assert.equal((await variant(gone.id)).blocked_reason, 'sponsor-removed');
  assert.equal(calls(fake, 'mutate').length, 1);
});

test('exit check, PRODUCT 23: a multi-step publish sends each changing step once and only polls processing', async () => {
  const { fakes, publisher, personal, approved } = service({ plan: containerPlan });
  const fake = fakes.linkedin;
  const profile = await personal();
  fake
    .script('mutate', { kind: 'done', platformRefs: { containerId: 'container-1' } })
    .script('status', { kind: 'pending', pollAfterSeconds: 30 }, { kind: 'ready' })
    .script('mutate', { kind: 'published', platformPostId: 'post-1', permalink: null });
  const { id } = await approved(admin(), [linkedin(profile)]);

  await publisher.sweep(ws.id);
  const waiting = await variant(id);
  assert.equal(waiting.state, 'processing');
  assert.deepEqual(waiting.step, { index: 1, kind: 'await' });
  assert.deepEqual(waiting.platform_refs, { containerId: 'container-1' });
  assert.equal(calls(fake, 'mutate').length, 1);
  assert.equal(calls(fake, 'status').length, 1);
  // Polling waits for the platform's hint before it asks again.
  await publisher.sweep(ws.id);
  assert.equal(calls(fake, 'status').length, 1);

  await later(id);
  await publisher.sweep(ws.id);
  assert.equal(await state(id), 'published');
  assert.deepEqual(
    calls(fake, 'mutate').map(call => [call.args[0].kind, call.args[1].platformRefs]),
    [
      ['create-container', {}],
      ['publish-container', { containerId: 'container-1' }],
    ],
  );
  assert.equal(calls(fake, 'status').length, 2);
  assert.deepEqual(calls(fake, 'status')[1].args[1].platformRefs, { containerId: 'container-1' });
  assert.deepEqual(
    (await receipts(id)).map(item => [item.step, item.status]),
    [
      ['create-container', 'succeeded'],
      ['publish-container', 'succeeded'],
    ],
  );
});

test('PRODUCT 23: a step whose lease ran out is unknown and never sent again; only its own late result settles it', async () => {
  let publisher;
  const {
    fakes,
    publisher: sweeper,
    personal,
    approved,
  } = service({
    wrap: fake => ({
      ...fake,
      async mutate(step, input) {
        // The step outlives its lease, and another sweep runs meanwhile.
        await db.platform.query(
          `UPDATE ${table('tf_social_variants')} SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,
          [input.variant.id],
        );
        await publisher.sweep(ws.id);
        return fake.mutate(step, input);
      },
    }),
  });
  publisher = sweeper;
  const fake = fakes.linkedin;
  const profile = await personal();
  fake.fallback('reconcile', { kind: 'unknown' });
  fake.script('mutate', { kind: 'published', platformPostId: 'late', permalink: null });
  const { id } = await approved(admin(), [linkedin(profile)]);
  await publisher.sweep(ws.id);
  // The receipt keeps what the sweep knew when the lease ran out; the platform's own answer settles the variant.
  assert.deepEqual(
    (await receipts(id)).map(item => [item.status, item.error_code]),
    [['outcome-unknown', 'lease-expired']],
  );
  const settled = await variant(id);
  assert.equal(settled.state, 'published');
  assert.equal(settled.platform_post_id, 'late');
  assert.equal(calls(fake, 'mutate').length, 1);

  // Without a late answer, an expired lease leaves the outcome unknown and the step is not sent again.
  fake.script('mutate', { throw: 'retry', phase: 'before-send' });
  const lost = await approved(admin(), [linkedin(profile, { text: 'Lost' })]);
  await publisher.sweep(ws.id);
  assert.equal(await state(lost.id), 'outcome-unknown');
  await later(lost.id);
  await publisher.sweep(ws.id);
  assert.equal(await state(lost.id), 'outcome-unknown');
  assert.equal(calls(fake, 'mutate').length, 2);
});

test('exit check, PRODUCT 24: an unknown final step is never retried and settles only on its own platform evidence', async () => {
  const { fakes, publisher, personal, approved } = service({
    plan: () => [
      { kind: 'create-container', mode: 'mutate' },
      { kind: 'publish-container', mode: 'mutate' },
    ],
  });
  const fake = fakes.linkedin;
  const profile = await personal();
  fake.script(
    'mutate',
    { kind: 'done', platformRefs: { containerId: 'c-found' } },
    { throw: 'unknown', phase: 'after-send' },
    { kind: 'done', platformRefs: { containerId: 'c-absent' } },
    { throw: 'unknown', phase: 'after-send' },
  );
  const found = await approved(admin(), [linkedin(profile, { text: 'Found' })]);
  const absent = await approved(admin(), [linkedin(profile, { text: 'Absent' })]);
  await publisher.sweep(ws.id);
  for (const { id } of [found, absent]) {
    assert.equal(await state(id), 'outcome-unknown');
    assert.deepEqual(
      (await receipts(id)).map(item => [item.step, item.status]),
      [
        ['create-container', 'succeeded'],
        ['publish-container', 'outcome-unknown'],
      ],
    );
  }
  assert.equal(calls(fake, 'mutate').length, 4);

  // No evidence yet: the variant keeps waiting, and the step is never sent again.
  fake.script('reconcile', { kind: 'unknown' }, { kind: 'unknown' });
  await later(found.id);
  await later(absent.id);
  await publisher.sweep(ws.id);
  assert.equal(calls(fake, 'reconcile').length, 2);
  assert.equal(await state(found.id), 'outcome-unknown');

  // Evidence tied to the attempt's own container settles it either way.
  fake.script(
    'reconcile',
    { kind: 'found', platformPostId: 'post-found', evidence: 'platform-ref' },
    { kind: 'absent', evidence: 'platform-ref' },
  );
  await later(found.id);
  await later(absent.id);
  await publisher.sweep(ws.id);
  assert.equal((await variant(found.id)).platform_post_id, 'post-found');
  assert.equal(await state(found.id), 'published');
  assert.equal(await state(absent.id), 'not-published');
  const read = calls(fake, 'reconcile').find(call => call.args[0].variant.id === found.id).args[0];
  assert.equal(read.step, 'publish-container');
  assert.deepEqual(read.platformRefs, { containerId: 'c-found' });
  assert.equal(read.idempotencyKey, `${found.id}:publish-container`);
  assert.equal(read.idempotencyKey, calls(fake, 'mutate')[1].args[1].idempotencyKey);
  assert.equal(calls(fake, 'mutate').length, 4);
});

test('exit check, PRODUCT 24: a similar-looking post is only a candidate for a person to confirm', async () => {
  const { fakes, publisher, personal, approved } = service();
  const fake = fakes.linkedin;
  const profile = await personal();
  const candidate = {
    platformPostId: 'similar-1',
    permalink: 'https://linkedin.example/similar-1',
    createdAt: '2026-01-01T00:00:00Z',
  };
  fake.script('mutate', { throw: 'unknown', phase: 'after-send' }, { throw: 'unknown', phase: 'after-send' });
  fake.fallback('reconcile', { kind: 'candidates', items: [candidate] });
  const confirmed = await approved(admin(), [linkedin(profile, { text: 'Confirmed' })]);
  const denied = await approved(admin(), [linkedin(profile, { text: 'Denied' })]);
  await publisher.sweep(ws.id);
  await later(confirmed.id);
  await publisher.sweep(ws.id);
  assert.equal(await state(confirmed.id), 'outcome-unknown');
  assert.ok(calls(fake, 'reconcile').length >= 1);

  assert.deepEqual(await publisher.candidates(ws.id, admin().userId, confirmed.id), {
    kind: 'candidates',
    items: [candidate],
  });
  // Only someone who may publish to the channel reviews or settles it.
  await assert.rejects(publisher.candidates(ws.id, member.userId, confirmed.id), deniedAccess);
  await assert.rejects(
    publisher.settle(ws.id, member.userId, { variantId: confirmed.id, settlement: 'not-published' }),
    deniedAccess,
  );
  // A post id the platform does not offer is refused.
  await assert.rejects(
    publisher.settle(ws.id, admin().userId, {
      variantId: confirmed.id,
      settlement: 'published',
      platformPostId: 'made-up',
    }),
    code('settlement-unconfirmed'),
  );
  const settled = variantSchema.parse(
    await publisher.settle(ws.id, admin().userId, {
      variantId: confirmed.id,
      settlement: 'published',
      platformPostId: 'similar-1',
    }),
  );
  assert.equal(settled.state, 'published');
  assert.equal(settled.platformPostId, 'similar-1');
  assert.equal(settled.permalink, candidate.permalink);
  const rejected = await publisher.settle(ws.id, admin().userId, { variantId: denied.id, settlement: 'not-published' });
  assert.equal(rejected.state, 'not-published');
  await assert.rejects(
    publisher.settle(ws.id, admin().userId, { variantId: denied.id, settlement: 'not-published' }),
    code('variant-conflict'),
  );
  assert.equal(calls(fake, 'mutate').length, 2);
  const audit = await db.platform.query(
    `SELECT operation FROM ${table('tf_audit_events')} WHERE operation LIKE 'social-post.settle%' ORDER BY operation`,
  );
  assert.deepEqual(
    audit.rows.map(row => row.operation),
    ['social-post.settle.not-published', 'social-post.settle.published'],
  );
});

test('PRODUCT 25: a temporary cause such as a daily cap or rate limit is checked again automatically', async () => {
  const { fakes, publisher, personal, approved } = service();
  const page = await personal('threads');
  const fake = fakes.threads;
  const { limit } = dailyCaps.threads;
  // An earlier post already used the channel's whole daily cap of published containers.
  const used = await approved(admin(), [threads(page)]);
  await db.platform.query(`UPDATE ${table('tf_social_variants')} SET state='cancelled' WHERE id=$1`, [used.id]);
  const decision = (
    await db.platform.query(`SELECT id FROM ${table('tf_social_decisions')} WHERE post_id=$1`, [used.post.id])
  ).rows[0].id;
  await db.platform.query(
    `INSERT INTO ${table('tf_social_receipts')} (id,variant_id,revision,decision_id,step,attempt_id)
     SELECT gen_random_uuid(),$1,1,$2,'publish-container',gen_random_uuid() FROM generate_series(1,$3::int)`,
    [used.id, decision, limit],
  );
  const earlier = await approved(admin(), [threads(page)]);
  fake.plan = () => [{ kind: 'publish-container', mode: 'mutate' }];
  await publisher.sweep(ws.id);
  const capped = await variant(earlier.id);
  assert.equal(capped.state, 'blocked');
  assert.equal(capped.blocked_reason, 'daily-cap');
  assert.equal(capped.recheck_later, true);
  assert.equal(calls(fake, 'mutate').length, 0);

  // Rechecked while still capped, it stays blocked; once the cap frees up it is sent.
  await later(earlier.id, 'recheck_at');
  await publisher.sweep(ws.id);
  assert.equal((await variant(earlier.id)).blocked_reason, 'daily-cap');
  await db.platform.query(
    `UPDATE ${table('tf_social_receipts')} SET status='failed',settled_at=now(),error_class='rejected',error_code='test'
      WHERE variant_id=$1`,
    [used.id],
  );
  fake.script('mutate', { kind: 'published', platformPostId: 'threads-1', permalink: null });
  await later(earlier.id, 'recheck_at');
  await publisher.sweep(ws.id);
  assert.equal(await state(earlier.id), 'published');

  // A rate limit refused before sending blocks for a while, then the step is sent.
  fake.script(
    'mutate',
    { throw: 'rate-limited', phase: 'before-send' },
    { kind: 'published', platformPostId: 'threads-2', permalink: null },
  );
  const limited = await approved(admin(), [threads(page)]);
  await publisher.sweep(ws.id);
  const blocked = await variant(limited.id);
  assert.equal(blocked.blocked_reason, 'rate-limited');
  const seconds = (blocked.recheck_at.getTime() - Date.now()) / 1000;
  assert.ok(seconds > rateLimitRecheckSeconds - 60 && seconds <= rateLimitRecheckSeconds + 5, String(seconds));
  await publisher.sweep(ws.id);
  assert.equal(await state(limited.id), 'blocked');
  await later(limited.id, 'recheck_at');
  await publisher.sweep(ws.id);
  assert.equal(await state(limited.id), 'published');
  assert.deepEqual(
    (await receipts(limited.id)).map(item => [item.status, item.error_class]),
    [
      ['failed', 'rate-limited'],
      ['succeeded', null],
    ],
  );
});

test('exit check, PRODUCT 25: a lost grant waits for a person to resume or cancel, and is cancelled after 7 days', async () => {
  const { fakes, publisher, teamPage, approved } = service();
  const fake = fakes.linkedin;
  fake.fallback('mutate', { kind: 'published', platformPostId: 'resumed', permalink: null });
  const profile = await teamPage();
  const resumed = await approved(member, [linkedin(profile, { text: 'Resumed' })]);
  const cancelled = await approved(member, [linkedin(profile, { text: 'Cancelled' })]);
  const expired = await approved(member, [linkedin(profile, { text: 'Expired' })]);
  await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1`, [member.membershipId]);
  await publisher.sweep(ws.id);
  for (const { id } of [resumed, cancelled, expired]) assert.equal((await variant(id)).blocked_reason, 'grant-removed');

  // A lost grant is not rechecked on its own, and someone without the grant cannot resume it.
  await publisher.sweep(ws.id);
  assert.equal(await state(resumed.id), 'blocked');
  const command = id => ({ variantId: id, expectedState: 'blocked' });
  await assert.rejects(publisher.resume(ws.id, member.userId, command(resumed.id)), deniedAccess);
  await assert.rejects(publisher.resume(ws.id, admin().userId, command(resumed.id)), deniedAccess);

  // The grant is restored and the member resumes the variant; every check runs again before it is due.
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    member.membershipId,
    teamId,
  ]);
  assert.equal((await publisher.resume(ws.id, member.userId, command(resumed.id))).state, 'scheduled');
  await assert.rejects(publisher.resume(ws.id, member.userId, command(resumed.id)), code('variant-conflict'));
  await publisher.sweep(ws.id);
  assert.equal(await state(resumed.id), 'published');

  // Resuming while a check still fails keeps the variant blocked with the current reason.
  await db.platform.query(`UPDATE ${table('tf_conversations')} SET deleted_at=now() WHERE id=$1`, [
    cancelled.conversationId,
  ]);
  const still = await publisher.resume(ws.id, member.userId, command(cancelled.id));
  assert.equal(still.state, 'blocked');
  assert.equal(still.blockedReason, 'origin-revoked');
  assert.equal((await publisher.cancel(ws.id, member.userId, command(cancelled.id))).state, 'cancelled');

  // Nobody acted on the third variant within 7 days of its publish time.
  await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1`, [member.membershipId]);
  await publisher.sweep(ws.id);
  assert.equal(await state(expired.id), 'blocked');
  await db.platform.query(
    `UPDATE ${table('tf_social_variants')} SET due_at=now()-interval '7 days 1 minute' WHERE id=$1`,
    [expired.id],
  );
  await publisher.sweep(ws.id);
  const lapsed = await variant(expired.id);
  assert.equal(lapsed.state, 'cancelled');
  assert.equal(lapsed.blocked_reason, null);
  assert.equal(calls(fake, 'mutate').length, 1);
  const audit = await db.platform.query(
    `SELECT operation FROM ${table('tf_audit_events')} WHERE operation IN ('social-post.resume','social-post.cancel')`,
  );
  assert.deepEqual(audit.rows.map(row => row.operation).sort(), [
    'social-post.cancel',
    'social-post.resume',
    'social-post.resume',
  ]);
});

test('PRODUCT 25: an expired revision that nobody decided is cancelled', async () => {
  const { publisher, posts, personal } = service();
  const profile = await personal();
  const conversationId = await chat();
  const { post } = await posts.prepare(
    ws.id,
    admin().userId,
    {
      commandId: randomUUID(),
      origin: { kind: 'conversation', conversationId, messageId: randomUUID() },
      variants: [linkedin(profile)],
    },
    { dependencies: [{ kind: 'private-conversation', conversationId }] },
  );
  await db.platform.query(
    `UPDATE ${table('tf_social_revisions')} SET expires_at=now()-interval '1 second' WHERE post_id=$1`,
    [post.id],
  );
  await publisher.sweep(ws.id);
  const { rows } = await db.platform.query(`SELECT state FROM ${table('tf_social_variants')} WHERE post_id=$1`, [
    post.id,
  ]);
  assert.deepEqual(
    rows.map(row => row.state),
    ['cancelled'],
  );
});

test('PRODUCT 26: each attempt leaves a receipt with the revision, approval, channel, platform ids and outcome', async () => {
  const issued = [];
  const { fakes, publisher, personal, approved } = service({
    plan: () => [
      { kind: 'upload-media', mode: 'mutate' },
      { kind: 'create-post', mode: 'mutate' },
    ],
    // The platform pulls the bound File through a short-lived URL issued for this attempt.
    mediaUrl: async grant => {
      issued.push(grant);
      return new URL(`https://media.example.test/${grant.fileId}`);
    },
    wrap: fake => ({
      ...fake,
      async mutate(step, input) {
        const [media] = input.variant.content.media;
        if (step.kind === 'upload-media' && media) await input.mediaUrl(media.fileId);
        return fake.mutate(step, input);
      },
    }),
  });
  const fake = fakes.linkedin;
  const profile = await personal();
  fake.script(
    'mutate',
    { kind: 'done', platformRefs: { asset: 'urn:li:asset:1' } },
    { kind: 'published', platformPostId: 'urn:li:share:1', permalink: null },
    { kind: 'rejected', code: 'duplicate-post' },
  );
  const image = await file();
  const { id, post } = await approved(admin(), [linkedin(profile, { media: [image] })]);
  await publisher.sweep(ws.id);
  assert.equal(await state(id), 'published');
  const [upload, create] = await receipts(id);
  const decision = (
    await db.platform.query(`SELECT id FROM ${table('tf_social_decisions')} WHERE post_id=$1`, [post.id])
  ).rows[0].id;
  for (const receipt of [upload, create]) {
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.decision_id, decision);
    assert.equal(receipt.channel_id, profile.id);
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.settled, true);
  }
  assert.deepEqual(upload.platform_refs, { asset: 'urn:li:asset:1' });
  assert.equal(create.platform_post_id, 'urn:li:share:1');
  assert.equal(issued.length, 1);
  assert.equal(issued[0].fileId, image.fileId);
  assert.equal(issued[0].contentDigest, image.contentDigest);
  assert.equal(issued[0].step, 'upload-media');
  assert.equal(issued[0].attemptId, upload.attempt_id);
  assert.ok(issued[0].expiresAt.getTime() <= Date.now() + fake.mediaUrlTtlSeconds * 1000);

  // A refused step is a failed receipt and a failed variant.
  const refused = await approved(admin(), [linkedin(profile, { text: 'Refused' })]);
  await publisher.sweep(ws.id);
  assert.equal(await state(refused.id), 'failed');
  assert.deepEqual(
    (await receipts(refused.id)).map(item => [item.step, item.status, item.error_class, item.error_code]),
    [['upload-media', 'failed', 'rejected', 'duplicate-post']],
  );
});

test('PRODUCT 19: media is only pulled through a URL issued for the attempt, and none means the variant blocks', async () => {
  const { fakes, publisher, personal, approved } = service({
    wrap: fake => ({
      ...fake,
      async mutate(step, input) {
        await input.mediaUrl(input.variant.content.media[0].fileId);
        return fake.mutate(step, input);
      },
    }),
  });
  const profile = await personal();
  const { id } = await approved(admin(), [linkedin(profile, { media: [await file()] })]);
  await publisher.sweep(ws.id);
  const blocked = await variant(id);
  assert.equal(blocked.blocked_reason, 'media-unreadable');
  assert.equal(calls(fakes.linkedin, 'mutate').length, 0);
  assert.deepEqual(
    (await receipts(id)).map(item => item.status),
    ['failed'],
  );
});
