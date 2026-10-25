import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createSlackInstallations, slackCredentialCipher } from '../src/index.ts';

/** Runs a test with the `images` flag set for every workspace. */
function withImages(t, on) {
  const previous = process.env.FEATURE_FLAG_IMAGES;
  process.env.FEATURE_FLAG_IMAGES = String(on);
  t.after(() => {
    if (previous === undefined) delete process.env.FEATURE_FLAG_IMAGES;
    else process.env.FEATURE_FLAG_IMAGES = previous;
  });
}

async function installationFixture() {
  const db = await fixture();
  await loadPlatformBaseline(db.platform);
  const w = await db.create(await workspaceTableMigrations());
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    connectionsPerPool: 4,
    reservedConnections: 2,
    databaseConnectionBudget: 40,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  return {
    db,
    w,
    runtime,
    table: name => qualified(w.names.schema, name),
    async close() {
      await runtime.close();
      await db.close();
    },
  };
}

test('with images on, an installation without files:read or files:write asks for them and keeps working until they are granted', async t => {
  withImages(t, true);
  const f = await installationFixture();
  try {
    const config = {
      appId: 'ATEST',
      clientId: 'client',
      clientSecret: 'synthetic',
      signingSecret: 'synthetic-signing-secret',
      redirectUri: 'https://api.example.test/oauth',
      scopeApproval: { reference: 'fixture-approved-scopes', botScopes: ['chat:write'] },
    };
    const token = {
      ok: true,
      app_id: 'ATEST',
      team: { id: 'TONE' },
      token_type: 'bot',
      bot_user_id: 'UBOT',
      access_token: 'xoxb-synthetic',
      scope: 'chat:write',
    };
    let granted = token;
    const installations = createSlackInstallations({
      pool: f.db.platform,
      runtime: f.runtime,
      cipher: slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } }),
      fetcher: async () => Response.json(granted),
      config,
    });
    const start = async () => {
      const url = new URL((await installations.begin(f.w.id, f.w.userId, 'scope-session')).url);
      assert.equal(url.searchParams.get('scope'), 'chat:write,files:read,files:write');
      return url.searchParams.get('state');
    };
    // Slack granting only the configured scopes still activates it: shared files go unread, nothing else stops.
    assert.equal((await installations.complete('code', await start(), 'scope-session', f.w.userId)).state, 'active');
    const attention = await installations.status(f.w.id, f.w.userId);
    assert.equal(attention.state, 'permissions-required');
    assert.deepEqual(attention.missingScopes, ['files:read', 'files:write']);
    // An installation that has files:read from step 7 still asks for files:write, which image delivery needs.
    granted = { ...token, scope: 'chat:write,files:read' };
    assert.equal((await installations.complete('code', await start(), 'scope-session', f.w.userId)).state, 'active');
    const partial = await installations.status(f.w.id, f.w.userId);
    assert.equal(partial.state, 'permissions-required');
    assert.deepEqual(partial.missingScopes, ['files:write']);
    granted = { ...token, scope: 'chat:write,files:read,files:write' };
    assert.equal((await installations.complete('code', await start(), 'scope-session', f.w.userId)).state, 'active');
    const updated = await installations.status(f.w.id, f.w.userId);
    assert.equal(updated.state, 'active');
    assert.equal(updated.missingScopes, undefined);
    assert.deepEqual(
      (await f.db.platform.query(`SELECT scopes FROM ${f.table('tf_slack_installations')}`)).rows[0].scopes,
      ['chat:write', 'files:read', 'files:write'],
    );
  } finally {
    await f.close();
  }
});

test('with images off, files:read and files:write are not asked for', async t => {
  withImages(t, false);
  const f = await installationFixture();
  try {
    const installations = createSlackInstallations({
      pool: f.db.platform,
      runtime: f.runtime,
      cipher: slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } }),
      fetcher: async () =>
        Response.json({
          ok: true,
          app_id: 'ATEST',
          team: { id: 'TONE' },
          token_type: 'bot',
          bot_user_id: 'UBOT',
          access_token: 'xoxb-synthetic',
          scope: 'chat:write',
        }),
      config: {
        appId: 'ATEST',
        clientId: 'client',
        clientSecret: 'synthetic',
        signingSecret: 'synthetic-signing-secret',
        redirectUri: 'https://api.example.test/oauth',
        scopeApproval: { reference: 'fixture-approved-scopes', botScopes: ['chat:write'] },
      },
    });
    const url = new URL((await installations.begin(f.w.id, f.w.userId, 'scope-session')).url);
    assert.equal(url.searchParams.get('scope'), 'chat:write');
    await installations.complete('code', url.searchParams.get('state'), 'scope-session', f.w.userId);
    const status = await installations.status(f.w.id, f.w.userId);
    assert.equal(status.state, 'active');
    assert.equal(status.missingScopes, undefined);
  } finally {
    await f.close();
  }
});

