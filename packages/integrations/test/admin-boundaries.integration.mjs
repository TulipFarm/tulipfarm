import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from './fixture.mjs';
import { createWorkspaceMcp } from '../../workspace-mcp/dist/index.js';
import { canAccessAsset, requireMcpSource } from '../../access/dist/index.js';
import { createAtlassianAccounts } from '../../atlassian/dist/accounts.js';
import { createSlackInstallations, slackCredentialCipher } from '../../slack/dist/index.js';
import { requireSlackInstallationUse } from '../../slack/dist/installation-access.js';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('ordinary token creator manages explicit person/team grants; unrelated admin cannot use, share, or take over', async () => {
  const f = await fixture();
  try {
    const { service: s, workspaceId: w, member: creator, actor: admin, input, teamId } = f;
    const created = await s.create(w, creator, input);
    assert.deepEqual(created.capabilities, { read: true, use: true, manage: true, administer: true });
    assert.deepEqual(await s.list(w, admin), { integrations: [] });
    for (const operation of [
      () => s.get(w, admin, input.id),
      () => s.update(w, admin, input.id, { name: 'stolen' }),
      () => s.setGrants(w, admin, input.id, { expectedGrantsVersion: 1, grants: [], sourceGrants: [] }),
      () => s.readIssue(w, admin, f.request()),
    ])
      await assert.rejects(operation(), /not found/);
    await assert.rejects(s.readIssue(w, creator, f.request()), /not found/);
    const personGrants = [
      { memberId: creator.membershipId, permissions: ['read', 'use', 'manage'] },
      { memberId: admin.membershipId, permissions: ['read', 'use'] },
    ];
    await s.setGrants(w, creator, input.id, { expectedGrantsVersion: 1, grants: [], sourceGrants: [], personGrants });
    await assert.rejects(s.readIssue(w, admin, f.request()), /not found/);
    const sourcePersonGrants = [creator, admin].map(actor => ({
      memberId: actor.membershipId,
      sourceId: input.repositories[0].id,
    }));
    await s.setGrants(w, creator, input.id, {
      expectedGrantsVersion: 2,
      grants: [],
      sourceGrants: [],
      personGrants,
      sourcePersonGrants,
    });
    assert.equal((await s.readIssue(w, admin, f.request())).title, 'Issue title');
    assert.equal((await s.readIssue(w, creator, f.request())).title, 'Issue title');
    await assert.rejects(s.rotate(w, admin, input.id, { expectedGeneration: 1, token: 'takeover' }), /not found/);
    const source = {
      kind: 'github-source',
      integrationId: input.id,
      sourceId: input.repositories[0].id,
      generation: 1,
      grantsVersion: 3,
    };
    const retained = actor =>
      f.runtime.transaction(
        w,
        commonCompatibility,
        async tx =>
          (
            await tx.client.query(`SELECT ${f.table('tf_table_source_allowed')}($1,$2,$3) AS allowed`, [
              actor.membershipId,
              actor.userId,
              source,
            ])
          ).rows[0].allowed,
      );
    assert.equal(await retained(admin), true);
    await s.setGrants(w, creator, input.id, {
      expectedGrantsVersion: 3,
      grants: [{ teamId, permissions: ['read', 'use'] }],
      sourceGrants: [{ teamId, sourceId: input.repositories[0].id }],
      personGrants: personGrants.slice(0, 1),
      sourcePersonGrants: [],
    });
    source.grantsVersion = 4;
    assert.equal(await retained(admin), false);
    assert.equal(await retained(creator), true);
    await assert.rejects(s.readIssue(w, admin, f.request()), /not found/);
    await assert.rejects(
      s.setGrants(w, creator, input.id, { expectedGrantsVersion: 4, grants: [], sourceGrants: [], personGrants: [] }),
      /not found/,
    );
    await f.owner.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      creator.membershipId,
    ]);
    await assert.rejects(
      s.setGrants(w, admin, input.id, { expectedGrantsVersion: 4, grants: [], sourceGrants: [] }),
      /not found/,
    );
    await assert.rejects(s.get(w, creator, input.id), /not found/);
    assert.equal(JSON.stringify(created).includes(input.token), false);
  } finally {
    await f.close();
  }
});

