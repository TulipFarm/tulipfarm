import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import {
  createSlackRecovery,
  createSlackMemberLinking,
  createSlackInbox,
  slackCredentialCipher,
} from '../src/index.ts';
import { encryptSlackToken } from '../src/credentials.ts';
import { memberProviderFixture } from './member-provider-fixture.mjs';

const config = {
  appId: 'ATEST',
  clientId: 'client',
  clientSecret: 'synthetic',
  signingSecret: 'synthetic-signing-secret',
  redirectUri: 'https://api.example.test/oauth',
  scopeApproval: { reference: 'test', botScopes: ['chat:write'] },
  memberLinking: {
    identityRedirectUri: 'https://api.example.test/identity',
    operationalRedirectUri: 'https://api.example.test/operational',
    distribution: 'internal',
    scopeApproval: {
      reference: 'test',
      userScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
    },
  },
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

async function setup() {
  const db = await fixture();
  await loadPlatformBaseline(db.platform);
  const w = await db.create(await workspaceTableMigrations());
  const table = name => qualified(w.names.schema, name),
    installationId = randomUUID(),
    identityId = randomUUID(),
    eventId = randomUUID();
  const cipher = slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } });
  const bot = { workspaceId: w.id, installationId, generation: 1, kind: 'bot' },
    user = { ...bot, kind: 'user', identityId, membershipId: w.membershipId, slackUserId: 'UPERSON' };
  const expired = binding => ({
    ...encryptSlackToken(cipher, binding, `xoxe.xox${binding.kind === 'bot' ? 'b' : 'p'}-old`, {
      refresh_token: `xoxe-${binding.kind}-old`,
      expires_in: 3600,
    }),
    rotation: {
      state: 'ready',
      expiresAt: Date.now() - 1000,
      refresh: cipher.encrypt(binding, `xoxe-${binding.kind}-old`),
    },
  });
  await db.platform.query(
    `INSERT INTO ${table('tf_slack_installations')}(id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES($1,'ATEST','TONE','UBOT',1,'active',$2,$3,0)`,
    [installationId, config.scopeApproval.botScopes, expired(bot)],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_slack_installation_grants')}(installation_id,membership_id) SELECT $1,id FROM ${table('tf_memberships')}`,
    [installationId],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_slack_identities')}(id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES($1,$2,1,'UPERSON',$3,$4,'authorized',$5,$6)`,
    [
      identityId,
      installationId,
      w.userId,
      w.membershipId,
      expired(user),
      config.memberLinking.scopeApproval.userScopes,
    ],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_slack_events')}(id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition) VALUES($1,$2,1,'original','original',1,$3,'held')`,
    [
      eventId,
      installationId,
      { type: 'message', channel: 'DONE', user: 'UPERSON', ts: '1.000001', text: 'original request' },
    ],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_slack_continuations')}(event_id,identity_id,state)VALUES($1,$2,'dispatch-held')`,
    [eventId, identityId],
  );
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    connectionsPerPool: 4,
    reservedConnections: 2,
    databaseConnectionBudget: 40,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  const requests = [];
  let mode = 'success',
    during = async () => {};
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/api/auth.test') {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer xoxe.xoxp-renewed') {
        res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }));
        return;
      }
      res.setHeader('x-oauth-scopes', config.memberLinking.scopeApproval.userScopes.join(','));
      res.end(JSON.stringify({ ok: true, team_id: mode === 'wrong-team' ? 'TOTHER' : 'TONE', user_id: 'UPERSON' }));
      return;
    }
    const token = new URLSearchParams(body).get('refresh_token');
    requests.push({ path: req.url, token });
    await during();
    if (mode === 'lost') {
      res.destroy();
      return;
    }
    const bot = token.includes('bot'),
      scopes = bot ? config.scopeApproval.botScopes : config.memberLinking.scopeApproval.userScopes;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        access_token: `xoxe.xox${bot ? 'b' : 'p'}-renewed`,
        refresh_token: `xoxe-${bot ? 'bot' : 'user'}-renewed`,
        expires_in: 43200,
        ...(bot
          ? {
              token_type: 'bot',
              app_id: 'ATEST',
              team: { id: mode === 'wrong-team' ? 'TOTHER' : 'TONE' },
              bot_user_id: 'UBOT',
              scope: scopes.join(','),
            }
          : { token_type: 'bearer', team: { id: 'TONE' } }),
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const fetcher = (url, init) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
  const recovery = createSlackRecovery({ runtime, config, cipher, fetcher });
  const credential = async kind =>
    (
      await db.platform.query(
        `SELECT ${kind === 'bot' ? 'bot_credential' : 'credential'} AS value FROM ${table(kind === 'bot' ? 'tf_slack_installations' : 'tf_slack_identities')}`,
      )
    ).rows[0].value;
  return {
    db,
    w,
    table,
    installationId,
    identityId,
    eventId,
    cipher,
    bot,
    user,
    runtime,
    recovery,
    requests,
    credential,
    expired,
    set(value) {
      mode = value.mode ?? mode;
      during = value.during ?? during;
    },
    async close() {
      await runtime.close();
      await new Promise(resolve => server.close(resolve));
      await db.close();
    },
  };
}

