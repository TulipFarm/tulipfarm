import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { createSocialAccounts } from '@tulipfarm/social/accounts';
import { createSocialChannels } from '@tulipfarm/social/channels';
import { createPlatformApps, operatorPlatformApps } from '@tulipfarm/social/platform-apps';
import { createSocialPosts } from '@tulipfarm/social/posts';
import { createFakeAdapter } from '@tulipfarm/social/testing/fake';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createSocialPublisherComposition } from '../src/social-publisher-composition.ts';

const callbackUrl = 'https://api.example.test/v1/social/oauth/callback';
const env = {
  INTEGRATION_CREDENTIAL_KEY_ID: 'social-worker',
  INTEGRATION_CREDENTIAL_KEY: 'ef'.repeat(32),
  SOCIAL_LINKEDIN_CLIENT_ID: 'linkedin-client',
  SOCIAL_LINKEDIN_CLIENT_SECRET: 'operator-secret',
  SOCIAL_LINKEDIN_REDIRECT_URI: callbackUrl,
  SOCIAL_LINKEDIN_ACCESS_TIER: 'community-management',
};
const keyring = { activeKeyId: 'social-worker', keys: { 'social-worker': 'ef'.repeat(32) } };
const only = membershipId => ({ memberIds: [membershipId], teamIds: [] });
const none = { memberIds: [], teamIds: [] };

let db;
let runtime;

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

after(async () => {
  await runtime?.close();
  await db?.close();
});