test('shared MCP creator, managers and use grants are separate; history and orphan recovery remain requester-only', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, member: creator, actor: admin } = f;
    const s = createWorkspaceMcp({
      runtime: f.runtime,
      keyring: f.keyring,
      admissionEnabled: true,
      dispatchEnabled: true,
      resolveConfirmationCredential: async () => f.url('confirmation'),
      protocol: {
        discover: async () => ({ tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }] }),
        call: async () => {
          throw new Error('unknown outcome');
        },
      },
      authorizeOrigin: async () => ({ sources: [], allowedTools: null }),
      authorizeSources: async () => {},
    });
    const c = await s.create(w, creator, {
      ownership: 'shared',
      name: 'Shared',
      endpoint: 'https://mcp.example.com',
      credential: { kind: 'bearer', token: 'private-credential' },
    });
    assert.deepEqual(c.capabilities, { read: true, manage: true, use: true });
    assert.deepEqual(await s.list(w, admin), []);
    await assert.rejects(
      s.setGrants(w, admin, c.id, { expectedVersion: 1, memberIds: [admin.membershipId], teamIds: [] }),
      /not found/,
    );
    await s.setGrants(w, creator, c.id, {
      expectedVersion: 1,
      memberIds: [creator.membershipId, admin.membershipId],
      teamIds: [],
      managers: { memberIds: [creator.membershipId], teamIds: [] },
    });
    assert.equal((await s.status(w, admin, c.id)).capabilities.manage, false);
    const tools = await s.discover(w, creator, c.id);
    await s.reviewTools(
      w,
      creator,
      c.id,
      tools.map(t => ({ name: t.name, revision: t.discovered_revision, enabled: true, standingException: true })),
    );
    const origin = { kind: 'private-chat', conversationId: randomUUID(), turnId: randomUUID(), stepId: randomUUID() };
    const catalog = await s.catalog(w, creator, origin);
    const action = await s.propose(w, creator, {
      id: randomUUID(),
      origin,
      handle: catalog.tools[0].handle,
      arguments: { private: 'requester-only' },
    });
    await s.decide(w, creator, action.id, { digest: action.digest, decision: 'approve' });
    assert.equal((await s.dispatch(w, action.id)).status, 'outcome-unknown');
    await assert.rejects(s.action(w, admin, action.id), /not found/);
    await assert.rejects(s.actionStatus(w, admin, action.id), /not found/);
    assert.deepEqual((await s.actions(w, admin, { kind: 'integration', originId: c.id })).actions, []);
    assert.equal((await s.status(w, admin, c.id)).barrierActionId, null);
    const current = await s.status(w, creator, c.id);
    const source = { kind: 'mcp-integration', integrationId: c.id, authorizationEpoch: current.authorizationEpoch };
    await f.runtime.transaction(w, commonCompatibility, tx => requireMcpSource(tx, admin, source));
    await s.setGrants(w, creator, c.id, {
      expectedVersion: current.grantsVersion,
      memberIds: [creator.membershipId],
      teamIds: [],
      managers: { memberIds: [creator.membershipId, admin.membershipId], teamIds: [] },
    });
    assert.equal((await s.status(w, admin, c.id)).capabilities.manage, true);
    assert.equal((await s.status(w, admin, c.id)).capabilities.use, false);
    await assert.rejects(
      f.runtime.transaction(w, commonCompatibility, tx => requireMcpSource(tx, admin, source)),
      /not found/,
    );
    await f.owner.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      creator.membershipId,
    ]);
    await assert.rejects(s.actionStatus(w, admin, action.id), /not found/);
    await assert.rejects(s.recoverAction(w, admin, action.id), /not found/);
    await assert.rejects(
      s.reconcile(w, admin, action.id, { observation: 'completed', notes: 'take over' }),
      /not found/,
    );
    assert.deepEqual(await s.recoveryActions(w, admin, c.id), []);
    const personal = await s.create(w, admin, {
      ownership: 'personal',
      name: 'Private',
      endpoint: 'https://mcp.example.com',
      credential: { kind: 'none' },
    });
    await assert.rejects(
      s.setGrants(w, admin, personal.id, { expectedVersion: 1, memberIds: [], teamIds: [] }),
      /not found/,
    );
  } finally {
    await f.close();
  }
});