test('approved Slack scope upgrades preserve identity and require current manager, session and actual consent', async t => {
  withImages(t, false);
  const db = await fixture();
  let runtime;
  try {
    await loadPlatformBaseline(db.platform);
    const w = await db.create(await workspaceTableMigrations());
    const table = name => qualified(w.names.schema, name);
    const member = randomUUID(),
      membership = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      membership,
      member,
    ]);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 40,
      resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
    });
    const config = {
      appId: 'ATEST',
      clientId: 'client',
      clientSecret: 'synthetic',
      signingSecret: 'synthetic-signing-secret',
      redirectUri: 'https://api.example.test/oauth',
      scopeApproval: { reference: 'fixture-approved-scopes', botScopes: ['chat:write'] },
    };
    const cipher = slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } });
    const token = {
      ok: true,
      app_id: 'ATEST',
      team: { id: 'TONE' },
      token_type: 'bot',
      bot_user_id: 'UBOT',
      access_token: 'xoxb-synthetic',
      scope: 'chat:write',
    };
    let granted = token;
    const options = { pool: db.platform, runtime, cipher, fetcher: async () => Response.json(granted) };
    const original = createSlackInstallations({ ...options, config });
    const initial = new URL((await original.begin(w.id, w.userId, 'scope-session')).url).searchParams.get('state');
    await original.complete('code', initial, 'scope-session', w.userId);
    const before = (await db.platform.query(`SELECT * FROM ${table('tf_slack_installations')}`)).rows[0];
    await db.platform.query(
      `INSERT INTO ${table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2)`,
      [before.id, membership],
    );
    const upgraded = createSlackInstallations({
      ...options,
      config: {
        ...config,
        scopeApproval: { ...config.scopeApproval, botScopes: ['chat:write', 'chat:write.customize'] },
      },
    });
    const attention = await upgraded.status(w.id, w.userId);
    assert.equal(attention.state, 'permissions-required');
    assert.deepEqual(attention.missingScopes, ['chat:write.customize']);
    assert.equal((await upgraded.status(w.id, member)).canManage, false);
    await assert.rejects(upgraded.begin(w.id, member, 'scope-session'));
    const start = async () => {
      const url = new URL((await upgraded.begin(w.id, w.userId, 'scope-session')).url);
      assert.equal(url.searchParams.get('scope'), 'chat:write,chat:write.customize');
      return url.searchParams.get('state');
    };
    const abandoned = await start(),
      state = await start();
    assert.equal((await upgraded.status(w.id, w.userId)).state, 'permissions-required');
    assert.deepEqual(
      (await db.platform.query(`SELECT bot_credential FROM ${table('tf_slack_installations')}`)).rows[0].bot_credential,
      before.bot_credential,
    );
    await assert.rejects(upgraded.complete('code', abandoned, 'scope-session', w.userId));
    await assert.rejects(upgraded.complete('code', state, 'other-session', w.userId));
    assert.equal((await upgraded.complete('code', state, 'scope-session', w.userId)).state, 'scope-missing');
    assert.equal((await upgraded.status(w.id, w.userId)).state, 'scope-missing');
    granted = { ...token, scope: 'chat:write,chat:write.customize', bot_user_id: 'UOTHER' };
    await assert.rejects(upgraded.complete('code', await start(), 'scope-session', w.userId));
    granted = { ...granted, bot_user_id: 'UBOT', team: { id: 'TOTHER' } };
    await assert.rejects(upgraded.complete('code', await start(), 'scope-session', w.userId));
    granted = { ...granted, team: { id: 'TONE' } };
    const finalState = await start();
    assert.equal((await upgraded.complete('code', finalState, 'scope-session', w.userId)).state, 'active');
    await assert.rejects(upgraded.complete('code', finalState, 'scope-session', w.userId));
    const after = (await db.platform.query(`SELECT * FROM ${table('tf_slack_installations')}`)).rows[0];
    assert.equal(after.id, before.id);
    assert.equal(after.generation, before.generation);
    assert.equal(after.accepts_events_after, before.accepts_events_after);
    assert.deepEqual(after.scopes, ['chat:write', 'chat:write.customize']);
    assert.equal((await upgraded.status(w.id, w.userId)).missingScopes, undefined);
    await assert.rejects(upgraded.begin(w.id, w.userId, 'scope-session'), /slack-installation-conflict/);
  } finally {
    await runtime?.close();
    await db.close();
  }
});
