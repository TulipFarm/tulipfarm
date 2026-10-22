import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { connect, denied, fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { generationCurrent, createSocialAccounts, staleRefreshMs } from '../dist/accounts.js';
import { createPlatformApps, operatorPlatformApps } from '../dist/platform-apps.js';
import { createFakeAdapter } from '../dist/platforms/fake.js';

const callbackUrl = 'https://api.example.test/v1/social/oauth/callback';
const keyring = { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } };
const session = 'test-session';
const minutes = n => new Date(Date.now() + n * 60_000);
const operatorEnv = (prefix, tier, secret = 'operator-secret') => ({
  [`${prefix}_CLIENT_ID`]: `${prefix}-client`,
  [`${prefix}_CLIENT_SECRET`]: secret,
  [`${prefix}_REDIRECT_URI`]: callbackUrl,
  [`${prefix}_ACCESS_TIER`]: tier,
});
const everyOperatorApp = {
  ...operatorEnv('SOCIAL_LINKEDIN', 'share'),
  ...operatorEnv('SOCIAL_INSTAGRAM', 'standard'),
  ...operatorEnv('SOCIAL_X', 'paid'),
  ...operatorEnv('SOCIAL_REDDIT', 'paid'),
};
const hostedTiers = { linkedin: 'share', instagram: 'standard', x: 'paid', reddit: 'paid' };
const code = (error, expected) => error?.code === expected;
const deniedAccess = error => error?.message === 'Resource not found';

let db;
let ws;
let runtime;
let raw;
let member;
let teamId;

const table = name => qualified(ws.names.schema, name);
const admin = () => ({ userId: ws.userId, membershipId: ws.membershipId });
const row = async id =>
  (await db.platform.query(`SELECT * FROM ${table('tf_social_accounts')} WHERE id=$1`, [id])).rows[0];
const audits = async id =>
  (
    await db.platform.query(
      `SELECT operation FROM ${table('tf_audit_events')} WHERE subject_id=$1 ORDER BY created_at`,
      [id],
    )
  ).rows.map(event => event.operation);

function adapters(policies = {}) {
  const make = (platform, refreshPolicy) =>
    createFakeAdapter({ platform, refreshPolicy, scopes: () => ['fake.read', 'fake.publish'] })
      .fallback('exchangeCode', {
        accessToken: `${platform}-access`,
        refreshToken: `${platform}-refresh`,
        expiresAt: minutes(120),
        scopes: ['fake.read', 'fake.publish'],
      })
      .fallback('identity', { platformUserId: `${platform}-person`, handle: 'person', displayName: 'Person' })
      .fallback('refresh', {
        accessToken: `${platform}-access-2`,
        refreshToken: null,
        expiresAt: minutes(240),
        scopes: [],
      })
      .fallback('revoke', 'revoked');
  return {
    linkedin: make('linkedin', policies.linkedin ?? 'refresh-token'),
    instagram: make('instagram', policies.instagram ?? 'long-lived-exchange'),
    x: make('x', policies.x ?? 'none'),
    reddit: make('reddit', policies.reddit ?? 'refresh-token'),
  };
}

function service({ hosted, env = everyOperatorApp, platforms = adapters() } = {}) {
  const platformApps = createPlatformApps({ hosted, operator: operatorPlatformApps(env), callbackUrl });
  const accounts = createSocialAccounts({ runtime, keyring, platformApps, adapters: platforms });
  const begin = async (input, user = admin().userId) => {
    const started = await accounts.begin(ws.id, user, session, { ownership: { kind: 'personal' }, ...input });
    const url = new URL(started.authorizationUrl);
    return { ...started, url, state: url.searchParams.get('state') };
  };
  const connectAccount = async (input, user = admin().userId) => {
    const started = await begin(input, user);
    await accounts.complete('platform-code', started.state, session, user);
    return started.attemptId;
  };
  const reconnect = async (id, user = admin().userId) => {
    const started = await accounts.reconnect(ws.id, user, session, id);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    return accounts.complete('platform-code-2', state, session, user);
  };
  return { accounts, platforms, begin, connect: connectAccount, reconnect };
}