test('ordinary members create business Atlassian accounts; explicit managers survive owner departure without private account access', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, member: creator, actor: admin } = f;
    const s = createAtlassianAccounts({
      runtime: f.runtime,
      keyring: f.keyring,
      configurations: {
        trello: {
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'https://api.example.com/callback',
          scopes: ['read:member:trello'],
        },
      },
      fetcher: async url =>
        String(url).endsWith('/token')
          ? Response.json({ access_token: 'private-token', expires_in: 3600 })
          : Response.json({ id: 'abcdef123456abcdef123456', username: 'person' }),
    });
    const start = await s.begin(w, creator.userId, 'session', { protocol: 'trello', ownership: { kind: 'business' } });
    await s.complete('code', new URL(start.url).searchParams.get('state'), 'session', creator.userId);
    assert.equal((await s.status(w, creator.userId, start.accountId)).capabilities.manage, true);
    assert.deepEqual((await s.list(w, admin.userId)).accounts, []);
    await assert.rejects(s.reconnect(w, admin.userId, 'session', start.accountId), /not found/);
    await s.setGrants(w, creator.userId, start.accountId, {
      expectedVersion: 1,
      memberIds: [admin.membershipId],
      teamIds: [],
      managers: { memberIds: [creator.membershipId, admin.membershipId], teamIds: [] },
    });
    assert.equal((await s.status(w, admin.userId, start.accountId)).capabilities.use, true);
    await s.setGrants(w, admin.userId, start.accountId, { expectedVersion: 2, memberIds: [], teamIds: [] });
    assert.equal((await s.status(w, admin.userId, start.accountId)).capabilities.use, false);
    await assert.rejects(
      s.withAccessToken(w, admin.userId, start.accountId, async () => 'leaked'),
      /not found/,
    );
    const personal = await s.begin(w, creator.userId, 'session', {
      protocol: 'trello',
      ownership: { kind: 'personal' },
    });
    await assert.rejects(s.status(w, admin.userId, personal.accountId), /not found/);
    await f.owner.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      creator.membershipId,
    ]);
    assert.equal((await s.disconnect(w, admin.userId, start.accountId)).account.state, 'disconnected');
    await assert.rejects(s.status(w, admin.userId, personal.accountId), /not found/);
  } finally {
    await f.close();
  }
});

