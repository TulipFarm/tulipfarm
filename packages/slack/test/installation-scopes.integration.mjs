import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createSlackInstallations, createSlackInbox, slackCredentialCipher } from '../src/index.ts';

/** Bot scopes every installation asks for beyond the configured ones. */
const extraScopes = ['files:read', 'files:write', 'canvases:write', 'assistant:write', 'reactions:read', 'emoji:read'];

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

test('external Slack revocation needs repair while deliberate disconnect remains neutral with saved scopes', async () => {
  const f = await installationFixture();
  try {
    const installations = createSlackInstallations({
      pool: f.db.platform,
      runtime: f.runtime,
      cipher: slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } }),
      config: {
        appId: 'ATEST',
        clientId: 'client',
        clientSecret: 'synthetic',
        signingSecret: 'synthetic-signing-secret',
        redirectUri: 'https://api.example.test/oauth',
        scopeApproval: { reference: 'fixture-approved-scopes', botScopes: ['chat:write'] },
      },
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
    });
    const inbox = createSlackInbox(f.runtime);
    for (const event of [
      { type: 'tokens_revoked', tokens: { oauth: [], bot: ['UBOT'] } },
      { type: 'app_uninstalled' },
    ]) {
      const url = new URL((await installations.begin(f.w.id, f.w.userId, 'connection-session')).url);
      await installations.complete('code', url.searchParams.get('state'), 'connection-session', f.w.userId);
      const row = (
        await f.db.platform.query(`SELECT id,generation,accepts_events_after FROM ${f.table('tf_slack_installations')}`)
      ).rows[0];
      await inbox.accept(
        { workspaceId: f.w.id, installationId: row.id, generation: row.generation },
        {
          type: 'event_callback',
          api_app_id: 'ATEST',
          team_id: 'TONE',
          event_id: randomUUID(),
          event_time: Number(row.accepts_events_after) + 1,
          event,
        },
      );
      const revoked = await installations.status(f.w.id, f.w.userId);
      assert.equal(revoked.state, 'reconnect-required');
      assert.deepEqual(revoked.scopes, ['chat:write']);
      await installations.disconnect(f.w.id, f.w.userId);
      const disconnected = await installations.status(f.w.id, f.w.userId);
      assert.equal(disconnected.state, 'revoked');
      assert.deepEqual(disconnected.scopes, ['chat:write']);
    }
  } finally {
    await f.close();
  }
});

test('an installation without the extra scopes asks for them and keeps working until they are granted', async () => {
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
      assert.equal(url.searchParams.get('scope'), ['chat:write', ...extraScopes].join(','));
      return url.searchParams.get('state');
    };
    // Slack granting only the configured scopes still activates it: shared files go unread, nothing else stops.
    assert.equal((await installations.complete('code', await start(), 'scope-session', f.w.userId)).state, 'active');
    const attention = await installations.status(f.w.id, f.w.userId);
    assert.equal(attention.state, 'permissions-required');
    assert.deepEqual(attention.missingScopes, extraScopes);
    // An installation that has files:read still asks for the rest, such as files:write for image delivery.
    granted = { ...token, scope: 'chat:write,files:read' };
    assert.equal((await installations.complete('code', await start(), 'scope-session', f.w.userId)).state, 'active');
    const partial = await installations.status(f.w.id, f.w.userId);
    assert.equal(partial.state, 'permissions-required');
    assert.deepEqual(partial.missingScopes, extraScopes.slice(1));
    granted = { ...token, scope: ['chat:write', ...extraScopes].join(',') };
    assert.equal((await installations.complete('code', await start(), 'scope-session', f.w.userId)).state, 'active');
    const updated = await installations.status(f.w.id, f.w.userId);
    assert.equal(updated.state, 'active');
    assert.equal(updated.missingScopes, undefined);
    assert.deepEqual(
      (await f.db.platform.query(`SELECT scopes FROM ${f.table('tf_slack_installations')}`)).rows[0].scopes,
      ['chat:write', ...extraScopes],
    );
  } finally {
    await f.close();
  }
});