/** A workspace with one approved LinkedIn post due now, on a token that is inside its refresh window. */
async function approvedPost(fake) {
  const ws = await db.create();
  const adapters = { linkedin: fake };
  const accounts = createSocialAccounts({
    runtime,
    keyring,
    platformApps: createPlatformApps({ operator: operatorPlatformApps(env), callbackUrl }),
    adapters,
  });
  const channels = createSocialChannels({ runtime, accounts, adapters });
  const posts = createSocialPosts({
    runtime,
    accounts,
    channels,
    adapters,
    requireSources: requireDraftSources,
    resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
  });
  const started = await accounts.begin(ws.id, ws.userId, 'session', {
    platform: 'linkedin',
    ownership: { kind: 'personal' },
  });
  await accounts.complete('code', new URL(started.authorizationUrl).searchParams.get('state'), 'session', ws.userId);
  const added = await channels.add(ws.id, ws.userId, {
    accountId: started.attemptId,
    expectedAccountGeneration: 1,
    platformChannelId: 'urn:li:person:founder',
  });
  const channel = await channels.setGrants(ws.id, ws.userId, added.id, {
    expectedVersion: added.grantsVersion,
    publish: only(ws.membershipId),
    analytics: none,
    engagement: none,
    manage: only(ws.membershipId),
  });
  const conversationId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${qualified(ws.names.schema, 'tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
    [conversationId, ws.userId, ws.membershipId],
  );
  const { post } = await posts.prepare(
    ws.id,
    ws.userId,
    {
      commandId: randomUUID(),
      origin: { kind: 'conversation', conversationId, messageId: randomUUID() },
      variants: [
        {
          channelId: channel.id,
          expectedChannelVersion: channel.version,
          content: { platform: 'linkedin', text: 'From the worker', media: [], visibility: 'public' },
          publishAt: null,
        },
      ],
    },
    { dependencies: [{ kind: 'private-conversation', conversationId }] },
  );
  const [revision] = post.revisions;
  await posts.decide(ws.id, ws.userId, {
    postId: post.id,
    expectedRevision: 1,
    contentDigest: revision.contentDigest,
    decision: 'approve',
  });
  // The token now nears its expiry, inside every refresh window.
  await db.platform.query(
    `UPDATE ${qualified(ws.names.schema, 'tf_social_accounts')} SET expires_at=clock_timestamp()+interval '30 seconds'`,
  );
  return { ws, variantId: revision.variants[0].id, calls: fake.calls.length };
}

function linkedinFake() {
  return createFakeAdapter({ platform: 'linkedin', scopes: () => ['fake.publish'] })
    .fallback('exchangeCode', {
      accessToken: 'linkedin-access',
      refreshToken: 'linkedin-refresh',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['fake.publish'],
    })
    .fallback('identity', { platformUserId: 'person', handle: 'person', displayName: 'Person' })
    .fallback('listChannels', [
      {
        platformChannelId: 'urn:li:person:founder',
        channelKind: 'member-profile',
        displayName: 'Founder',
        handle: 'founder',
        avatarUrl: null,
      },
    ])
    .fallback('refresh', {
      accessToken: 'linkedin-access-2',
      refreshToken: 'linkedin-refresh-2',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['fake.publish'],
    })
    .fallback('targetRules', { postingAllowed: true, flairRequired: false, flairIds: [] })
    .fallback('mutate', { kind: 'published', platformPostId: 'urn:li:share:1', permalink: null });
}

async function publisherFor(ws, fake, flag) {
  const composition = createSocialPublisherComposition({
    runtime,
    discover: async cursor => (cursor ? [] : [ws.id]),
    adapters: { linkedin: fake },
    env: { ...env, FEATURE_FLAG_SOCIAL_PUBLISHING: flag },
    intervalMs: 3_600_000,
  });
  assert.ok(composition);
  await composition.runOnce();
  await composition.close();
}
const variantState = async (ws, id) =>
  (
    await db.platform.query(
      `SELECT state,platform_post_id FROM ${qualified(ws.names.schema, 'tf_social_variants')} WHERE id=$1`,
      [id],
    )
  ).rows[0];

test('exit check, PRODUCT 22: the worker refreshes tokens and publishes due variants where social publishing is on', async () => {
  const fake = linkedinFake();
  const { ws, variantId, calls } = await approvedPost(fake);
  await publisherFor(ws, fake, 'true');
  const worker = fake.calls.slice(calls);
  assert.deepEqual(await variantState(ws, variantId), { state: 'published', platform_post_id: 'urn:li:share:1' });
  assert.equal(worker.filter(call => call.method === 'refresh').length, 1);
  const [sent] = worker.filter(call => call.method === 'mutate');
  assert.equal(sent.args[1].token.accessToken, 'linkedin-access-2');
});

test('PRODUCT 22: the worker leaves workspaces alone while social publishing is off', async () => {
  const fake = linkedinFake();
  const { ws, variantId, calls } = await approvedPost(fake);
  await publisherFor(ws, fake, 'false');
  assert.equal((await variantState(ws, variantId)).state, 'scheduled');
  assert.deepEqual(
    fake.calls.slice(calls).filter(call => ['refresh', 'mutate', 'targetRules'].includes(call.method)),
    [],
  );
});

test('PRODUCT 22: the worker has no publisher without a credential keyring', () => {
  assert.equal(
    createSocialPublisherComposition({ runtime, discover: async () => [], env: {}, intervalMs: 3_600_000 }),
    null,
  );
});

test('PRODUCT 22: in production the worker refuses to sweep without BETTER_AUTH_URL rather than use a local callback', async t => {
  const lines = [];
  t.mock.method(process.stdout, 'write', line => (lines.push(String(line)), true));
  let discovered = 0;
  const discover = async () => (discovered++, []);
  assert.equal(
    createSocialPublisherComposition({
      runtime,
      discover,
      env: { ...env, NODE_ENV: 'production' },
      intervalMs: 3_600_000,
    }),
    null,
  );
  assert.equal(discovered, 0);
  t.mock.restoreAll();
  const refused = lines.map(line => JSON.parse(line)).find(line => line.event === 'integration_unconfigured');
  assert.deepEqual([refused?.level, refused?.provider, refused?.status], ['error', 'social', 'missing']);

  const configured = createSocialPublisherComposition({
    runtime,
    discover,
    env: { ...env, NODE_ENV: 'production', BETTER_AUTH_URL: 'https://api.example.test' },
    intervalMs: 3_600_000,
  });
  assert.ok(configured);
  await configured.runOnce();
  await configured.close();
  assert.ok(discovered > 0);
});