test('Slack installer can share use and management; admin cannot reconnect or seize a managerless installation', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, member: creator, actor: admin } = f;
    const config = {
      appId: 'ATEST',
      clientId: 'client',
      clientSecret: 'synthetic',
      signingSecret: 'synthetic-signing-secret',
      redirectUri: 'https://api.example.test/oauth',
      scopeApproval: { reference: 'test', botScopes: ['chat:write'] },
    };
    const s = createSlackInstallations({
      pool: f.owner,
      runtime: f.runtime,
      config,
      cipher: slackCredentialCipher(f.keyring),
      fetcher: async () =>
        Response.json({
          ok: true,
          app_id: 'ATEST',
          access_token: 'xoxb-synthetic-secret',
          token_type: 'bot',
          scope: 'chat:write',
          bot_user_id: 'UBOT',
          team: { id: 'TONE' },
        }),
    });
    const started = await s.begin(w, creator.userId, 'session');
    await s.complete('code', new URL(started.url).searchParams.get('state'), 'session', creator.userId);
    assert.equal((await s.status(w, creator.userId)).canManage, true);
    assert.equal((await s.status(w, admin.userId)).state, 'unavailable');
    await assert.rejects(s.begin(w, admin.userId, 'session'), /not found/);
    await assert.rejects(s.disconnect(w, admin.userId), /not found/);
    await assert.rejects(s.grants(w, admin.userId), /not found/);
    let grants = await s.grants(w, creator.userId);
    grants = await s.grants(w, creator.userId, {
      ...grants,
      use: { memberIds: [creator.membershipId, admin.membershipId], teamIds: [] },
    });
    assert.equal((await s.status(w, admin.userId)).canManage, false);
    const { id } = (await f.owner.query(`SELECT id FROM ${f.table('tf_slack_installations')}`)).rows[0];
    await f.runtime.transaction(w, commonCompatibility, tx => requireSlackInstallationUse(tx, admin, id));
    grants = await s.grants(w, creator.userId, {
      ...grants,
      use: { memberIds: [creator.membershipId], teamIds: [] },
      managers: { memberIds: [creator.membershipId, admin.membershipId], teamIds: [] },
    });
    assert.equal((await s.status(w, admin.userId)).canManage, true);
    await assert.rejects(
      f.runtime.transaction(w, commonCompatibility, tx => requireSlackInstallationUse(tx, admin, id)),
      /not found/,
    );
    await assert.rejects(
      s.grants(w, admin.userId, { ...grants, managers: { memberIds: [], teamIds: [] } }),
      /not found/,
    );
    await s.grants(w, admin.userId, { ...grants, managers: { memberIds: [creator.membershipId], teamIds: [] } });
    await f.owner.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      creator.membershipId,
    ]);
    await assert.rejects(s.begin(w, admin.userId, 'session'), /not found/);
    await assert.rejects(s.grants(w, admin.userId, grants), /not found/);
    assert.equal(JSON.stringify(await s.status(w, admin.userId)).includes('synthetic-secret'), false);
  } finally {
    await f.close();
  }
});