test('approved Slack scope upgrades preserve identity and require current manager, session and actual consent', async () => {
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
      scope: ['chat:write', ...extraScopes].join(','),
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
      assert.equal(url.searchParams.get('scope'), ['chat:write', 'chat:write.customize', ...extraScopes].join(','));
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
    granted = {
      ...token,
      scope: ['chat:write', 'chat:write.customize', ...extraScopes].join(','),
      bot_user_id: 'UOTHER',
    };
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
    assert.deepEqual(after.scopes, ['chat:write', 'chat:write.customize', ...extraScopes]);
    assert.equal((await upgraded.status(w.id, w.userId)).missingScopes, undefined);
    await assert.rejects(upgraded.begin(w.id, w.userId, 'scope-session'), /slack-installation-conflict/);
  } finally {
    await runtime?.close();
    await db.close();
  }
});

test('a new installation is open to every member and managed by every admin until a manager narrows it', async () => {
  const f = await installationFixture();
  try {
    const members = { member: randomUUID(), admin: randomUUID(), reader: randomUUID() };
    for (const [role, userId] of Object.entries(members))
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,$3)`, [
        randomUUID(),
        userId,
        role === 'admin' ? 'admin' : 'member',
      ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) SELECT m.id,t.id FROM ${f.table('tf_memberships')} m, ${f.table('tf_teams')} t WHERE m.user_id=$1 AND t.name='_admin'`,
      [members.admin],
    );
    const installations = createSlackInstallations({
      pool: f.db.platform,
      runtime: f.runtime,
      cipher: slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } }),
      config: {
        appId: 'ATEST',
        clientId: 'client',
        clientSecret: 'synthetic',
        signingSecret: 'synthetic-signing-secret',
        redirectUri: 'https://api.example.test/oauth',
        scopeApproval: { reference: 'fixture-approved-scopes', botScopes: ['chat:write'] },
      },
      fetcher: async () =>
        Response.json({
          ok: true,
          app_id: 'ATEST',
          team: { id: 'TONE' },
          token_type: 'bot',
          bot_user_id: 'UBOT',
          access_token: 'xoxb-synthetic',
          scope: ['chat:write', ...extraScopes].join(','),
        }),
    });
    const url = new URL((await installations.begin(f.w.id, members.member, 'member-session')).url);
    await installations.complete('code', url.searchParams.get('state'), 'member-session', members.member);

    // Any member may connect Slack; once connected every member may use it and every admin may manage it.
    const asReader = await installations.status(f.w.id, members.reader);
    assert.equal(asReader.state, 'active');
    assert.equal(asReader.canManage, false);
    const asAdmin = await installations.status(f.w.id, members.admin);
    assert.equal(asAdmin.state, 'active');
    assert.equal(asAdmin.canManage, true);

    const sharing = await installations.grants(f.w.id, members.admin);
    assert.deepEqual(
      sharing.teams.map(team => team.name),
      ['Everyone', 'Admin'],
    );
    const [everyone, admins] = sharing.teams.map(team => team.id);
    assert.deepEqual(sharing.use.teamIds, [everyone]);
    assert.deepEqual(sharing.managers.teamIds, [admins]);

    await installations.grants(f.w.id, members.admin, {
      use: { memberIds: [], teamIds: [admins] },
      managers: sharing.managers,
      expectedVersion: sharing.expectedVersion,
    });
    assert.equal((await installations.status(f.w.id, members.admin)).state, 'active');
    assert.equal((await installations.status(f.w.id, members.reader)).state, 'unavailable');
  } finally {
    await f.close();
  }
});

test('the default-sharing migration opens installations made before it', async () => {
  const f = await installationFixture();
  try {
    const installationId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,accepts_events_after) VALUES ($1,'ATEST','TONE','UBOT',1,'revoked','{chat:write}',0)`,
      [installationId],
    );
    const sql = await readFile(
      new URL('../../workspace-storage/common/0086_slack_default_sharing.sql', import.meta.url),
      'utf8',
    );
    for (let run = 0; run < 2; run++) await f.db.platform.query(sql.replaceAll('{{schema}}', f.w.names.schema));
    const granted = async name =>
      (
        await f.db.platform.query(
          `SELECT t.name FROM ${f.table(name)} g JOIN ${f.table('tf_teams')} t ON t.id=g.team_id WHERE g.installation_id=$1`,
          [installationId],
        )
      ).rows.map(row => row.name);
    assert.deepEqual(await granted('tf_slack_installation_grants'), ['_everyone']);
    assert.deepEqual(await granted('tf_slack_installation_managers'), ['_admin']);
  } finally {
    await f.close();
  }
});
