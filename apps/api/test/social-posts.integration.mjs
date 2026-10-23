import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { createSocialAccounts } from '@tulipfarm/social/accounts';
import { createSocialChannels } from '@tulipfarm/social/channels';
import { createPlatformApps, operatorPlatformApps } from '@tulipfarm/social/platform-apps';
import { createSocialPosts } from '@tulipfarm/social/posts';
import { createFakeAdapter } from '@tulipfarm/social/testing/fake';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerSocialAccounts } from '../src/social-accounts.ts';
import { socialPosts } from '../src/social-composition.ts';

const callbackUrl = 'https://api.example.test/v1/social/oauth/callback';
const keyring = { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } };
const operator = operatorPlatformApps({
  SOCIAL_LINKEDIN_CLIENT_ID: 'operator-linkedin',
  SOCIAL_LINKEDIN_CLIENT_SECRET: 'operator-linkedin-secret',
  SOCIAL_LINKEDIN_REDIRECT_URI: callbackUrl,
  SOCIAL_LINKEDIN_ACCESS_TIER: 'share',
});
const linkedin = createFakeAdapter({ platform: 'linkedin', scopes: () => ['fake.publish'] })
  .fallback('exchangeCode', {
    accessToken: 'linkedin-access-token-value',
    refreshToken: 'linkedin-refresh-token-value',
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ['fake.publish'],
  })
  .fallback('identity', { platformUserId: 'linkedin-person', handle: 'person', displayName: 'Person' })
  .fallback('listChannels', [
    {
      platformChannelId: 'urn:li:person:founder',
      channelKind: 'member-profile',
      displayName: 'Founder',
      handle: 'founder',
      avatarUrl: null,
    },
  ]);

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