const hostedResolver = { resolve: async platform => ({ kind: 'app', app: hostedApp(platform) }) };
function hostedApp(platform, generation = 1) {
  return {
    clientId: `hosted-${platform}`,
    clientSecret: 'hosted-secret',
    accessTier: hostedTiers[platform],
    generation,
  };
}
async function workspaceApp(accounts, platform, tier = hostedTiers[platform]) {
  return accounts.createApp(ws.id, admin().userId, {
    platform,
    name: `Our ${platform} app`,
    clientId: `own-${platform}`,
    clientSecret: `own-${platform}-secret`,
    accessTier: tier,
  });
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

// Each test gets its own workspace, so account limits and grants never leak between tests.
beforeEach(async () => {
  ws = await db.create();
  raw = await connect(db.login(ws));
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

afterEach(async () => {
  await raw?.end();
});

after(async () => {
  await runtime?.close();
  await db?.close();
});

test('exit check, PRODUCT 4: hosted X and Reddit need a workspace app even when operator settings exist', async () => {
  const asked = [];
  const hosted = {
    resolve: async platform => {
      asked.push(platform);
      return { kind: 'app', app: hostedApp(platform) };
    },
  };
  const { accounts, begin } = service({ hosted });
  for (const platform of ['x', 'reddit'])
    await assert.rejects(begin({ platform }), error => code(error, 'workspace-app-required'), platform);
  const before = await accounts.availability(ws.id, member.userId);
  for (const platform of ['x', 'reddit'])
    assert.deepEqual(
      before.find(item => item.platform === platform),
      {
        platform,
        available: false,
        reason: 'workspace-app-required',
        appSource: null,
        accessTier: null,
        capabilities: [],
      },
    );
  assert.equal(before.find(item => item.platform === 'linkedin').appSource, 'hosted');
  assert.equal(before.find(item => item.platform === 'youtube').reason, 'not-configured');
  assert.ok(!asked.includes('x') && !asked.includes('reddit'));

  for (const platform of ['x', 'reddit']) {
    const app = await workspaceApp(accounts, platform);
    const started = await begin({ platform, platformAppId: app.id });
    assert.equal(started.url.searchParams.get('client_id'), `own-${platform}`);
    const stored = await row(started.attemptId);
    assert.equal(stored.app_source, 'workspace');
    assert.equal(stored.platform_app_id, app.id);
    assert.equal(stored.app_generation, 1);
  }
  const later = await accounts.availability(ws.id, member.userId);
  for (const platform of ['x', 'reddit'])
    assert.equal(later.find(item => item.platform === platform).appSource, 'workspace');

  const hostedLinkedin = await begin({ platform: 'linkedin' });
  assert.equal(hostedLinkedin.url.searchParams.get('client_id'), 'hosted-linkedin');
  assert.equal((await row(hostedLinkedin.attemptId)).app_source, 'hosted');
});

test('PRODUCT 3: workspace apps are registered by admins and never reveal their secret', async () => {
  const { accounts } = service();
  await assert.rejects(
    accounts.createApp(ws.id, member.userId, {
      platform: 'linkedin',
      name: 'Member app',
      clientId: 'm',
      clientSecret: 'm-secret',
      accessTier: 'share',
    }),
    deniedAccess,
  );
  await assert.rejects(
    accounts.createApp(ws.id, admin().userId, {
      platform: 'linkedin',
      name: 'Wrong tier',
      clientId: 'm',
      clientSecret: 's',
      accessTier: 'paid',
    }),
  );
  const app = await workspaceApp(accounts, 'linkedin');
  assert.equal(app.generation, 1);
  assert.ok(!('clientSecret' in app));
  const listed = await accounts.listApps(ws.id, member.userId);
  assert.ok(listed.some(item => item.id === app.id));
  assert.ok(!JSON.stringify(listed).includes('own-linkedin-secret'));
  const stored = (
    await db.platform.query(`SELECT client_secret FROM ${table('tf_social_platform_apps')} WHERE id=$1`, [app.id])
  ).rows[0].client_secret;
  assert.deepEqual(Object.keys(stored).sort(), ['ciphertext', 'keyId', 'nonce', 'tag']);
  assert.ok(!JSON.stringify(stored).includes('own-linkedin-secret'));
  assert.ok((await audits(app.id)).includes('social-platform-app.create'));
});

test('PRODUCT 7: begin and callback connect an account through PKCE and a single-use, session-bound state', async () => {
  const { accounts, platforms, begin } = service();
  const started = await begin({ platform: 'linkedin' });
  const challenge = started.url.searchParams.get('code_challenge');
  assert.equal(started.url.searchParams.get('redirect_uri'), callbackUrl);
  assert.equal(started.url.searchParams.get('scope'), 'fake.read fake.publish');
  assert.equal((await accounts.status(ws.id, admin().userId, started.attemptId)).state, 'authorizing');
  const attempt = (
    await db.platform.query(`SELECT * FROM ${table('tf_social_account_attempts')} WHERE account_id=$1`, [
      started.attemptId,
    ])
  ).rows[0];
  assert.equal(attempt.state_hash, createHash('sha256').update(started.state).digest('hex'));
  assert.ok(!JSON.stringify(attempt).includes(started.state));
  assert.deepEqual(Object.keys(attempt.verifier).sort(), ['ciphertext', 'keyId', 'nonce', 'tag']);

  await assert.rejects(accounts.complete('c', started.state, 'other-session', admin().userId), deniedAccess);
  await assert.rejects(accounts.complete('c', started.state, session, member.userId), deniedAccess);
  const result = await accounts.complete('platform-code', started.state, session, admin().userId);
  assert.equal(result.workspaceId, ws.id);
  assert.equal(result.account.state, 'active');
  assert.deepEqual(result.account.identity, {
    platformUserId: 'linkedin-person',
    handle: 'person',
    displayName: 'Person',
  });
  const exchange = platforms.linkedin.calls.findLast(call => call.method === 'exchangeCode').args[0];
  assert.equal(createHash('sha256').update(exchange.codeVerifier).digest('base64url'), challenge);
  assert.equal(exchange.redirectUri, callbackUrl);
  assert.deepEqual(exchange.app, {
    clientId: 'SOCIAL_LINKEDIN-client',
    clientSecret: 'operator-secret',
    accessTier: 'share',
  });
  await assert.rejects(accounts.complete('platform-code', started.state, session, admin().userId), deniedAccess);

  const stored = await row(started.attemptId);
  assert.equal(stored.generation, 1);
  assert.equal(stored.credential_version, 1);
  assert.ok(!JSON.stringify(stored.credential).includes('linkedin-access'));
  const consumed = await db.platform.query(
    `SELECT state,verifier FROM ${table('tf_social_account_attempts')} WHERE account_id=$1`,
    [started.attemptId],
  );
  assert.deepEqual(consumed.rows, [{ state: 'consumed', verifier: null }]);
  const token = await accounts.accessToken(ws.id, started.attemptId);
  assert.equal(token.token.accessToken, 'linkedin-access');
  assert.deepEqual(await audits(started.attemptId), ['social-account.begin', 'social-account.connected']);

  const listedByOther = await accounts.list(ws.id, member.userId);
  assert.ok(!listedByOther.some(item => item.id === started.attemptId), 'a personal connection is its owner’s');
});

test('PRODUCT 7: a declined or failed authorization leaves the connection needing reconnect', async () => {
  const { accounts, platforms, begin } = service();
  const declined = await begin({ platform: 'linkedin' });
  await assert.rejects(accounts.complete(null, declined.state, session, admin().userId), error =>
    code(error, 'account-authorization-denied'),
  );
  assert.equal((await accounts.status(ws.id, admin().userId, declined.attemptId)).state, 'reconnect-required');

  platforms.linkedin.script('exchangeCode', {
    accessToken: 'expiring-access-token',
    refreshToken: 'expiring-refresh-token',
    expiresAt: minutes(60),
    scopes: ['fake.read'],
  });
  const reduced = await begin({ platform: 'linkedin' });
  await assert.rejects(accounts.complete('c', reduced.state, session, admin().userId), error =>
    code(error, 'account-reconnect-required'),
  );
  const stored = await row(reduced.attemptId);
  assert.equal(stored.state, 'reconnect-required');
  assert.equal(stored.credential, null);
});

test('exit check, PRODUCT 8: a refresh keeps generation and a reconnect voids work bound to the old one', async () => {
  const { accounts, platforms, connect: connectAccount, reconnect } = service();
  platforms.linkedin.script('exchangeCode', {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: new Date(Date.now() + 30_000),
    scopes: ['fake.read', 'fake.publish'],
  });
  const id = await connectAccount({ platform: 'linkedin' });
  const bound = (await row(id)).generation;
  const channelId = randomUUID();
  await raw.query(
    `INSERT INTO ${table('tf_social_channels')} (id,account_id,platform,channel_kind,platform_channel_id,display_name,account_generation)
     VALUES ($1,$2,'linkedin','member-profile','person','Person',$3)`,
    [channelId, id, bound],
  );

  const refreshed = await accounts.accessToken(ws.id, id);
  assert.equal(refreshed.token.accessToken, 'linkedin-access-2');
  assert.equal(refreshed.token.refreshToken, 'old-refresh', 'a refresh without a new refresh token keeps the old one');
  assert.deepEqual(refreshed.account, { id, platform: 'linkedin', generation: bound, credentialVersion: 2 });
  const [token, app] = platforms.linkedin.calls.findLast(call => call.method === 'refresh').args;
  assert.equal(token.refreshToken, 'old-refresh');
  assert.equal(app.clientSecret, 'operator-secret');
  let stored = await row(id);
  assert.equal(stored.generation, bound);
  assert.equal(stored.credential_version, 2);
  assert.equal(stored.state, 'active');
  assert.ok(generationCurrent(stored, bound), 'approvals, channels and scheduled variants stay valid');
  assert.equal((await accounts.accessToken(ws.id, id)).token.accessToken, 'linkedin-access-2');
  assert.equal(platforms.linkedin.calls.filter(call => call.method === 'refresh').length, 1);

  platforms.linkedin.script('identity', { platformUserId: 'someone-else', handle: null, displayName: 'Else' });
  const result = await reconnect(id);
  assert.equal(result.account.state, 'active');
  assert.equal(result.account.generation, bound + 1);
  stored = await row(id);
  assert.equal(stored.generation, bound + 1);
  assert.ok(!generationCurrent(stored, bound), 'a reconnect voids approvals, channels and variants bound before it');
  assert.ok(generationCurrent(stored, bound + 1));
  assert.ok((await audits(id)).includes('social-account.connected.identity-changed'));
  const channel = (
    await db.platform.query(`SELECT account_generation FROM ${table('tf_social_channels')} WHERE id=$1`, [channelId])
  ).rows[0];
  assert.equal(channel.account_generation, bound);
});

test('PRODUCT 7: a rejected refresh requires reconnect; a transient failure does not', async () => {
  const { accounts, platforms, connect: connectAccount } = service();
  const expiring = {
    accessToken: 'expiring-access-token',
    refreshToken: 'expiring-refresh-token',
    expiresAt: new Date(Date.now() + 10_000),
    scopes: ['fake.read', 'fake.publish'],
  };
  platforms.linkedin.script('exchangeCode', expiring, expiring);
  const transient = await connectAccount({ platform: 'linkedin' });
  platforms.linkedin.script('refresh', { throw: 'retry', phase: 'before-send' });
  await assert.rejects(accounts.accessToken(ws.id, transient), error => code(error, 'account-unavailable'));
  let stored = await row(transient);
  assert.equal(stored.state, 'active');
  assert.equal(stored.generation, 1);
  assert.equal(stored.refresh_started_at, null);

  const rejected = await connectAccount({ platform: 'linkedin' });
  platforms.linkedin.script('refresh', { throw: 'reconnect', phase: 'before-send' });
  await assert.rejects(accounts.accessToken(ws.id, rejected), error => code(error, 'account-reconnect-required'));
  stored = await row(rejected);
  assert.equal(stored.state, 'reconnect-required');
  assert.equal(stored.generation, 2);
  assert.equal(stored.credential, null);
  await assert.rejects(accounts.accessToken(ws.id, rejected), error => code(error, 'account-reconnect-required'));
  assert.ok((await audits(rejected)).includes('social-account.reconnect-required.refresh-rejected'));
});

test('PRODUCT 7: a refresh that narrows the granted scopes requires reconnect', async () => {
  const { accounts, platforms, connect: connectAccount } = service();
  platforms.linkedin.script('exchangeCode', {
    accessToken: 'expiring-access-token',
    refreshToken: 'expiring-refresh-token',
    expiresAt: new Date(Date.now() + 10_000),
    scopes: ['fake.read', 'fake.publish'],
  });
  const id = await connectAccount({ platform: 'linkedin' });
  platforms.linkedin.script('refresh', {
    accessToken: 'narrowed-access-token',
    refreshToken: 'narrowed-refresh-token',
    expiresAt: minutes(60),
    scopes: ['fake.read'],
  });
  await assert.rejects(accounts.accessToken(ws.id, id), error => code(error, 'account-reconnect-required'));
  const stored = await row(id);
  assert.equal(stored.state, 'reconnect-required');
  assert.equal(stored.generation, 2);
});

test('PRODUCT 7, refresh-token policy: an expiring token without a refresh token requires reconnect', async () => {
  const { accounts, platforms, connect: connectAccount } = service();
  const reddit = await workspaceApp(accounts, 'reddit');
  platforms.reddit.script('exchangeCode', {
    accessToken: 'expiring-access-token',
    refreshToken: null,
    expiresAt: new Date(Date.now() + 2_000),
    scopes: ['fake.read', 'fake.publish'],
  });
  const id = await connectAccount({ platform: 'reddit', platformAppId: reddit.id });
  const early = await accounts.accessToken(ws.id, id);
  assert.equal(early.token.accessToken, 'expiring-access-token', 'a token that has not expired is still used');
  await new Promise(resolve => setTimeout(resolve, 2_100));
  await assert.rejects(accounts.accessToken(ws.id, id), error => code(error, 'account-reconnect-required'));
  assert.equal((await row(id)).state, 'reconnect-required');
  assert.equal(platforms.reddit.calls.filter(call => call.method === 'refresh').length, 0);
});

test('PRODUCT 7, long-lived-exchange policy: the sweep refreshes Instagram days ahead without a refresh token', async () => {
  const { accounts, platforms, connect: connectAccount } = service();
  platforms.instagram.script(
    'exchangeCode',
    {
      accessToken: 'instagram-long-lived-1',
      refreshToken: null,
      expiresAt: minutes(3 * 24 * 60),
      scopes: ['fake.read', 'fake.publish'],
    },
    {
      accessToken: 'instagram-long-lived-gone',
      refreshToken: null,
      expiresAt: new Date(Date.now() + 1_000),
      scopes: ['fake.read', 'fake.publish'],
    },
  );
  platforms.linkedin.script('exchangeCode', {
    accessToken: 'linkedin-sweep-access',
    refreshToken: 'linkedin-sweep-refresh',
    expiresAt: minutes(3 * 24 * 60),
    scopes: ['fake.read', 'fake.publish'],
  });
  const instagram = await connectAccount({ platform: 'instagram' });
  const expired = await connectAccount({ platform: 'instagram' });
  const linkedin = await connectAccount({ platform: 'linkedin' });
  await new Promise(resolve => setTimeout(resolve, 1_100));
  platforms.instagram.script('refresh', {
    accessToken: 'instagram-long-lived-2',
    refreshToken: null,
    expiresAt: minutes(60 * 24 * 60),
    scopes: [],
  });
  const outcomes = await accounts.refreshDue(ws.id);
  const outcome = id => outcomes.find(item => item.accountId === id)?.outcome;
  assert.equal(outcome(instagram), 'refreshed');
  assert.equal(outcome(expired), 'reconnect-required', 'an expired long-lived token cannot be exchanged');
  assert.equal(outcome(linkedin), 'skipped', 'a refresh token is refreshed only within ten minutes of expiry');
  const [token] = platforms.instagram.calls.findLast(call => call.method === 'refresh').args;
  assert.equal(token.accessToken, 'instagram-long-lived-1');
  assert.equal(token.refreshToken, null);
  const stored = await row(instagram);
  assert.equal(stored.generation, 1);
  assert.equal(stored.credential_version, 2);
  assert.equal((await accounts.accessToken(ws.id, instagram)).token.accessToken, 'instagram-long-lived-2');
});

test('PRODUCT 7, none policy: nothing is refreshed and an expired token requires reconnect', async () => {
  const { accounts, platforms, connect: connectAccount } = service();
  const x = await workspaceApp(accounts, 'x');
  platforms.x.script(
    'exchangeCode',
    { accessToken: 'x-forever', refreshToken: null, expiresAt: null, scopes: ['fake.read', 'fake.publish'] },
    {
      accessToken: 'x-short',
      refreshToken: 'unused',
      expiresAt: new Date(Date.now() + 1_000),
      scopes: ['fake.read', 'fake.publish'],
    },
  );
  const forever = await connectAccount({ platform: 'x', platformAppId: x.id });
  const short = await connectAccount({ platform: 'x', platformAppId: x.id });
  assert.equal((await accounts.accessToken(ws.id, forever)).token.accessToken, 'x-forever');
  assert.equal((await accounts.accessToken(ws.id, short)).token.accessToken, 'x-short');
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await assert.rejects(accounts.accessToken(ws.id, short), error => code(error, 'account-reconnect-required'));
  assert.equal(platforms.x.calls.filter(call => call.method === 'refresh').length, 0);
});

test('PRODUCT 7: a refresh stuck for more than 30 seconds requires reconnect', async () => {
  const { accounts, connect: connectAccount } = service();
  const id = await connectAccount({ platform: 'linkedin' });
  await raw.query(
    `UPDATE ${table('tf_social_accounts')} SET state='refreshing',refresh_started_at=clock_timestamp()-make_interval(secs => $2) WHERE id=$1`,
    [id, staleRefreshMs / 1000 + 1],
  );
  assert.equal((await accounts.status(ws.id, admin().userId, id)).state, 'reconnect-required');
  await assert.rejects(accounts.accessToken(ws.id, id), error => code(error, 'account-reconnect-required'));
  const stored = await row(id);
  assert.equal(stored.state, 'reconnect-required');
  assert.equal(stored.generation, 2);
  assert.equal(stored.credential, null);

  const fresh = await connectAccount({ platform: 'linkedin' });
  await raw.query(
    `UPDATE ${table('tf_social_accounts')} SET state='refreshing',refresh_started_at=clock_timestamp() WHERE id=$1`,
    [fresh],
  );
  await assert.rejects(accounts.accessToken(ws.id, fresh), error => code(error, 'account-unavailable'));
  assert.equal((await row(fresh)).state, 'refreshing');
});

test('PRODUCT 7: a token the platform rejects stops work bound to it without switching accounts', async () => {
  const { accounts, connect: connectAccount } = service();
  const id = await connectAccount({ platform: 'linkedin' });
  await accounts.tokenRejected(ws.id, id, 99);
  assert.equal((await row(id)).state, 'active', 'a rejection for an older generation changes nothing');
  await accounts.tokenRejected(ws.id, id, 1);
  const stored = await row(id);
  assert.equal(stored.state, 'reconnect-required');
  assert.equal(stored.generation, 2);
  assert.ok(!generationCurrent(stored, 1));
  await assert.rejects(accounts.accessToken(ws.id, id), error => code(error, 'account-reconnect-required'));
});

test('PRODUCT 6: replacing a workspace app’s secret requires every affected connection to reconnect', async () => {
  const { accounts, connect: connectAccount, reconnect } = service();
  const app = await workspaceApp(accounts, 'reddit');
  const other = await workspaceApp(accounts, 'reddit');
  const one = await connectAccount({ platform: 'reddit', platformAppId: app.id });
  const two = await connectAccount({ platform: 'reddit', platformAppId: app.id });
  const untouched = await connectAccount({ platform: 'reddit', platformAppId: other.id });
  await assert.rejects(accounts.replaceAppSecret(ws.id, member.userId, app.id, { clientSecret: 'new' }), deniedAccess);
  const replaced = await accounts.replaceAppSecret(ws.id, admin().userId, app.id, { clientSecret: 'new-secret' });
  assert.equal(replaced.generation, 2);
  assert.ok(!JSON.stringify(replaced).includes('new-secret'));
  for (const id of [one, two]) {
    const stored = await row(id);
    assert.equal(stored.state, 'reconnect-required');
    assert.equal(stored.generation, 2);
    assert.equal(stored.credential, null);
    assert.ok((await audits(id)).includes('social-account.reconnect-required.app-replaced'));
  }
  assert.equal((await row(untouched)).state, 'active');
  const result = await reconnect(one);
  assert.equal(result.account.state, 'active');
  const stored = await row(one);
  assert.equal(stored.app_generation, 2);
  assert.equal(stored.generation, 3);
});

test('PRODUCT 6: a changed operator app requires reconnect; PRODUCT 5: a removed one leaves it disabled', async () => {
  const original = service();
  const id = await original.connect({ platform: 'linkedin' });
  const recorded = (await row(id)).app_fingerprint;
  assert.match(recorded, /^[a-f0-9]{64}$/);

  const removed = service({ env: {} });
  assert.equal((await removed.accounts.status(ws.id, admin().userId, id)).state, 'disabled');
  await assert.rejects(removed.accounts.accessToken(ws.id, id), error => code(error, 'platform-unavailable'));
  assert.equal((await row(id)).state, 'active', 'an app that comes back resumes the connection');
  assert.equal((await original.accounts.accessToken(ws.id, id)).account.generation, 1);

  const hostedNow = service({ hosted: hostedResolver });
  assert.equal(
    (await hostedNow.accounts.status(ws.id, admin().userId, id)).state,
    'disabled',
    'a hosted app does not stand in for the operator app',
  );

  const changed = service({ env: { ...everyOperatorApp, ...operatorEnv('SOCIAL_LINKEDIN', 'share', 'rotated') } });
  const status = await changed.accounts.status(ws.id, admin().userId, id);
  assert.equal(status.state, 'reconnect-required');
  assert.equal(status.capabilities.use, false);
  await assert.rejects(changed.accounts.accessToken(ws.id, id), error => code(error, 'account-reconnect-required'));
  const stored = await row(id);
  assert.equal(stored.state, 'reconnect-required');
  assert.equal(stored.generation, 2);
  const result = await changed.reconnect(id);
  assert.equal(result.account.state, 'active');
  assert.notEqual((await row(id)).app_fingerprint, recorded);
});

test('PRODUCT 1, 5: availability lists every platform and offers only shipped, configured ones', async () => {
  const { linkedin, x } = adapters();
  const { accounts } = service({
    env: operatorEnv('SOCIAL_LINKEDIN', 'community-management'),
    platforms: { linkedin, x },
  });
  await workspaceApp(accounts, 'x');
  const availability = await accounts.availability(ws.id, member.userId);
  assert.equal(availability.length, 9);
  assert.deepEqual(
    availability.find(item => item.platform === 'linkedin'),
    {
      platform: 'linkedin',
      available: true,
      reason: null,
      appSource: 'operator',
      accessTier: 'community-management',
      capabilities: ['publish', 'publish-public', 'analytics', 'comments'],
    },
  );
  assert.equal(availability.find(item => item.platform === 'x').appSource, 'workspace', 'a workspace app still counts');
  for (const platform of ['youtube', 'facebook', 'threads', 'pinterest', 'tiktok', 'instagram'])
    assert.equal(availability.find(item => item.platform === platform).reason, 'not-configured');
  await assert.rejects(
    accounts.begin(ws.id, admin().userId, session, { platform: 'youtube', ownership: { kind: 'personal' } }),
    error => code(error, 'platform-unavailable'),
  );
});

test('PRODUCT 7: disconnect clears the credential, raises generation and revokes at the platform', async () => {
  const { accounts, platforms, connect: connectAccount } = service();
  const id = await connectAccount({ platform: 'linkedin' });
  const result = await accounts.disconnect(ws.id, admin().userId, id);
  assert.equal(result.providerRevocation, 'revoked');
  assert.equal(result.account.state, 'disconnected');
  const [token, app] = platforms.linkedin.calls.findLast(call => call.method === 'revoke').args;
  assert.equal(token.accessToken, 'linkedin-access');
  assert.equal(app.clientId, 'SOCIAL_LINKEDIN-client');
  const stored = await row(id);
  assert.equal(stored.generation, 2);
  assert.equal(stored.credential, null);
  await assert.rejects(accounts.accessToken(ws.id, id), error => code(error, 'account-unavailable'));
  await assert.rejects(accounts.reconnect(ws.id, admin().userId, session, id), error =>
    code(error, 'account-conflict'),
  );

  platforms.linkedin.script('revoke', { throw: 'retry' });
  const failing = await connectAccount({ platform: 'linkedin' });
  assert.equal((await accounts.disconnect(ws.id, admin().userId, failing)).providerRevocation, 'failed');
  assert.equal((await row(failing)).state, 'disconnected');
});

test('PRODUCT 7: a business connection is begun by its owning team and managed through its grants', async () => {
  const { accounts, begin } = service();
  await assert.rejects(
    begin({ platform: 'linkedin', ownership: { kind: 'business', owningTeamId: teamId } }),
    deniedAccess,
    'the admin is not in the owning team',
  );
  const started = await begin(
    { platform: 'linkedin', ownership: { kind: 'business', owningTeamId: teamId } },
    member.userId,
  );
  await accounts.complete('c', started.state, session, member.userId);
  const status = await accounts.status(ws.id, member.userId, started.attemptId);
  assert.deepEqual(status.ownership, { kind: 'business', owningTeamId: teamId });
  assert.deepEqual(status.capabilities, { read: true, use: true, manage: true });
  await assert.rejects(accounts.status(ws.id, admin().userId, started.attemptId), deniedAccess);
  await assert.rejects(accounts.disconnect(ws.id, admin().userId, started.attemptId), deniedAccess);
  await assert.rejects(accounts.reconnect(ws.id, admin().userId, session, started.attemptId), deniedAccess);
});

test('PRODUCT 6: the runtime role cannot change which app a connection was authorized through', async () => {
  const { connect: connectAccount } = service();
  const id = await connectAccount({ platform: 'linkedin' });
  for (const column of ["app_source='hosted'", 'platform_app_id=NULL', "platform='x'", 'owner_membership_id=NULL'])
    await denied(raw, `UPDATE ${table('tf_social_accounts')} SET ${column} WHERE id=$1`, [id]);
  await assert.rejects(
    raw.query(`UPDATE ${table('tf_social_accounts')} SET app_fingerprint=NULL WHERE id=$1`, [id]),
    /check constraint/,
  );
});