test('two workers rotate expired bot and user once over HTTP and keep the installation generation', async () => {
  const f = await setup();
  try {
    assert.throws(() => f.cipher.decrypt(f.bot, f.expired(f.bot)), /credential-unavailable/);
    await Promise.all([f.recovery.refresh(f.w.id), f.recovery.refresh(f.w.id)]);
    assert.equal(f.cipher.decrypt(f.bot, await f.credential('bot')), 'xoxe.xoxb-renewed');
    assert.equal(f.cipher.decrypt(f.user, await f.credential('user')), 'xoxe.xoxp-renewed');
    assert.deepEqual(
      f.requests.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: '/api/oauth.v2.access', token: 'xoxe-bot-old' },
        { path: '/api/oauth.v2.user.access', token: 'xoxe-user-old' },
      ],
    );
    assert.deepEqual(
      (await f.db.platform.query(`SELECT generation,state FROM ${f.table('tf_slack_installations')}`)).rows,
      [{ generation: 1, state: 'active' }],
    );
  } finally {
    await f.close();
  }
});

for (const mode of ['lost', 'wrong-team'])
  test(`${mode} refresh requires reconnect and never reuses the consumed token`, async () => {
    const f = await setup();
    try {
      f.set({ mode });
      await f.recovery.refresh(f.w.id);
      await f.recovery.refresh(f.w.id);
      for (const kind of ['bot', 'user']) assert.equal((await f.credential(kind)).rotation.state, 'reconnect-required');
      assert.equal(f.requests.length, 2);
      const credential = await f.credential('user');
      assert.throws(() => f.cipher.decrypt(f.user, credential), /credential-unavailable/);
    } finally {
      await f.close();
    }
  });

test('expired interrupted claim cannot retry and a late refresh reply cannot overwrite revocation', async () => {
  const f = await setup();
  try {
    const stored = await f.credential('bot');
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET bot_credential=$1`, [
      { ...stored, rotation: { state: 'refreshing', attempt: randomUUID(), deadline: Date.now() - 1 } },
    ]);
    const entered = deferred(),
      release = deferred();
    f.set({
      during: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const pending = f.recovery.refresh(f.w.id);
    await entered.promise;
    const inbox = createSlackInbox(f.runtime);
    await inbox.accept(
      { workspaceId: f.w.id, installationId: f.installationId, generation: 1 },
      {
        type: 'event_callback',
        api_app_id: 'ATEST',
        team_id: 'TONE',
        event_id: 'revoked',
        event_time: 2,
        event: { type: 'tokens_revoked', tokens: { oauth: ['UPERSON'], bot: [] } },
      },
    );
    release.resolve();
    await pending;
    assert.equal((await f.credential('bot')).rotation.state, 'reconnect-required');
    assert.equal(await f.credential('user'), null);
    assert.deepEqual(
      (await f.db.platform.query(`SELECT state,generation FROM ${f.table('tf_slack_installations')}`)).rows,
      [{ state: 'active', generation: 1 }],
    );
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test('same-user reconnect restores a held request but unlink cannot reconnect an old request', async () => {
  const f = await setup();
  try {
    const provider = await memberProviderFixture(config);
    const linker = createSlackMemberLinking({
      runtime: f.runtime,
      config,
      cipher: f.cipher,
      installations: { route: async () => ({ workspaceId: f.w.id, installationId: f.installationId, generation: 1 }) },
      fetcher: provider.fetcher,
    });
    assert.deepEqual(await linker.status(f.w.id, f.eventId, f.w.userId), {
      state: 'reconnect-required',
      execution: 'disabled',
    });
    const flow = await linker.begin(f.w.id, f.eventId, f.w.userId, 'session'),
      url = new URL(flow.url),
      state = url.searchParams.get('state');
    provider.set({ nonce: url.searchParams.get('nonce') });
    await linker.proveIdentity(state, flow.browser, 'identity');
    await linker.consent(state, flow.browser, f.w.userId, 'session');
    await linker.complete(state, flow.browser, 'operational', f.w.userId, 'session');
    assert.equal(f.cipher.decrypt(f.user, await f.credential('user')), 'xoxp-synthetic-user-token');
    assert.deepEqual(await linker.status(f.w.id, f.eventId, f.w.userId), {
      state: 'dispatch-held',
      execution: 'disabled',
    });
    await linker.unlink(f.w.id, f.w.userId);
    await assert.rejects(linker.begin(f.w.id, f.eventId, f.w.userId, 'session'));
    assert.deepEqual(await linker.status(f.w.id, f.eventId, f.w.userId), { state: 'cancelled', execution: 'disabled' });
  } finally {
    await f.close();
  }
});
