import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { createAuth } from '../src/auth.ts';
import { registerWorkspaceMembers } from '../src/workspace-members.ts';
import {
  fixture,
  loadPlatformBaseline,
  markWorkspaceReady,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createMemberProfileProjection, memberProfileSource } from '@tulipfarm/workspaces/member-profiles';
import { createTableService } from '@tulipfarm/tables/service';
import { activeGeneration, workspaceMembersTable } from '@tulipfarm/tables/store';
import { manualWorkspaceMemberValues } from '@tulipfarm/tables/workspace-members';
import { observeExternalHandle } from '@tulipfarm/integrations/member-identities';

test(
  'workspace member identities API exposes verified links, manages manual handles with permissions, and searches aliases',
  { timeout: 45000 },
  async t => {
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app', max: 2 });
    cleanup.push(() => pool.end());
    const deliveries = [];
    const auth = createAuth(
      pool,
      async ({ url }) => {
        deliveries.push(url);
      },
      async () => {},
    );
    const signIn = async name => {
      const email = `${randomUUID()}@example.test`;
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: 'http://localhost:5173' }),
        body: { email, name },
      });
      const response = await auth.handler(new Request(deliveries.pop()));
      const cookie = response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      assert.ok(session);
      return { id: session.user.id, cookie };
    };

    const admin = await signIn('Admin');
    const member = await signIn('Member');
    const outsider = await signIn('Outsider');

    const workspace = await db.create(db.baseline, { userId: admin.id });
    await markWorkspaceReady(db.platform, workspace.id);
    const s = `"${workspace.names.schema}"`;

    const memberMembershipId = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      memberMembershipId,
      member.id,
    ]);
    const adminMembershipId = (
      await db.platform.query(`SELECT id FROM ${s}.tf_memberships WHERE user_id = $1`, [admin.id])
    ).rows[0].id;

    const runtime = createWorkspaceRuntime({
      resolveCredential: async id => {
        assert.equal(id, workspace.id);
        return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
      },
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    cleanup.push(() => runtime.close());

    const projection = createMemberProfileProjection({
      runtime,
      source: memberProfileSource(pool),
      discover: async after => (after ? [] : [workspace.id]),
    });
    assert.equal((await projection.project(workspace.id)).applied, 2);

    const adminMemberId = (
      await db.platform.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE membership_id = $1`, [
        adminMembershipId,
      ])
    ).rows[0].member_id;
    const memberMemberId = (
      await db.platform.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE membership_id = $1`, [
        memberMembershipId,
      ])
    ).rows[0].member_id;

    const generation = await runtime.transaction(workspace.id, commonCompatibility, async tx =>
      activeGeneration(tx, (await workspaceMembersTable(tx)).coreDefinition.id),
    );
    const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
    const manual = await tables.mutate(workspace.id, admin.id, {
      kind: 'create',
      tableId: generation.table_id,
      revision: generation.revision,
      recordId: randomUUID(),
      values: manualWorkspaceMemberValues({ name: 'Contractor Maya' }),
    });

    const slackInstallId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${s}.tf_slack_installations
        (id, app_id, team_id, bot_user_id, generation, state, scopes, bot_credential, accepts_events_after)
      VALUES ($1, 'A0TULIP', 'T0WORKSPACE', 'B0TULIP', 1, 'active', '{}', '{}', 0)`,
      [slackInstallId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_slack_identities
        (id, installation_id, generation, slack_user_id, user_id, membership_id, state, credential)
      VALUES (gen_random_uuid(), $1, 1, 'U0123SLACK', $2, $3, 'authorized', '{}')`,
      [slackInstallId, admin.id, adminMembershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_github_accounts
        (id, owner_membership_id, generation, state, config_hash, identity, credential)
      VALUES (gen_random_uuid(), $1, 1, 'active', 'cfg', $2::jsonb, '{}')`,
      [adminMembershipId, JSON.stringify({ id: '9001', login: 'dhruv-old' })],
    );
    await runtime.transaction(workspace.id, commonCompatibility, async tx => {
      const outcome = await observeExternalHandle(tx, {
        provider: 'github',
        scope: 'github.com',
        externalId: '9001',
        handle: 'dhruv-new',
        source: 'webhook',
      });
      assert.equal(outcome, 'recorded');
    });

    const app = Fastify();
    app.register(
      async routes => {
        registerWorkspaceMembers(routes, { auth, runtime });
      },
      { prefix: '/v1' },
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());

    const base = `/v1/workspaces/${workspace.id}/workspace-members`;
    const request = (who, path, { method = 'GET', body, origin = 'http://localhost:5173' } = {}) =>
      fetch(`${address}${path}`, {
        method,
        headers: {
          ...(who ? { cookie: who.cookie } : {}),
          origin,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    assert.equal((await request(null, `${base}/${adminMemberId}/identities`)).status, 401);
    assert.equal((await request(outsider, `${base}/${adminMemberId}/identities`)).status, 404);
    assert.equal((await request(outsider, `${base}/identities/search?q=dhruv`)).status, 404);

    const adminViewRes = await request(admin, `${base}/${adminMemberId}/identities`);
    assert.equal(adminViewRes.status, 200);
    const adminView = await adminViewRes.json();
    assert.equal(adminView.memberId, adminMemberId);
    assert.equal(adminView.canManage, true);
    assert.ok(adminView.providers.some(p => p.id === 'discord' && p.supportsManual));
    assert.ok(adminView.providers.some(p => p.id === 'google' && !p.supportsManual));
    const githubVerified = adminView.identities.find(item => item.provider === 'github' && item.trust === 'verified');
    assert.ok(githubVerified);
    assert.equal(githubVerified.handle, 'dhruv-new');
    assert.deepEqual(githubVerified.aliases, ['dhruv-old']);
    assert.equal(githubVerified.externalId, '9001');
    const slackVerified = adminView.identities.find(item => item.provider === 'slack' && item.trust === 'verified');
    assert.ok(slackVerified);
    assert.equal(slackVerified.externalId, 'U0123SLACK');
    assert.equal(slackVerified.scope, 'T0WORKSPACE');

    const memberViewingAdmin = await (await request(member, `${base}/${adminMemberId}/identities`)).json();
    assert.equal(memberViewingAdmin.canManage, false);
    const memberViewingSelf = await (await request(member, `${base}/${memberMemberId}/identities`)).json();
    assert.equal(memberViewingSelf.canManage, true);
    const memberViewingManual = await (await request(member, `${base}/${manual.id}/identities`)).json();
    assert.equal(memberViewingManual.canManage, false);

    const forbiddenAdd = await request(member, `${base}/${adminMemberId}/identities`, {
      method: 'POST',
      body: { provider: 'discord', handle: 'sneaky' },
    });
    assert.equal(forbiddenAdd.status, 404);

    const badOrigin = await request(member, `${base}/${memberMemberId}/identities`, {
      method: 'POST',
      origin: 'https://untrusted.example',
      body: { provider: 'discord', handle: 'member_disc' },
    });
    assert.equal(badOrigin.status, 403);

    const selfAddRes = await request(member, `${base}/${memberMemberId}/identities`, {
      method: 'POST',
      body: { provider: 'discord', handle: '@member_disc', externalId: '777001', displayName: 'Member D' },
    });
    assert.equal(selfAddRes.status, 200);
    const { identity: discordIdentity } = await selfAddRes.json();
    assert.equal(discordIdentity.provider, 'discord');
    assert.equal(discordIdentity.handle, 'member_disc');
    assert.equal(discordIdentity.externalId, '777001');
    assert.equal(discordIdentity.displayName, 'Member D');
    assert.equal(discordIdentity.trust, 'manual');

    const incompleteRes = await request(member, `${base}/${memberMemberId}/identities`, {
      method: 'POST',
      body: { provider: 'telegram' },
    });
    assert.equal(incompleteRes.status, 400);
    assert.deepEqual(await incompleteRes.json(), { error: 'identity-incomplete' });

    const googleManualRes = await request(admin, `${base}/${adminMemberId}/identities`, {
      method: 'POST',
      body: { provider: 'google', handle: 'admin@example.test' },
    });
    assert.equal(googleManualRes.status, 400);
    assert.deepEqual(await googleManualRes.json(), { error: 'manual-not-allowed' });

    const telegramAddRes = await request(admin, `${base}/${manual.id}/identities`, {
      method: 'POST',
      body: { provider: 'telegram', handle: 'maya_tg' },
    });
    assert.equal(telegramAddRes.status, 200);
    const { identity: telegramIdentity } = await telegramAddRes.json();
    assert.equal(telegramIdentity.provider, 'telegram');
    assert.equal(telegramIdentity.handle, 'maya_tg');
    assert.equal(telegramIdentity.profileUrl, 'https://t.me/maya_tg');

    const customAddRes = await request(admin, `${base}/${manual.id}/identities`, {
      method: 'POST',
      body: { provider: 'mattermost', scope: 'chat.example.com', handle: 'maya.mm', externalId: 'mm-42' },
    });
    assert.equal(customAddRes.status, 200);
    const { identity: mattermostIdentity } = await customAddRes.json();
    assert.equal(mattermostIdentity.provider, 'mattermost');
    assert.equal(mattermostIdentity.providerLabel, 'Mattermost');
    assert.equal(mattermostIdentity.scope, 'chat.example.com');

    const conflictManualRes = await request(admin, `${base}/${manual.id}/identities`, {
      method: 'POST',
      body: { provider: 'discord', externalId: '777001' },
    });
    assert.equal(conflictManualRes.status, 409);
    assert.deepEqual(await conflictManualRes.json(), { error: 'identity-claimed' });

    const conflictVerifiedRes = await request(member, `${base}/${memberMemberId}/identities`, {
      method: 'POST',
      body: { provider: 'slack', externalId: 'U0123SLACK' },
    });
    assert.equal(conflictVerifiedRes.status, 409);
    assert.deepEqual(await conflictVerifiedRes.json(), { error: 'identity-claimed' });

    assert.equal(
      (
        await request(member, `${base}/${manual.id}/identities/${telegramIdentity.id}`, {
          method: 'PATCH',
          body: { handle: 'hijacked' },
        })
      ).status,
      404,
    );
    const patchRes = await request(member, `${base}/${memberMemberId}/identities/${discordIdentity.id}`, {
      method: 'PATCH',
      body: { handle: 'member_disc_v2', displayName: 'Member Updated' },
    });
    assert.equal(patchRes.status, 200);
    const { identity: patched } = await patchRes.json();
    assert.equal(patched.handle, 'member_disc_v2');
    assert.equal(patched.externalId, '777001');
    assert.equal(patched.displayName, 'Member Updated');

    const searchCurrent = await (await request(member, `${base}/identities/search?q=@dhruv-new`)).json();
    assert.equal(searchCurrent.matches.length, 1);
    assert.equal(searchCurrent.matches[0].memberId, adminMemberId);
    assert.equal(searchCurrent.matches[0].membershipId, adminMembershipId);
    assert.equal(searchCurrent.matches[0].identity.handle, 'dhruv-new');

    const searchOldAlias = await (await request(member, `${base}/identities/search?q=dhruv-old`)).json();
    assert.equal(searchOldAlias.matches.length, 1);
    assert.equal(searchOldAlias.matches[0].memberId, adminMemberId);
    assert.deepEqual(searchOldAlias.matches[0].identity.aliases, ['dhruv-old']);

    const searchExternalId = await (await request(member, `${base}/identities/search?q=U0123SLACK`)).json();
    assert.equal(searchExternalId.matches.length, 1);
    assert.equal(searchExternalId.matches[0].memberId, adminMemberId);
    assert.equal(searchExternalId.matches[0].identity.provider, 'slack');

    const searchCustom = await (await request(admin, `${base}/identities/search?q=maya.mm&provider=mattermost`)).json();
    assert.equal(searchCustom.matches.length, 1);
    assert.equal(searchCustom.matches[0].memberId, manual.id);
    assert.equal(searchCustom.matches[0].membershipId, null);
    assert.equal(searchCustom.matches[0].identity.provider, 'mattermost');

    const searchDiscordFiltered = await (
      await request(admin, `${base}/identities/search?q=member_disc_v2&provider=discord`)
    ).json();
    assert.equal(searchDiscordFiltered.matches.length, 1);
    assert.equal(searchDiscordFiltered.matches[0].memberId, memberMemberId);

    assert.equal(
      (await request(member, `${base}/${manual.id}/identities/${telegramIdentity.id}`, { method: 'DELETE' })).status,
      404,
    );
    const deleteRes = await request(member, `${base}/${memberMemberId}/identities/${discordIdentity.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteRes.status, 200);
    assert.deepEqual(await deleteRes.json(), { removed: true });

    const deleteAgain = await request(member, `${base}/${memberMemberId}/identities/${discordIdentity.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteAgain.status, 404);
    assert.deepEqual(await deleteAgain.json(), { error: 'identity-not-found' });

    const afterDelete = await (await request(member, `${base}/${memberMemberId}/identities`)).json();
    assert.equal(afterDelete.identities.length, 0);
  },
);
