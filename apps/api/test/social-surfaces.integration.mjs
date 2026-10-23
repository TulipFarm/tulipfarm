import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { createSocialAccounts } from '@tulipfarm/social/accounts';
import { createSocialChannels } from '@tulipfarm/social/channels';
import { mediaUrlSigner } from '@tulipfarm/social/environment';
import { signMediaToken } from '@tulipfarm/social/media';
import { createPlatformApps, operatorPlatformApps } from '@tulipfarm/social/platform-apps';
import { createSocialPosts } from '@tulipfarm/social/posts';
import { createSocialPublisher } from '@tulipfarm/social/publisher';
import { createFakeAdapter } from '@tulipfarm/social/testing/fake';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { authConfig } from '../src/auth.ts';
import { registerSocialAccounts } from '../src/social-accounts.ts';
import { socialPublisher } from '../src/social-composition.ts';

const callbackUrl = 'https://api.example.test/v1/social/oauth/callback';
const keyring = { activeKeyId: 'test', keys: { test: 'cd'.repeat(32) } };
const mediaKey = 'social-media-url-key-for-tests-only-0123456789';
const mediaEnv = { SOCIAL_MEDIA_URL_KEY: mediaKey, SOCIAL_MEDIA_PUBLIC_BASE_URL: 'https://api.example.test' };
const operator = operatorPlatformApps({
  SOCIAL_LINKEDIN_CLIENT_ID: 'operator-linkedin',
  SOCIAL_LINKEDIN_CLIENT_SECRET: 'operator-linkedin-secret',
  SOCIAL_LINKEDIN_REDIRECT_URI: callbackUrl,
  SOCIAL_LINKEDIN_ACCESS_TIER: 'share',
});

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

/** The API as the web app reaches it, with the fake LinkedIn adapter behind every service. */
async function harness({ flagged = () => true, plan, wrap = adapter => adapter, objects } = {}) {
  const ws = await db.create();
  const table = name => qualified(ws.names.schema, name);
  const origin = authConfig().webOrigin;
  const admin = { cookie: 'session=admin', origin };
  const outsider = { cookie: 'session=outsider', origin };
  const sessions = new Map([
    [admin.cookie, { user: { id: ws.userId }, session: { id: 'admin-session' } }],
    [outsider.cookie, { user: { id: randomUUID() }, session: { id: 'outsider-session' } }],
  ]);
  const auth = { api: { getSession: async ({ headers }) => sessions.get(headers.get('cookie')) ?? null } };
  const fake = createFakeAdapter({ platform: 'linkedin', scopes: () => ['fake.publish'], ...(plan ? { plan } : {}) })
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
    ])
    .fallback('targetRules', { postingAllowed: true, flairRequired: false, flairIds: [] })
    .fallback('reviewChoices', []);
  const adapters = { linkedin: wrap(fake) };
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
  const publisher = createSocialPublisher({
    runtime,
    accounts,
    channels,
    adapters,
    requireSources: requireDraftSources,
    mediaUrl: mediaUrlSigner(mediaEnv),
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
        posts,
        publisher,
        objects ?? null,
        mediaEnv,
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
  /** The admin's own LinkedIn profile, which only they may publish to, connected through the routes. */
  const channel = async () => {
    const started = await request(
      {
        method: 'POST',
        url: `${base}/accounts/begin`,
        payload: { platform: 'linkedin', ownership: { kind: 'personal' } },
      },
      200,
    );
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    await request({ url: `/v1/social/oauth/callback?code=platform-code&state=${encodeURIComponent(state)}` }, 200);
    const added = await request(
      {
        method: 'POST',
        url: `${base}/channels`,
        payload: {
          accountId: started.attemptId,
          expectedAccountGeneration: 1,
          platformChannelId: 'urn:li:person:founder',
        },
      },
      200,
    );
    const mine = { memberIds: [ws.membershipId], teamIds: [] };
    const none = { memberIds: [], teamIds: [] };
    return request(
      {
        method: 'PUT',
        url: `${base}/channels/${added.id}/grants`,
        payload: { expectedVersion: added.version, publish: mine, analytics: none, engagement: none, manage: mine },
      },
      200,
    );
  };
  const chat = async () => {
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
      [id, ws.userId, ws.membershipId],
    );
    return id;
  };
  /** A chat prepares a post and the person approves it on the review card, bound to the digest and revision. */
  const approved = async (profile, content = {}) => {
    const conversationId = await chat();
    const prepared = await request(
      {
        method: 'POST',
        url: `${base}/posts`,
        payload: {
          commandId: randomUUID(),
          origin: { kind: 'conversation', conversationId, messageId: randomUUID() },
          variants: [variant(profile, content)],
        },
      },
      200,
    );
    const card = await request({ url: `${base}/posts/${prepared.post.id}` }, 200);
    const revision = card.revisions.find(item => item.number === card.currentRevision);
    const decided = await request(
      {
        method: 'POST',
        url: `${base}/posts/${card.id}/decision`,
        payload: {
          postId: card.id,
          expectedRevision: card.currentRevision,
          contentDigest: revision.contentDigest,
          decision: 'approve',
        },
      },
      200,
    );
    return { conversationId, post: decided, id: revision.variants[0].id };
  };
  const state = async id =>
    (await db.platform.query(`SELECT state FROM ${table('tf_social_variants')} WHERE id=$1`, [id])).rows[0].state;
  return { ws, app, base, admin, outsider, request, channel, chat, approved, publisher, fake, table, state };
}