async function harness({ flagged = () => true, withPosts = true } = {}) {
  const ws = await db.create();
  const origin = authConfig().webOrigin;
  const admin = { cookie: 'session=admin', origin };
  const outsider = { cookie: 'session=outsider', origin };
  const sessions = new Map([
    [admin.cookie, { user: { id: ws.userId }, session: { id: 'admin-session' } }],
    [outsider.cookie, { user: { id: randomUUID() }, session: { id: 'outsider-session' } }],
  ]);
  const auth = { api: { getSession: async ({ headers }) => sessions.get(headers.get('cookie')) ?? null } };
  const adapters = { linkedin };
  const accounts = createSocialAccounts({
    runtime,
    keyring,
    platformApps: createPlatformApps({ operator, callbackUrl }),
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
  const app = Fastify();
  await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'Social', version: '1' } } });
  await app.register(
    async routes =>
      registerSocialAccounts(
        routes,
        auth,
        accounts,
        async (_user, workspace) => flagged(workspace),
        channels,
        withPosts ? posts : null,
      ),
    { prefix: '/v1' },
  );
  await app.ready();
  const base = `/v1/workspaces/${ws.id}/social`;
  const request = async (options, status, expected) => {
    const response = await app.inject({ headers: admin, ...options });
    assert.equal(response.statusCode, status, `${options.method ?? 'GET'} ${options.url}: ${response.body}`);
    assert.equal(response.headers['cache-control'], 'no-store');
    const value = response.body ? response.json() : undefined;
    if (expected !== undefined) assert.deepEqual(value, expected);
    return value;
  };
  /** The admin's own LinkedIn profile, which only they may publish to. */
  const channel = async () => {
    const started = await accounts.begin(ws.id, ws.userId, 'admin-session', {
      platform: 'linkedin',
      ownership: { kind: 'personal' },
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    await accounts.complete('platform-code', state, 'admin-session', ws.userId);
    const added = await channels.add(ws.id, ws.userId, {
      accountId: started.attemptId,
      expectedAccountGeneration: 1,
      platformChannelId: 'urn:li:person:founder',
    });
    const mine = { memberIds: [ws.membershipId], teamIds: [] };
    const none = { memberIds: [], teamIds: [] };
    return channels.setGrants(ws.id, ws.userId, added.id, {
      expectedVersion: added.grantsVersion,
      publish: mine,
      analytics: none,
      engagement: none,
      manage: mine,
    });
  };
  const chat = async () => {
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO ${qualified(ws.names.schema, 'tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
      [id, ws.userId, ws.membershipId],
    );
    return id;
  };
  return { ws, app, base, admin, outsider, request, channel, chat };
}

const variant = (channel, text = 'Launching today') => ({
  channelId: channel.id,
  expectedChannelVersion: channel.version,
  content: { platform: 'linkedin', text, media: [], visibility: 'public' },
  publishAt: null,
});

test('PRODUCT 13-21 post routes require the social-publishing flag, a session and the trusted origin', async () => {
  const { app, base, admin, request } = await harness({ flagged: () => false });
  try {
    const post = `${base}/posts/${randomUUID()}`;
    await request({ url: post }, 404, { error: 'not-found' });
    for (const url of [`${base}/posts`, `${post}/revisions`, `${post}/decision`])
      await request({ method: 'POST', url, payload: {} }, 404, { error: 'not-found' });
    const unsigned = await app.inject({ url: post });
    assert.equal(unsigned.statusCode, 401);
    const untrusted = await app.inject({
      method: 'POST',
      url: `${base}/posts`,
      headers: { ...admin, origin: 'https://evil.example' },
      payload: {},
    });
    assert.equal(untrusted.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('PRODUCT 13-21 post routes fail closed without the confirmation registry', async () => {
  assert.equal(socialPosts(null, null, undefined), null);
  const { app, base, request } = await harness({ withPosts: false });
  try {
    await request({ url: `${base}/posts/${randomUUID()}` }, 503, { error: 'account-unavailable' });
  } finally {
    await app.close();
  }
});

test('PRODUCT 14-16: a chat prepares, edits and approves a post by its digest over HTTP', async () => {
  const { app, base, outsider, request, channel, chat } = await harness();
  try {
    const profile = await channel();
    const conversationId = await chat();
    const origin = { kind: 'conversation', conversationId, messageId: randomUUID() };
    await request(
      {
        method: 'POST',
        url: `${base}/posts`,
        payload: {
          commandId: randomUUID(),
          origin: { kind: 'task', taskId: randomUUID(), generation: 0 },
          variants: [variant(profile)],
        },
      },
      400,
      { error: 'invalid-request' },
    );
    const prepared = await request(
      {
        method: 'POST',
        url: `${base}/posts`,
        payload: { commandId: randomUUID(), origin, variants: [variant(profile)] },
      },
      200,
    );
    const postId = prepared.post.id;
    assert.deepEqual(
      prepared.variants.map(item => item.errors),
      [[]],
    );
    assert.equal(prepared.post.revisions[0].variants[0].state, 'awaiting-approval');

    const revised = await request(
      {
        method: 'POST',
        url: `${base}/posts/${postId}/revisions`,
        payload: { expectedRevision: 1, variants: [variant(profile, 'Launching tomorrow')] },
      },
      200,
    );
    assert.equal(revised.post.currentRevision, 2);
    await request(
      {
        method: 'POST',
        url: `${base}/posts/${postId}/revisions`,
        payload: { expectedRevision: 1, variants: [variant(profile, 'Stale edit')] },
      },
      409,
      { error: 'revision-conflict' },
    );

    const revision = revised.post.revisions.find(item => item.number === 2);
    const decision = { postId, expectedRevision: 2, contentDigest: revision.contentDigest, decision: 'approve' };
    await request(
      { method: 'POST', url: `${base}/posts/${postId}/decision`, payload: { ...decision, postId: randomUUID() } },
      400,
      { error: 'invalid-request' },
    );
    await request(
      {
        method: 'POST',
        url: `${base}/posts/${postId}/decision`,
        payload: { ...decision, contentDigest: revised.post.revisions.find(item => item.number === 1).contentDigest },
      },
      409,
      { error: 'revision-conflict' },
    );
    const approved = await request({ method: 'POST', url: `${base}/posts/${postId}/decision`, payload: decision }, 200);
    assert.equal(approved.revisions.find(item => item.number === 1).decision, null);
    assert.equal(approved.revisions.find(item => item.number === 2).decision.decision, 'approve');
    assert.equal(approved.revisions.find(item => item.number === 2).variants[0].state, 'scheduled');
    assert.equal(approved.revisions.find(item => item.number === 1).variants[0].state, 'superseded');

    const read = await request({ url: `${base}/posts/${postId}` }, 200);
    assert.deepEqual(read, approved);
    const hidden = await app.inject({ url: `${base}/posts/${postId}`, headers: outsider });
    assert.equal(hidden.statusCode, 404);
    assert.deepEqual(hidden.json(), { error: 'post-not-found' });
    await request({ url: `${base}/posts/${randomUUID()}` }, 404, { error: 'post-not-found' });
  } finally {
    await app.close();
  }
});