test('existing Slack installation adopts only its proven installer once; departure leaves it locked', async () => {
  const f = await fixture();
  try {
    const { workspaceId: w, member: installer, actor: admin } = f;
    const config = {
      appId: 'ATEST',
      clientId: 'client',
      clientSecret: 'synthetic',
      signingSecret: 'synthetic-signing-secret',
      redirectUri: 'https://api.example.test/oauth',
      scopeApproval: { reference: 'test', botScopes: ['chat:write'] },
    };
    const s = createSlackInstallations({
      pool: f.owner,
      runtime: f.runtime,
      config,
      cipher: slackCredentialCipher(f.keyring),
      fetcher: async () => {
        throw new Error('provider must not be called');
      },
    });
    const id = randomUUID();
    await f.owner.query(
      `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'ATEST','TADOPT','UBOT',1,'active','{chat:write}','{}',0)`,
      [id],
    );
    await f.owner.query(
      `INSERT INTO app.slack_workspace_links (workspace_id,installation_id,app_id,team_id,generation,state,state_hash,session_id,user_id,membership_id,expires_at) VALUES ($1,$2,'ATEST','TADOPT',1,'active',$3,'session',$4,$5,now())`,
      [w, id, randomUUID(), installer.userId, installer.membershipId],
    );
    assert.equal((await s.status(w, admin.userId)).state, 'unavailable');
    await assert.rejects(s.begin(w, admin.userId, 'session'), /not found/);
    await assert.rejects(s.grants(w, admin.userId), /not found/);
    const adopted = await s.status(w, installer.userId);
    assert.equal(adopted.canManage, true);
    assert.equal(adopted.state, 'active');
    await s.status(w, installer.userId);
    assert.deepEqual(
      (
        await f.owner.query(
          `SELECT actor_id FROM ${f.table('tf_audit_events')} WHERE operation='slack-installation.adopt' AND subject_id=$1`,
          [id],
        )
      ).rows,
      [{ actor_id: installer.membershipId }],
    );
    assert.deepEqual((await s.grants(w, installer.userId)).managers, {
      memberIds: [installer.membershipId],
      teamIds: [],
    });
    await f.owner.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      installer.membershipId,
    ]);
    // Even if platform evidence later names the admin, an adopted installation is never re-adopted.
    await f.owner.query(`UPDATE app.slack_workspace_links SET user_id=$2,membership_id=$3 WHERE workspace_id=$1`, [
      w,
      admin.userId,
      admin.membershipId,
    ]);
    assert.equal((await s.status(w, admin.userId)).state, 'unavailable');
    await assert.rejects(s.begin(w, admin.userId, 'session'), /not found/);
    await assert.rejects(s.disconnect(w, admin.userId), /not found/);
    assert.equal(
      (
        await f.owner.query(
          `SELECT count(*)::integer AS count FROM ${f.table('tf_slack_installation_managers')} WHERE membership_id=$1`,
          [admin.membershipId],
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await f.close();
  }
});

test('managers keep existing private-team grants but cannot add teams they do not belong to', async () => {
  const f = await fixture();
  try {
    const { service: s, workspaceId: w, member: creator, input, otherTeamId } = f;
    await s.create(w, creator, input);
    await f.owner.query(
      `INSERT INTO ${f.table('tf_integration_grants')} (integration_id,team_id,permission) VALUES ($1,$2,'read')`,
      [input.id, otherTeamId],
    );
    const retained = [{ teamId: otherTeamId, permissions: ['read'] }];
    const saved = await s.setGrants(w, creator, input.id, {
      expectedGrantsVersion: 1,
      grants: retained,
      sourceGrants: [],
    });
    assert.deepEqual(saved.grants, retained);
    await s.setGrants(w, creator, input.id, { expectedGrantsVersion: 2, grants: [], sourceGrants: [] });
    await assert.rejects(
      s.setGrants(w, creator, input.id, { expectedGrantsVersion: 3, grants: retained, sourceGrants: [] }),
      /not found/,
    );
  } finally {
    await f.close();
  }
});

test('admin status bypasses only resource permissions; integration and Slack assets need person or team grants', async () => {
  const f = await fixture();
  try {
    const { service: s, workspaceId: w, member: creator, actor: admin, input, teamId } = f;
    await s.create(w, creator, input);
    const destination = randomUUID();
    await f.owner.query(
      `INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'slack.message.send')`,
      [teamId, destination],
    );
    const can = (actor, id, permission) =>
      f.runtime.transaction(w, commonCompatibility, tx => canAccessAsset(tx, actor, id, permission));
    assert.equal(await can(admin, randomUUID(), 'table.row.read'), true);
    for (const permission of ['integration.read', 'integration.use', 'integration.manage'])
      assert.equal(await can(admin, input.id, permission), false, permission);
    assert.equal(await can(admin, input.repositories[0].id, 'github.issue.read'), false);
    assert.equal(await can(admin, destination, 'slack.message.send'), false);
    assert.equal(await can(admin, teamId, 'integration.create'), false);
    assert.equal(await can(creator, destination, 'slack.message.send'), true);
    for (const permission of ['integration.read', 'integration.use', 'integration.manage'])
      assert.equal(await can(creator, input.id, permission), true, permission);
    await f.owner.query(
      `INSERT INTO ${f.table('tf_integration_person_grants')} (integration_id,membership_id,permission) VALUES ($1,$2,'use')`,
      [input.id, admin.membershipId],
    );
    assert.equal(await can(admin, input.id, 'integration.use'), false, 'use still requires read');
    await f.owner.query(
      `INSERT INTO ${f.table('tf_integration_person_grants')} (integration_id,membership_id,permission) VALUES ($1,$2,'read')`,
      [input.id, admin.membershipId],
    );
    assert.equal(await can(admin, input.id, 'integration.use'), true);
    assert.equal(await can(admin, input.id, 'integration.manage'), false);
    await f.owner.query(
      `INSERT INTO ${f.table('tf_integration_source_person_grants')} (integration_id,source_id,membership_id) VALUES ($1,$2,$3)`,
      [input.id, input.repositories[0].id, admin.membershipId],
    );
    assert.equal(await can(admin, input.repositories[0].id, 'github.issue.read'), true);
  } finally {
    await f.close();
  }
});