const variant = (channel, { text = 'Launching today', media = [] } = {}) => ({
  channelId: channel.id,
  expectedChannelVersion: channel.version,
  content: { platform: 'linkedin', text, media, visibility: 'public' },
  publishAt: null,
});
const scheduled = (schedule, id) =>
  schedule.channels.flatMap(channel => channel.variants).find(item => item.variant.id === id);

test('PRODUCT 39: schedule and variant routes require the social-publishing flag, a session and the trusted origin', async () => {
  const { app, base, admin, request } = await harness({ flagged: () => false });
  try {
    const variantBase = `${base}/variants/${randomUUID()}`;
    await request({ url: `${base}/schedule` }, 404, { error: 'not-found' });
    await request({ url: `${variantBase}/candidates` }, 404, { error: 'not-found' });
    for (const action of ['resume', 'cancel', 'settlement'])
      await request({ method: 'POST', url: `${variantBase}/${action}`, payload: {} }, 404, { error: 'not-found' });
    assert.equal((await app.inject({ url: `${base}/schedule` })).statusCode, 401);
    const untrusted = await app.inject({
      method: 'POST',
      url: `${variantBase}/cancel`,
      headers: { ...admin, origin: 'https://evil.example' },
      payload: { expectedState: 'blocked' },
    });
    assert.equal(untrusted.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('exit check, PRODUCT 38, 39: a person approves on the card, the fake adapter publishes it, and the schedule shows the receipt', async () => {
  const { app, base, outsider, request, channel, approved, publisher, fake, ws } = await harness();
  try {
    fake.fallback('mutate', {
      kind: 'published',
      platformPostId: 'urn:li:share:1',
      permalink: 'https://linkedin.example/1',
    });
    const profile = await channel();
    const { id, post } = await approved(profile);
    assert.equal(scheduled(await request({ url: `${base}/schedule` }, 200), id).variant.state, 'scheduled');
    await publisher.sweep(ws.id);
    const schedule = await request({ url: `${base}/schedule` }, 200);
    assert.equal(schedule.truncated, false);
    assert.deepEqual(
      schedule.channels.map(item => [item.channelId, item.platform, item.displayName]),
      [[profile.id, 'linkedin', 'Founder']],
    );
    const row = scheduled(schedule, id);
    assert.equal(row.postId, post.id);
    assert.equal(row.variant.state, 'published');
    assert.equal(row.variant.platformPostId, 'urn:li:share:1');
    assert.equal(row.variant.permalink, 'https://linkedin.example/1');
    assert.equal(row.variant.receipts.at(-1).status, 'succeeded');
    // Filters narrow the schedule; a state the variant is not in hides it.
    assert.equal(
      scheduled(await request({ url: `${base}/schedule?states=published&channelId=${profile.id}` }, 200), id).variant
        .state,
      'published',
    );
    assert.equal(scheduled(await request({ url: `${base}/schedule?states=blocked,failed` }, 200), id), undefined);
    await request({ url: `${base}/schedule?states=bogus` }, 400, { error: 'invalid-request' });
    // Someone who may not publish to the channel sees none of it.
    const hidden = await app.inject({ url: `${base}/schedule`, headers: outsider });
    assert.equal(hidden.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('PRODUCT 25, 39: the schedule resumes or cancels a blocked variant, and only with the expected state', async () => {
  const { app, base, outsider, request, channel, approved, publisher, ws, table } = await harness();
  try {
    const profile = await channel();
    const kept = await approved(profile, { text: 'Kept' });
    const dropped = await approved(profile, { text: 'Dropped' });
    for (const { conversationId } of [kept, dropped])
      await db.platform.query(`UPDATE ${table('tf_conversations')} SET deleted_at=now() WHERE id=$1`, [conversationId]);
    await publisher.sweep(ws.id);
    const blocked = scheduled(await request({ url: `${base}/schedule?states=blocked` }, 200), kept.id).variant;
    assert.equal(blocked.blockedReason, 'origin-revoked');

    const action = (id, name, payload = { expectedState: 'blocked' }) => ({
      method: 'POST',
      url: `${base}/variants/${id}/${name}`,
      payload,
    });
    await request(action(kept.id, 'resume', { expectedState: 'scheduled' }), 409, { error: 'variant-conflict' });
    await request(action(kept.id, 'resume', { expectedState: 'blocked', variantId: kept.id }), 400, {
      error: 'invalid-request',
    });
    const outsiderResume = await app.inject({ ...action(kept.id, 'resume'), headers: outsider });
    assert.equal(outsiderResume.statusCode, 404);
    // Resuming reruns every check; the deleted chat still blocks it.
    const resumed = await request(action(kept.id, 'resume'), 200);
    assert.equal(resumed.state, 'blocked');
    assert.equal(resumed.blockedReason, 'origin-revoked');
    assert.equal((await request(action(dropped.id, 'cancel'), 200)).state, 'cancelled');
    await request(action(dropped.id, 'cancel'), 409, { error: 'variant-conflict' });
    await request(action(randomUUID(), 'cancel'), 404, { error: 'variant-not-found' });
  } finally {
    await app.close();
  }
});

test('PRODUCT 24, 39: an unknown outcome shows the platform’s candidates and settles only on one a person confirms', async () => {
  const { app, base, request, channel, approved, publisher, fake, ws, table, state } = await harness();
  try {
    const candidate = {
      platformPostId: 'similar-1',
      permalink: 'https://linkedin.example/similar-1',
      createdAt: '2026-01-01T00:00:00Z',
    };
    fake.script('mutate', { throw: 'unknown', phase: 'after-send' }, { throw: 'unknown', phase: 'after-send' });
    fake.fallback('reconcile', { kind: 'candidates', items: [candidate] });
    const profile = await channel();
    const confirmed = await approved(profile, { text: 'Confirmed' });
    const denied = await approved(profile, { text: 'Denied' });
    await publisher.sweep(ws.id);
    await db.platform.query(
      `UPDATE ${table('tf_social_variants')} SET next_attempt_at=next_attempt_at-interval '1 day' WHERE id = ANY($1)`,
      [[confirmed.id, denied.id]],
    );
    await publisher.sweep(ws.id);
    assert.equal(await state(confirmed.id), 'outcome-unknown');
    const unknown = await request({ url: `${base}/schedule?states=outcome-unknown` }, 200);
    assert.ok(scheduled(unknown, confirmed.id));
    assert.deepEqual(await request({ url: `${base}/variants/${confirmed.id}/candidates` }, 200), {
      kind: 'candidates',
      items: [candidate],
    });
    const settle = (id, payload) => ({ method: 'POST', url: `${base}/variants/${id}/settlement`, payload });
    await request(settle(confirmed.id, { settlement: 'published', platformPostId: 'made-up' }), 409, {
      error: 'settlement-unconfirmed',
    });
    const published = await request(
      settle(confirmed.id, { settlement: 'published', platformPostId: 'similar-1' }),
      200,
    );
    assert.equal(published.state, 'published');
    assert.equal(published.permalink, candidate.permalink);
    assert.equal((await request(settle(denied.id, { settlement: 'not-published' }), 200)).state, 'not-published');
    await request(settle(denied.id, { settlement: 'not-published' }), 409, { error: 'variant-conflict' });
    assert.equal(fake.calls.filter(call => call.method === 'mutate').length, 2);
  } finally {
    await app.close();
  }
});

test('PRODUCT 19: the media URL serves the attempt’s File, with ranges, and nothing once forged, expired, widened or finished', async () => {
  const content = Buffer.from('fake-image-bytes');
  const sha256 = createHash('sha256').update(content).digest('hex');
  let corrupt = false;
  const reads = [];
  const objects = async (key, maximumBytes) => {
    reads.push({ key, maximumBytes });
    return corrupt ? Buffer.from('changed-bytes!!!') : content;
  };
  const seen = [];
  let app;
  let ws;
  const get = (url, headers = {}) => app.inject({ url, headers });
  const harnessed = await harness({
    objects,
    plan: () => [
      { kind: 'upload-media', mode: 'mutate' },
      { kind: 'create-post', mode: 'mutate' },
    ],
    wrap: fake => ({
      ...fake,
      async mutate(step, input) {
        const [media] = input.variant.content.media;
        if (step.kind === 'upload-media' && media) {
          const url = await input.mediaUrl(media.fileId);
          const token = url.pathname.split('/').at(-1);
          const [payload] = token.split('.');
          const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
          const sign = changes =>
            `/v1/social/media/${signMediaToken(mediaKey, {
              ...grant,
              expiresAt: new Date(grant.expiresAt * 1000),
              ...changes,
            })}`;
          const other = randomUUID();
          seen.push({
            url,
            grant,
            full: await get(url.pathname),
            range: await get(url.pathname, { range: 'bytes=5-9' }),
            suffix: await get(url.pathname, { range: 'bytes=-5' }),
            unsatisfiable: await get(url.pathname, { range: 'bytes=99-' }),
            forged: await get(`${url.pathname.slice(0, -4)}AAAA`),
            otherKey: await get(
              `/v1/social/media/${signMediaToken('another-key-that-is-at-least-32-bytes', {
                ...grant,
                expiresAt: new Date(grant.expiresAt * 1000),
              })}`,
            ),
            expired: await get(sign({ expiresAt: new Date(Date.now() - 1000) })),
            wrongFile: await get(sign({ fileId: other })),
            wrongStep: await get(sign({ step: 'create-post' })),
            otherWorkspace: await get(sign({ workspaceId: randomUUID() })),
            corrupt: await (async () => {
              corrupt = true;
              try {
                return await get(url.pathname);
              } finally {
                corrupt = false;
              }
            })(),
          });
        }
        return fake.mutate(step, input);
      },
    }),
  });
  ({ app, ws } = harnessed);
  const { channel, approved, publisher, fake, table, state } = harnessed;
  try {
    fake.script(
      'mutate',
      { kind: 'done', platformRefs: { asset: 'urn:li:asset:1' } },
      { kind: 'published', platformPostId: 'urn:li:share:2', permalink: null },
    );
    const profile = await channel();
    const fileId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_files')} (id,kind,creator_membership_id,name,object_key,media_type,size,sha256,ready)
       VALUES ($1,'file',$2,'media',$3,'image/png',$4,$5,true)`,
      [fileId, ws.membershipId, randomUUID(), content.length, sha256],
    );
    const { id } = await approved(profile, { media: [{ fileId, contentDigest: sha256, role: 'primary' }] });
    await publisher.sweep(ws.id);
    assert.equal(await state(id), 'published');
    assert.equal(seen.length, 1);
    const [result] = seen;
    assert.equal(result.url.origin, 'https://api.example.test');
    assert.equal(result.grant.fileId, fileId);
    assert.equal(result.full.statusCode, 200);
    assert.deepEqual(result.full.rawPayload, content);
    assert.equal(result.full.headers['content-type'], 'image/png');
    assert.equal(result.full.headers['cache-control'], 'no-store');
    assert.equal(result.full.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.full.headers['accept-ranges'], 'bytes');
    assert.equal(result.range.statusCode, 206);
    assert.equal(result.range.headers['content-range'], `bytes 5-9/${content.length}`);
    assert.deepEqual(result.range.rawPayload, content.subarray(5, 10));
    assert.equal(result.suffix.statusCode, 206);
    assert.deepEqual(result.suffix.rawPayload, content.subarray(content.length - 5));
    assert.equal(result.unsatisfiable.statusCode, 416);
    for (const refused of ['forged', 'otherKey', 'expired', 'wrongFile', 'wrongStep', 'otherWorkspace', 'corrupt']) {
      assert.equal(result[refused].statusCode, 404, refused);
      assert.deepEqual(result[refused].json(), { error: 'not-found' }, refused);
      assert.equal(result[refused].headers['cache-control'], 'no-store', refused);
    }
    // Every read named the workspace's own object, at most the File's size.
    for (const read of reads) {
      assert.ok(read.key.startsWith(`${ws.id}/`));
      assert.equal(read.maximumBytes, content.length);
    }
    // Once the attempt is over, the same URL serves nothing.
    const finished = await get(result.url.pathname);
    assert.equal(finished.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('PRODUCT 19: the media URL fails closed without a key, a store, a publisher or the flag', async () => {
  const content = Buffer.from('x');
  const token = signMediaToken(mediaKey, {
    workspaceId: randomUUID(),
    variantId: randomUUID(),
    attemptId: randomUUID(),
    step: 'upload-media',
    fileId: randomUUID(),
    contentDigest: createHash('sha256').update(content).digest('hex'),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const auth = { api: { getSession: async () => null } };
  for (const [env, publisher, flag] of [
    [{}, {}, true],
    [mediaEnv, null, true],
    [mediaEnv, {}, false],
  ]) {
    const app = Fastify();
    let looked = false;
    const stub = publisher && {
      async mediaObject() {
        looked = true;
        return { id: randomUUID(), sha256: 'a'.repeat(64), size: 1, mediaType: 'image/png', path: 'x' };
      },
    };
    await app.register(
      async routes =>
        registerSocialAccounts(
          routes,
          auth,
          null,
          async () => flag,
          null,
          null,
          stub,
          async () => content,
          env,
        ),
      { prefix: '/v1' },
    );
    const response = await app.inject(`/v1/social/media/${token}`);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'not-found' });
    assert.equal(looked, false);
    await app.close();
  }
  assert.equal(socialPublisher(null, null, undefined), null);
});
