import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { createAuth } from '../src/auth.ts';
import { registerGovernance } from '../src/governance.ts';
import {
  fixture,
  connect,
  denied,
  markWorkspaceReady,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { decryptEmailDelivery } from '@tulipfarm/workspaces/email-delivery';
import { createInvitationExpirySweep } from '../../../packages/workspaces/src/invitation-expiry.ts';
import {
  lockAuthorization,
  resolveHuman,
  currentMember,
  canAccessTable,
  requireTableCreation,
} from '@tulipfarm/access';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createMemberProfileProjection, memberProfileSource } from '@tulipfarm/workspaces/member-profiles';
import { createWorkspaceMember } from '../../../packages/tables/test/fixture.mjs';

test('governance HTTP uses local authority, serializes final-admin races, and grants exact resource actions', async () => {
  const f = await fixture();
  let app;
  let runtime;
  let identity;
  const identities = [];
  const identityRole = `governance_identity_${randomUUID().replaceAll('-', '')}`;
  try {
    await f.platform.query('DROP TABLE app.accounts');
    await f.platform.query('SET search_path TO app');
    await f.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const keys = { keyId: 'test-v1', key: Buffer.alloc(32, 1), previous: new Map() };
    const password = randomUUID();
    await f.admin.query(`CREATE ROLE ${escapeIdentifier(identityRole)} LOGIN PASSWORD ${escapeLiteral(password)}`);
    const identityUrl = new URL(f.connectionString);
    await f.platform.query(
      `GRANT CONNECT ON DATABASE ${escapeIdentifier(identityUrl.pathname.slice(1))} TO ${escapeIdentifier(identityRole)}`,
    );
    await f.platform.query(
      `GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(identityRole)}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO ${escapeIdentifier(identityRole)}`,
    );
    identityUrl.username = identityRole;
    identityUrl.password = password;
    identity = new Pool({ connectionString: identityUrl.href, options: '-c search_path=app' });
    const auth = createAuth(
      identity,
      async ({ url }) => {
        identities.push(url);
      },
      async () => {},
    );
    async function signIn(name, email = `${randomUUID()}@example.com`) {
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: 'http://localhost:5173' }),
        body: { email, name },
      });
      const response = await auth.handler(new Request(identities.pop()));
      const cookie = response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      assert.ok(session);
      return { id: session.user.id, email, cookie };
    }
    const admin = await signIn('Admin');
    const member = await signIn('Record member');
    const manager = await signIn('Schema manager');
    const stranger = await signIn('Stranger');
    const migrations = await workspaceTableMigrations();
    const compatibility = { minimum: migrations.length, maximum: migrations.length };
    const a = await f.create(migrations, { userId: admin.id });
    const b = await f.create(migrations, { userId: stranger.id });
    await f.platform.query(`GRANT SELECT ON app.workspaces TO ${escapeIdentifier(identityRole)}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      connectionsPerPool: 3,
      resolveCredential: async id => {
        const workspace = f.workspaces.find(item => item.id === id);
        if (!workspace) throw new Error('Unknown workspace');
        return { workspaceId: id, generation: 1, connectionString: f.login(workspace) };
      },
    });
    app = Fastify();
    app.register(swagger, { openapi: { info: { title: 'Governance verification', version: '1' } } });
    app.register(
      async routes =>
        registerGovernance(routes, {
          auth,
          runtime,
          identity,
          compatibility,
          emailDelivery: { keys, webOrigin: 'http://localhost:5173' },
        }),
      { prefix: '/v1' },
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `/v1/workspaces/${a.id}/governance`;
    const http = async (who, method, path = '', payload) => {
      const response = await fetch(`${address}${path.startsWith('/v1') ? path : `${base}${path}`}`, {
        method,
        headers: {
          cookie: who.cookie,
          origin: 'http://localhost:5173',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const body = await response.text();
      return { statusCode: response.status, body, json: () => JSON.parse(body) };
    };
    const ok = async (who, method, path = '', payload) => {
      const response = await http(who, method, path, payload);
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    assert.equal((await app.inject({ url: base })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/leave`,
          headers: { cookie: admin.cookie, origin: 'https://wrong.example' },
        })
      ).statusCode,
      403,
    );
    assert.equal((await http(stranger, 'GET')).statusCode, 404);
    assert.equal((await http(stranger, 'GET', '/me')).statusCode, 404);
    assert.deepEqual(await ok(admin, 'GET', '/me'), {
      membershipId: a.membershipId,
      role: 'admin',
      teams: [],
      capabilities: { manageGovernance: true, canLeave: false },
    });
    const adminTeamMembers = `SELECT m.membership_id FROM "${a.names.schema}".tf_member_teams m JOIN "${a.names.schema}".tf_teams t ON t.id = m.team_id WHERE t.name = '_admin'`;
    assert.deepEqual((await f.platform.query(adminTeamMembers)).rows, [{ membership_id: a.membershipId }]);
    assert.equal((await http(admin, 'PUT', `/teams/${randomUUID()}`, { name: '_hidden' })).statusCode, 400);
    assert.deepEqual((await ok(admin, 'GET')).teams, []);
    for (const [contentType, body, expectedStatus, expectedCode] of [
      ['application/json', '{', 400, 'invalid-request'],
      ['application/xml', '<x/>', 415, 'unsupported-media-type'],
      ['application/json', JSON.stringify({ token: 'x'.repeat(1_100_000) }), 413, 'request-too-large'],
    ]) {
      const response = await fetch(`${address}/v1/invitations/redeem`, {
        method: 'POST',
        headers: { cookie: admin.cookie, origin: 'http://localhost:5173', 'content-type': contentType },
        body,
      });
      assert.equal(response.status, expectedStatus);
      assert.deepEqual(await response.json(), { error: expectedCode });
    }
    await markWorkspaceReady(f.platform, a.id);
    const projected = await createMemberProfileProjection({
      runtime,
      source: memberProfileSource(f.platform),
      discover: async () => [],
    }).project(a.id);
    assert.equal(projected.applied, 1);
    const adminMemberId = (
      await f.platform.query(
        `SELECT member_id FROM "${a.names.schema}".tf_workspace_member_accounts WHERE user_id=$1`,
        [admin.id],
      )
    ).rows[0].member_id;
    const memberIds = new Map([[admin.email, adminMemberId]]);
    async function invite(email = `${randomUUID()}@example.com`, path = '/invitations') {
      if (!memberIds.has(email))
        memberIds.set(
          email,
          (await createWorkspaceMember({ runtime, workspace: a, profile: { name: email, contactEmail: email } })).id,
        );
      const result = await ok(admin, 'POST', path, {
        kind: 'email',
        email,
        requestId: randomUUID(),
        workspaceMemberId: memberIds.get(email),
      });
      const { url } = await ok(admin, 'GET', `/invitations/${result.invitation.id}/link`);
      return { ...result, token: new URL(url).searchParams.get('token') };
    }
    await assert.rejects(
      f.platform.query(
        `INSERT INTO "${a.names.schema}".tf_invitations (id, issuer_membership_id, kind, token_hash) VALUES ($1,$2,'share',$3)`,
        [randomUUID(), a.membershipId, 'f'.repeat(64)],
      ),
      error => error.code === '23514',
    );
    {
      const original = await invite(stranger.email);
      const observation = {
        kind: 'email',
        email: ` ${stranger.email.toUpperCase()} `,
        requestId: randomUUID(),
        workspaceMemberId: original.invitation.workspaceMemberId,
      };
      assert.equal((await ok(admin, 'POST', '/invitations', observation)).outcome, 'pending');
      await ok(admin, 'POST', `/invitations/${original.invitation.id}/revoke`);
      const before = (await f.platform.query(`SELECT count(*) FROM "${a.names.schema}".tf_invitations`)).rows[0];
      const retry = await ok(admin, 'POST', '/invitations', { ...observation, email: stranger.email });
      assert.equal(retry.outcome, 'pending');
      assert.equal(retry.invitation.id, original.invitation.id);
      assert.equal(retry.invitation.status, 'revoked');
      assert.deepEqual(
        (await f.platform.query(`SELECT count(*) FROM "${a.names.schema}".tf_invitations`)).rows[0],
        before,
      );
      assert.equal(
        (await http(admin, 'POST', '/invitations', { ...observation, email: member.email })).statusCode,
        409,
      );
      assert.equal(
        (
          await http(admin, 'POST', `/invitations/${original.invitation.id}/resend`, {
            requestId: observation.requestId,
          })
        ).statusCode,
        409,
      );
      const fresh = await invite(stranger.email);
      const joined = await ok(stranger, 'POST', '/v1/invitations/redeem', { token: fresh.token });
      const memberObservation = {
        kind: 'email',
        email: stranger.email,
        requestId: randomUUID(),
        workspaceMemberId: fresh.invitation.workspaceMemberId,
      };
      assert.deepEqual(await ok(admin, 'POST', '/invitations', memberObservation), { outcome: 'already-member' });
      await ok(admin, 'DELETE', `/members/${joined.membershipId}`);
      const afterRemoval = (await f.platform.query(`SELECT count(*) FROM "${a.names.schema}".tf_invitations`)).rows[0];
      assert.deepEqual(await ok(admin, 'POST', '/invitations', memberObservation), { outcome: 'already-member' });
      assert.deepEqual(
        (await f.platform.query(`SELECT count(*) FROM "${a.names.schema}".tf_invitations`)).rows[0],
        afterRemoval,
      );
      assert.equal(
        (
          await http(admin, 'POST', `/invitations/${fresh.invitation.id}/resend`, {
            requestId: memberObservation.requestId,
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await http(admin, 'POST', '/invitations', { ...memberObservation, email: member.email })).statusCode,
        409,
      );
    }
    {
      const local = `g${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const created = await invite(`${local}+team@gmail.com`);
      assert.equal(created.outcome, 'created');
      for (const alias of [`${local}@gmail.com`, `${local.slice(0, 1)}.${local.slice(1)}@googlemail.com`]) {
        const repeated = await ok(admin, 'POST', '/invitations', {
          kind: 'email',
          email: alias,
          requestId: randomUUID(),
          workspaceMemberId: created.invitation.workspaceMemberId,
        });
        assert.equal(repeated.outcome, 'pending', alias);
        assert.equal(repeated.invitation.id, created.invitation.id);
        assert.equal(
          repeated.invitation.email,
          `${local}+team@gmail.com`,
          'The typed address stays the delivery address',
        );
      }
      const plain = await invite(`${local}@company.example`);
      const plus = await invite(`${local}+1@company.example`);
      assert.equal(plus.outcome, 'created', 'Plus addressing is not an alias outside Gmail');
      assert.notEqual(plus.invitation.id, plain.invitation.id);
      const person = await signIn('Gmail person', `${local}@gmail.com`);
      await ok(person, 'POST', '/v1/invitations/redeem', { token: created.token });
      assert.deepEqual(
        await ok(admin, 'POST', '/invitations', {
          kind: 'email',
          email: `${local}+again@googlemail.com`,
          requestId: randomUUID(),
          workspaceMemberId: created.invitation.workspaceMemberId,
        }),
        { outcome: 'already-member' },
      );
    }
    {
      const original = await invite(stranger.email);
      const pending = await ok(admin, 'POST', '/invitations', {
        kind: 'email',
        email: `  ${stranger.email.toUpperCase()}  `,
        requestId: randomUUID(),
        workspaceMemberId: original.invitation.workspaceMemberId,
      });
      assert.equal(pending.outcome, 'pending');
      assert.equal(pending.invitation.id, original.invitation.id);
      const operation = { requestId: randomUUID() };
      const replacements = await Promise.all(
        [1, 2].map(() => ok(admin, 'POST', `/invitations/${original.invitation.id}/resend`, operation)),
      );
      assert.equal(replacements[0].invitation.id, replacements[1].invitation.id);
      assert.equal(
        (await http(admin, 'POST', `/invitations/${original.invitation.id}/resend`, { requestId: randomUUID() }))
          .statusCode,
        404,
      );
      assert.equal((await http(stranger, 'POST', '/v1/invitations/redeem', { token: original.token })).statusCode, 404);
      assert.equal((await http(admin, 'GET', `/invitations/${original.invitation.id}/link`)).statusCode, 404);
      assert.equal(
        (
          await f.platform.query(`SELECT copy_material FROM "${a.names.schema}".tf_invitations WHERE id=$1`, [
            original.invitation.id,
          ])
        ).rows[0].copy_material,
        null,
      );
      const replacementId = replacements[0].invitation.id;
      const { url } = await ok(admin, 'GET', `/invitations/${replacementId}/link`);
      const token = new URL(url).searchParams.get('token');
      const admission = await ok(stranger, 'POST', '/v1/invitations/redeem', { token });
      assert.equal(
        (await f.platform.query('SELECT status FROM app.email_deliveries WHERE id=$1', [replacementId])).rows[0].status,
        'cancelled',
      );
      await ok(stranger, 'POST', '/leave');
      assert.equal((await http(stranger, 'POST', '/v1/invitations/redeem', { token })).statusCode, 404);
      const fresh = await invite(stranger.email);
      const freshAdmission = await ok(stranger, 'POST', '/v1/invitations/redeem', { token: fresh.token });
      assert.notEqual(freshAdmission.membershipId, admission.membershipId);
      assert.equal((await http(stranger, 'POST', '/v1/invitations/redeem', { token })).statusCode, 404);
      await ok(admin, 'DELETE', `/members/${freshAdmission.membershipId}`);
    }
    {
      const original = await invite(stranger.email);
      const outcomes = await Promise.all([
        http(admin, 'POST', `/invitations/${original.invitation.id}/resend`, { requestId: randomUUID() }),
        http(stranger, 'POST', '/v1/invitations/redeem', { token: original.token }),
      ]);
      assert.deepEqual(outcomes.map(result => result.statusCode).sort(), [200, 404]);
      let receipt;
      if (outcomes[0].statusCode === 200) {
        const replacement = outcomes[0].json().invitation;
        const { url } = await ok(admin, 'GET', `/invitations/${replacement.id}/link`);
        receipt = await ok(stranger, 'POST', '/v1/invitations/redeem', {
          token: new URL(url).searchParams.get('token'),
        });
      } else receipt = outcomes[1].json();
      const unused = `${a.id}.${randomBytes(32).toString('base64url')}`;
      const unusedId = randomUUID();
      await f.platform.query(
        `INSERT INTO "${a.names.schema}".tf_invitations (id,issuer_membership_id,kind,email,token_hash,workspace_member_id) VALUES ($1,$2,'email',$3,$4,$5)`,
        [
          unusedId,
          a.membershipId,
          stranger.email,
          createHash('sha256').update(unused).digest('hex'),
          original.invitation.workspaceMemberId,
        ],
      );
      const removalRace = await Promise.all([
        http(admin, 'DELETE', `/members/${receipt.membershipId}`),
        http(stranger, 'POST', '/v1/invitations/redeem', { token: unused }),
      ]);
      assert.equal(removalRace[0].statusCode, 200);
      assert.ok([200, 404].includes(removalRace[1].statusCode));
      assert.equal((await http(stranger, 'POST', '/v1/invitations/redeem', { token: unused })).statusCode, 404);
      assert.equal(
        (
          await f.platform.query(
            `SELECT id FROM "${a.names.schema}".tf_memberships WHERE user_id=$1 AND removed_at IS NULL`,
            [stranger.id],
          )
        ).rowCount,
        0,
      );
    }
    {
      const expiring = await invite();
      const stillActive = await invite();
      await f.platform.query(
        `UPDATE "${a.names.schema}".tf_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [expiring.invitation.id],
      );
      await f.platform.query(
        "UPDATE app.workspace_storage SET stage='ready', runtime_credential='{}', migration_credential='{}', confirmation_credential='{}' WHERE workspace_id=$1",
        [a.id],
      );
      const sweep = createInvitationExpirySweep(f.platform, async () => ({
        connectionString: f.login(a, 'migration'),
      }));
      assert.equal(await sweep(), 1);
      assert.equal(await sweep(), 0);
      assert.equal(
        (
          await f.platform.query(`SELECT copy_material FROM "${a.names.schema}".tf_invitations WHERE id=$1`, [
            expiring.invitation.id,
          ])
        ).rows[0].copy_material,
        null,
      );
      assert.equal(
        (await ok(admin, 'GET', `/invitations/${stillActive.invitation.id}/link`)).url,
        `http://localhost:5173/invite?token=${stillActive.token}`,
      );
    }
    assert.deepEqual(
      await ok(admin, 'POST', '/invitations', {
        kind: 'email',
        email: admin.email,
        requestId: randomUUID(),
        workspaceMemberId: adminMemberId,
      }),
      { outcome: 'already-member' },
    );
    for (const input of [
      { kind: 'share' },
      { kind: 'email', email: member.email, requestId: randomUUID(), teamId: randomUUID() },
      { kind: 'email', email: member.email, requestId: randomUUID(), role: 'admin' },
    ])
      assert.equal((await http(admin, 'POST', '/invitations', input)).statusCode, 400);
    const link = await invite(member.email, `/v1/workspaces/${a.id.toUpperCase()}/governance/invitations`);
    assert.ok(link.token.startsWith(`${a.id}.`));
    const admitted = await Promise.all(
      [1, 2].map(() => ok(member, 'POST', '/v1/invitations/redeem', { token: link.token })),
    );
    assert.equal(admitted[0].membershipId, admitted[1].membershipId);
    const memberId = admitted[0].membershipId;
    {
      const unused = `${a.id}.${randomBytes(32).toString('base64url')}`;
      const unusedId = randomUUID();
      const blocker = await connect(f.connectionString);
      let removal;
      try {
        await blocker.query('BEGIN');
        await blocker.query(`SELECT id FROM "${a.names.schema}".tf_authorization_lock WHERE id=1 FOR UPDATE`);
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        removal = http(admin, 'DELETE', `/members/${memberId}`);
        for (let attempt = 0; ; attempt++) {
          if (
            (await f.databaseAdmin.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]))
              .rowCount
          )
            break;
          assert.ok(attempt < 100, 'Removal must wait on the authorization lock');
          await setTimeout(20);
        }
        await blocker.query(
          `INSERT INTO "${a.names.schema}".tf_invitations (id,issuer_membership_id,kind,email,token_hash,workspace_member_id) VALUES ($1,$2,'email',$3,$4,$5)`,
          [
            unusedId,
            a.membershipId,
            member.email,
            createHash('sha256').update(unused).digest('hex'),
            link.invitation.workspaceMemberId,
          ],
        );
        await blocker.query('COMMIT');
        assert.equal((await removal).statusCode, 200);
        assert.equal(
          (
            await f.platform.query(
              `SELECT m.removed_at > i.created_at AS ordered FROM "${a.names.schema}".tf_memberships m CROSS JOIN "${a.names.schema}".tf_invitations i WHERE m.id=$1 AND i.id=$2`,
              [memberId, unusedId],
            )
          ).rows[0].ordered,
          true,
        );
        assert.equal((await http(member, 'POST', '/v1/invitations/redeem', { token: unused })).statusCode, 404);
        await f.platform.query(`UPDATE "${a.names.schema}".tf_invitations SET revoked_at=NULL WHERE id=$1`, [unusedId]);
        assert.equal(
          (await http(member, 'POST', '/v1/invitations/redeem', { token: unused })).statusCode,
          404,
          'The identity tombstone is authoritative even without eager cancellation',
        );
        await f.platform.query(
          `UPDATE "${a.names.schema}".tf_invitations SET revoked_at=clock_timestamp() WHERE id=$1`,
          [unusedId],
        );
        await f.platform.query(`UPDATE "${a.names.schema}".tf_memberships SET removed_at=NULL WHERE id=$1`, [memberId]);
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
        await removal;
      }
    }
    const managerLink = await invite(manager.email);
    const managerId = (await ok(manager, 'POST', '/v1/invitations/redeem', { token: managerLink.token })).membershipId;
    assert.equal((await http(member, 'GET')).statusCode, 200);
    assert.deepEqual(await ok(member, 'GET', '/me'), {
      membershipId: memberId,
      role: 'member',
      teams: [],
      capabilities: { manageGovernance: false, canLeave: true },
    });
    assert.equal((await http(member, 'GET', '/invitations')).statusCode, 404);
    const snapshot = await ok(admin, 'GET');
    assert.equal(snapshot.members.length, 4);
    assert.equal(
      snapshot.members.some(item => item.userId === stranger.id),
      false,
    );
    assert.equal(snapshot.members.find(item => item.id === memberId).role, 'member');
    assert.deepEqual(snapshot.teams, []);
    const teamId = randomUUID();
    const managers = randomUUID();
    await ok(admin, 'PUT', `/teams/${teamId}`, { name: 'Operations' });
    await ok(admin, 'PUT', `/teams/${teamId}`, { name: 'Operations' });
    await ok(admin, 'PUT', `/teams/${managers}`, { name: 'Schema managers' });
    {
      const detailed = randomUUID();
      await ok(admin, 'PUT', `/teams/${detailed}`, { name: '  Support  ', description: '  Customer support  ' });
      await ok(admin, 'PUT', `/teams/${detailed}`, { name: 'Support', description: 'Customer support' });
      assert.deepEqual(
        (await ok(admin, 'GET')).teams.find(team => team.id === detailed),
        {
          id: detailed,
          name: 'Support',
          description: 'Customer support',
          membershipIds: [a.membershipId],
          managerIds: [a.membershipId],
          canManage: true,
          canLeave: false,
        },
      );
      assert.deepEqual(
        (await http(admin, 'PUT', `/teams/${detailed}`, { name: 'Support', description: 'Changed' })).json(),
        { error: 'team-id-conflict' },
      );
      for (const name of ['', '   ', 'x'.repeat(81)])
        assert.deepEqual((await http(admin, 'PUT', `/teams/${randomUUID()}`, { name })).json(), {
          error: 'invalid-team-name',
        });
      assert.deepEqual(
        (await http(admin, 'PUT', `/teams/${randomUUID()}`, { name: 'Valid', description: 'x'.repeat(1001) })).json(),
        { error: 'invalid-team-description' },
      );
      const expectedDetails = async id => {
        const team = (await ok(admin, 'GET')).teams.find(team => team.id === id);
        return { name: team.name, description: team.description };
      };
      assert.deepEqual(
        (
          await http(admin, 'PUT', `/teams/${detailed}/name`, {
            name: '  OPERATIONS ',
            expected: await expectedDetails(detailed),
          })
        ).json(),
        { error: 'duplicate-team-name' },
      );
      const race = await Promise.all(
        [' Concurrent ', 'concurrent'].map(name => http(admin, 'PUT', `/teams/${randomUUID()}`, { name })),
      );
      assert.deepEqual(race.map(result => result.statusCode).sort(), [200, 409]);
      assert.deepEqual(race.find(result => result.statusCode === 409).json(), { error: 'duplicate-team-name' });
      const renames = await Promise.all(
        [detailed, managers].map(async id =>
          http(admin, 'PUT', `/teams/${id}/name`, { name: 'Renamed', expected: await expectedDetails(id) }),
        ),
      );
      assert.deepEqual(renames.map(result => result.statusCode).sort(), [200, 409]);
      await ok(admin, 'PUT', `/teams/${managers}/name`, {
        name: 'Schema managers',
        expected: await expectedDetails(managers),
      });
      await ok(admin, 'PUT', `/teams/${detailed}/name`, {
        name: 'Support',
        description: 'Updated',
        expected: await expectedDetails(detailed),
      });
      const expected = await expectedDetails(detailed);
      const edits = await Promise.all(
        ['First edit', 'Second edit'].map(description =>
          http(admin, 'PUT', `/teams/${detailed}/name`, { name: 'Support', description, expected }),
        ),
      );
      assert.deepEqual(edits.map(result => result.statusCode).sort(), [200, 409]);
      assert.deepEqual(edits.find(result => result.statusCode === 409).json(), { error: 'team-details-conflict' });
      const winner = edits[0].statusCode === 200 ? 'First edit' : 'Second edit';
      await ok(admin, 'PUT', `/teams/${detailed}/name`, { name: 'Support', description: winner, expected });
      assert.deepEqual(await expectedDetails(detailed), { name: 'Support', description: winner });
      assert.equal((await http(admin, 'PUT', `/teams/${detailed}/name`, { name: 'Unsafe update' })).statusCode, 400);
      await ok(admin, 'PUT', `/teams/${detailed}/members/${a.membershipId}`, { enrolled: true });
      assert.deepEqual((await http(admin, 'POST', `/teams/${detailed}/leave`)).json(), { error: 'final-team-manager' });
      assert.equal((await ok(admin, 'GET', '/me')).role, 'admin');
      assert.equal((await ok(admin, 'GET', '/me')).capabilities.canLeave, false);
      await ok(admin, 'DELETE', `/teams/${detailed}`);
    }
    assert.deepEqual((await ok(admin, 'GET')).grants, []);
    const privateTeam = randomUUID();
    await ok(member, 'PUT', `/teams/${privateTeam}`, { name: 'Private collaboration' });
    assert.equal(
      (await ok(admin, 'GET')).teams.some(team => team.id === privateTeam),
      false,
    );
    assert.equal(
      (await http(admin, 'PUT', `/teams/${privateTeam}/members/${a.membershipId}`, { enrolled: true })).statusCode,
      404,
    );
    await ok(member, 'DELETE', `/teams/${privateTeam}`);
    await ok(admin, 'PUT', `/teams/${teamId}/members/${memberId}`, { enrolled: true });
    await ok(admin, 'PUT', `/teams/${managers}/members/${managerId}`, { enrolled: true });
    assert.deepEqual(await ok(member, 'GET', '/me'), {
      membershipId: memberId,
      role: 'member',
      teams: [{ id: teamId, name: 'Operations', role: 'member' }],
      capabilities: { manageGovernance: false, canLeave: true },
    });
    const retiredTeam = randomUUID();
    await ok(admin, 'PUT', `/teams/${retiredTeam}`, { name: 'Retire me' });
    await ok(admin, 'PUT', `/teams/${retiredTeam}/members/${memberId}`, { enrolled: true });
    const staleGrant = {
      teamId: retiredTeam,
      target: { kind: 'collection', id: retiredTeam, permission: 'table.create' },
      granted: true,
    };
    await ok(admin, 'PUT', '/grants', staleGrant);
    await ok(admin, 'DELETE', `/teams/${retiredTeam}`);
    for (const name of ['Retire me', 'Replacement']) {
      const response = await http(admin, 'PUT', `/teams/${retiredTeam}`, { name });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, 'team-id-retired');
    }
    assert.equal(
      (await http(admin, 'PUT', `/teams/${retiredTeam}/members/${memberId}`, { enrolled: true })).statusCode,
      404,
    );
    assert.equal((await http(admin, 'PUT', '/grants', staleGrant)).statusCode, 404);
    assert.equal(
      (await f.platform.query(`SELECT id FROM "${a.names.schema}".tf_retired_teams WHERE id = $1`, [retiredTeam]))
        .rowCount,
      1,
    );
    assert.equal(
      (
        await f.platform.query(`SELECT team_id FROM "${a.names.schema}".tf_member_teams WHERE team_id = $1`, [
          retiredTeam,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.platform.query(
          `SELECT team_id FROM "${a.names.schema}".tf_grants WHERE team_id = $1 OR asset_id = $1`,
          [retiredTeam],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await http(admin, 'PUT', `/teams/${teamId}/members/${b.membershipId}`, { enrolled: true })).statusCode,
      404,
    );
    const tableId = randomUUID();
    await f.platform.query(
      `INSERT INTO "${a.names.schema}".tf_table_catalog (id, owning_team_id, physical_table, display_name, target_revision) VALUES ($1,$2,'invoices','Invoices',$3)`,
      [tableId, teamId, 'a'.repeat(40)],
    );
    assert.deepEqual((await http(admin, 'DELETE', `/teams/${teamId}`)).json(), { error: 'team-owns-tables' });
    const permission = async (who, action) =>
      runtime.transaction(a.id, compatibility, async transaction => {
        await lockAuthorization(transaction);
        return canAccessTable(transaction, await resolveHuman(transaction, who.id), tableId, action);
      });
    assert.equal(await permission(member, 'table.row.read'), false);
    const grant = (teamId, permission, granted = true, id = tableId, kind = 'table') =>
      ok(admin, 'PUT', '/grants', { teamId, target: { kind, id, permission }, granted });
    const personGrant = (permission, granted = true, id = tableId, kind = 'table') =>
      ok(admin, 'PUT', '/person-grants', { membershipId: memberId, target: { kind, id, permission }, granted });
    const directRead = {
      membershipId: memberId,
      target: { kind: 'table', id: tableId, permission: 'table.row.read' },
      granted: true,
    };
    assert.equal((await http(member, 'PUT', '/person-grants', directRead)).statusCode, 404);
    assert.equal((await http(member, 'GET', '/person-grants')).statusCode, 404);
    assert.equal(
      (await http(admin, 'PUT', '/person-grants', { ...directRead, membershipId: b.membershipId })).statusCode,
      404,
    );
    assert.equal(
      (
        await http(admin, 'PUT', '/person-grants', {
          ...directRead,
          target: { ...directRead.target, permission: 'integration.read' },
        })
      ).statusCode,
      400,
    );
    await personGrant('table.row.read');
    await personGrant('table.row.read');
    assert.deepEqual(await ok(admin, 'GET', '/person-grants'), {
      grants: [{ membershipId: memberId, target: directRead.target }],
    });
    assert.equal(await permission(member, 'table.row.read'), true);
    await personGrant('table.row.read', false);
    await grant(teamId, 'table.row.create');
    await grant(teamId, 'table.row.update');
    assert.equal(await permission(member, 'table.row.create'), true);
    assert.equal(await permission(member, 'table.row.read'), false);
    assert.equal(await permission(member, 'table.schema.manage'), false);
    await grant(managers, 'table.schema.manage');
    assert.equal(await permission(manager, 'table.schema.manage'), true);
    assert.equal(await permission(manager, 'table.row.read'), false);
    await assert.rejects(
      runtime.transaction(a.id, compatibility, async transaction => {
        await lockAuthorization(transaction);
        await requireTableCreation(transaction, await resolveHuman(transaction, member.id), teamId);
      }),
    );
    await grant(teamId, 'table.create', true, managers, 'collection');
    await runtime.transaction(a.id, compatibility, async transaction => {
      await lockAuthorization(transaction);
      await requireTableCreation(transaction, await resolveHuman(transaction, member.id), managers);
    });
    await assert.rejects(
      runtime.transaction(a.id, compatibility, async transaction => {
        await lockAuthorization(transaction);
        await requireTableCreation(transaction, await resolveHuman(transaction, member.id), teamId);
      }),
    );
    assert.equal(
      (
        await http(admin, 'PUT', '/grants', {
          teamId,
          target: { kind: 'collection', id: managers, permission: 'table.schema.manage' },
          granted: true,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await http(admin, 'PUT', '/grants', {
          teamId,
          target: { kind: 'table', id: randomUUID(), permission: 'table.row.read' },
          granted: true,
        })
      ).statusCode,
      404,
    );
    assert.equal((await http(admin, 'DELETE', `/teams/${teamId}`)).statusCode, 409);
    await ok(admin, 'PUT', `/tables/${tableId}/owner`, { teamId: managers });
    assert.equal(await permission(manager, 'table.row.read'), false);
    await grant(teamId, 'table.row.read');
    await grant(managers, 'table.row.read');
    await ok(admin, 'PUT', `/teams/${managers}/members/${memberId}`, { enrolled: true });
    await ok(member, 'POST', `/teams/${teamId}/leave`);
    await ok(member, 'POST', `/teams/${teamId}/leave`);
    assert.equal(
      (
        await f.platform.query(
          `SELECT count(*)::int AS n FROM "${a.names.schema}".tf_audit_events WHERE operation='team.leave' AND actor_id=$1 AND subject_id=$2`,
          [memberId, teamId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(await permission(member, 'table.row.read'), true);
    assert.equal(await permission(member, 'table.row.create'), false);
    assert.equal(await permission(manager, 'table.schema.manage'), true);
    assert.deepEqual((await http(member, 'POST', `/teams/${managers}/leave`, { membershipId: managerId })).json(), {
      error: 'invalid-request',
    });
    assert.equal(
      (await http(member, 'PUT', `/teams/${teamId}/members/${memberId}`, { enrolled: true })).statusCode,
      404,
    );
    assert.equal(
      (await http(member, 'PUT', `/teams/${managers}/members/${managerId}`, { enrolled: false })).statusCode,
      404,
    );
    await ok(admin, 'PUT', `/teams/${teamId}/members/${memberId}`, { enrolled: true });
    assert.equal(await permission(member, 'table.row.create'), true);
    await grant(teamId, 'table.row.read', false);
    assert.equal(await permission(member, 'table.row.read'), true);
    await ok(admin, 'PUT', `/teams/${managers}/members/${memberId}`, { enrolled: false });
    assert.equal(await permission(member, 'table.row.read'), false);
    await personGrant('table.row.read');
    assert.equal(await permission(member, 'table.row.read'), true);
    const beforeRemoval = { kind: 'human', userId: member.id, membershipId: memberId };
    await ok(admin, 'DELETE', `/members/${memberId}`);
    assert.equal((await http(member, 'GET', '/me')).statusCode, 404);
    assert.equal((await http(member, 'POST', '/v1/invitations/redeem', { token: link.token })).statusCode, 404);
    const emailLink = await invite(member.email);
    const delivery = (
      await f.platform.query('SELECT payload FROM app.email_deliveries WHERE id = $1', [emailLink.invitation.id])
    ).rows[0];
    assert.equal(
      new URL(decryptEmailDelivery(emailLink.invitation.id, delivery.payload, keys).url).searchParams.get('token'),
      emailLink.token,
    );
    assert.equal((await http(stranger, 'POST', '/v1/invitations/redeem', { token: emailLink.token })).statusCode, 404);
    await f.platform.query('UPDATE app.users SET email_verified = false WHERE id = $1', [member.id]);
    assert.equal((await http(member, 'POST', '/v1/invitations/redeem', { token: emailLink.token })).statusCode, 404);
    await f.platform.query('UPDATE app.users SET email_verified = true WHERE id = $1', [member.id]);
    const rejoined = await ok(member, 'POST', '/v1/invitations/redeem', { token: emailLink.token });
    assert.notEqual(rejoined.membershipId, memberId);
    assert.equal(await permission(member, 'table.row.read'), false);
    assert.deepEqual(await ok(admin, 'GET', '/person-grants'), { grants: [] });
    assert.equal((await http(admin, 'PUT', '/person-grants', directRead)).statusCode, 404);
    assert.deepEqual(await ok(member, 'GET', '/me'), {
      membershipId: rejoined.membershipId,
      role: 'member',
      teams: [],
      capabilities: { manageGovernance: false, canLeave: true },
    });
    assert.equal(
      (await ok(admin, 'GET')).teams.some(team => team.membershipIds.includes(rejoined.membershipId)),
      false,
    );
    await assert.rejects(
      runtime.transaction(a.id, compatibility, async transaction => {
        await lockAuthorization(transaction);
        await currentMember(transaction, beforeRemoval);
      }),
    );
    const auditsBefore = (
      await f.platform.query(
        `SELECT count(*) FROM "${a.names.schema}".tf_audit_events WHERE operation = 'invitation.redeem'`,
      )
    ).rows[0];
    await f.platform.query(
      `UPDATE "${a.names.schema}".tf_invitations SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [emailLink.invitation.id],
    );
    assert.deepEqual(await ok(member, 'POST', '/v1/invitations/redeem', { token: emailLink.token }), rejoined);
    assert.deepEqual(
      (
        await f.platform.query(
          `SELECT count(*) FROM "${a.names.schema}".tf_audit_events WHERE operation = 'invitation.redeem'`,
        )
      ).rows[0],
      auditsBefore,
    );
    await ok(admin, 'DELETE', `/members/${rejoined.membershipId}`);
    assert.equal((await http(member, 'POST', '/v1/invitations/redeem', { token: emailLink.token })).statusCode, 404);
    await ok(admin, 'POST', `/invitations/${link.invitation.id}/revoke`);
    assert.equal((await http(member, 'POST', '/v1/invitations/redeem', { token: link.token })).statusCode, 404);
    const expired = await invite(member.email);
    await f.platform.query(
      `UPDATE "${a.names.schema}".tf_invitations SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [expired.invitation.id],
    );
    assert.equal((await http(member, 'POST', '/v1/invitations/redeem', { token: expired.token })).statusCode, 404);
    for (const lock of ['authorization', 'invitation']) {
      const waiting = await invite(member.email);
      await f.platform.query(
        `UPDATE "${a.names.schema}".tf_invitations SET expires_at = clock_timestamp() + interval '1 second' WHERE id = $1`,
        [waiting.invitation.id],
      );
      const blocker = await connect(f.connectionString);
      let redemption;
      try {
        await blocker.query('BEGIN');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        if (lock === 'authorization')
          await blocker.query(`SELECT id FROM "${a.names.schema}".tf_authorization_lock WHERE id = 1 FOR UPDATE`);
        else
          await blocker.query(`SELECT id FROM "${a.names.schema}".tf_invitations WHERE id = $1 FOR UPDATE`, [
            waiting.invitation.id,
          ]);
        redemption = http(member, 'POST', '/v1/invitations/redeem', { token: waiting.token });
        for (let attempt = 0; ; attempt++) {
          const blocked = await f.databaseAdmin.query(
            'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          );
          if (blocked.rowCount) break;
          assert.ok(attempt < 100, 'Redemption must actually wait on the held lock');
          await setTimeout(20);
        }
        await setTimeout(1100);
        assert.equal(
          (
            await blocker.query(
              `SELECT expires_at <= clock_timestamp() AS expired FROM "${a.names.schema}".tf_invitations WHERE id = $1`,
              [waiting.invitation.id],
            )
          ).rows[0].expired,
          true,
        );
        await blocker.query('COMMIT');
        assert.equal((await redemption).statusCode, 404, `Expired token after ${lock} lock wait`);
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
        await redemption;
      }
    }
    const oldest = await invite();
    for (let index = 0; index < 101; index++) await invite();
    const firstPage = await ok(admin, 'GET', '/invitations');
    assert.equal(firstPage.items.length, 100);
    assert.ok(firstPage.nextCursor);
    assert.equal(
      firstPage.items.some(item => item.id === oldest.invitation.id),
      false,
    );
    const searched = await ok(
      admin,
      'GET',
      `/invitations?search=${encodeURIComponent(` ${oldest.invitation.email.toUpperCase()} `)}`,
    );
    assert.deepEqual(
      searched.items.map(item => item.id),
      [oldest.invitation.id],
    );
    assert.equal(searched.nextCursor, null);
    assert.equal((await ok(admin, 'GET', '/invitations?search=no-match')).items.length, 0);
    assert.equal(
      (await ok(admin, 'GET', '/invitations?search=%25')).items.length,
      0,
      'search treats SQL wildcards literally',
    );
    const activePage = await ok(admin, 'GET', '/invitations?search=active');
    assert.equal(activePage.items.length, 100);
    assert.ok(activePage.items.every(item => item.status === 'active'));
    const olderActive = await ok(admin, 'GET', `/invitations?search=active&after=${activePage.nextCursor}`);
    assert.ok(olderActive.items.some(item => item.id === oldest.invitation.id));
    assert.ok(olderActive.items.every(item => item.status === 'active'));
    assert.ok(olderActive.items.every(item => !activePage.items.some(first => first.id === item.id)));
    const pendingDelivery = await ok(admin, 'GET', '/invitations?search=pending');
    assert.ok(pendingDelivery.items.length > 0);
    assert.ok(pendingDelivery.items.every(item => item.delivery === 'pending'));
    assert.equal((await http(stranger, 'GET', '/invitations?search=active')).statusCode, 404);
    await invite();
    const secondPage = await ok(admin, 'GET', `/invitations?after=${firstPage.nextCursor}`);
    assert.equal(secondPage.nextCursor, null);
    assert.ok(secondPage.items.some(item => item.id === oldest.invitation.id && item.status === 'active'));
    assert.equal(
      secondPage.items.some(item => firstPage.items.some(first => first.id === item.id)),
      false,
    );
    await ok(admin, 'POST', `/invitations/${oldest.invitation.id}/revoke`);
    assert.equal((await http(member, 'POST', '/v1/invitations/redeem', { token: oldest.token })).statusCode, 404);
    assert.equal((await http(admin, 'GET', '/invitations?after=invalid')).statusCode, 400);
    assert.equal((await http(stranger, 'GET', `/invitations?after=${firstPage.nextCursor}`)).statusCode, 404);
    const inviteList = await ok(admin, 'GET', '/invitations');
    assert.equal(JSON.stringify(inviteList).includes(link.token), false);
    assert.equal(
      (await http(member, 'POST', '/v1/invitations/redeem', { token: `${b.id}.${link.token.split('.')[1]}` }))
        .statusCode,
      404,
    );
    await ok(admin, 'PUT', `/members/${managerId}/role`, { role: 'admin' });
    for (const team of (await ok(admin, 'GET')).teams) {
      await ok(admin, 'PUT', `/teams/${team.id}/members/${managerId}`, { enrolled: true });
      await ok(admin, 'PUT', `/teams/${team.id}/members/${managerId}/role`, { role: 'manager' });
    }
    assert.equal((await ok(admin, 'GET', '/me')).capabilities.canLeave, true);
    assert.equal((await ok(manager, 'GET', '/me')).capabilities.manageGovernance, true);
    const races = await Promise.all([
      http(admin, 'PUT', `/members/${a.membershipId}/role`, { role: 'member' }),
      http(manager, 'PUT', `/members/${managerId}/role`, { role: 'member' }),
    ]);
    assert.deepEqual(races.map(result => result.statusCode).sort(), [200, 409]);
    const remaining = (
      await f.platform.query(
        `SELECT id, user_id FROM "${a.names.schema}".tf_memberships WHERE role = 'admin' AND removed_at IS NULL`,
      )
    ).rows;
    assert.equal(remaining.length, 1);
    const finalAdmin = remaining[0].user_id === admin.id ? admin : manager;
    assert.equal((await ok(finalAdmin, 'GET', '/me')).capabilities.canLeave, false);
    const demoted = finalAdmin === admin ? manager : admin;
    assert.equal((await ok(demoted, 'GET', '/me')).role, 'member');
    assert.equal((await f.platform.query(adminTeamMembers)).rowCount, 1);
    assert.equal((await http(demoted, 'GET')).statusCode, 200);
    assert.equal((await http(finalAdmin, 'POST', '/leave')).statusCode, 409);
    assert.equal((await http(finalAdmin, 'DELETE', `/members/${remaining[0].id}`)).statusCode, 409);
    const otherId = remaining[0].id === a.membershipId ? managerId : a.membershipId;
    await ok(finalAdmin, 'PUT', `/members/${otherId}/role`, { role: 'admin' });
    const leaveRace = await Promise.all([http(admin, 'POST', '/leave'), http(manager, 'POST', '/leave')]);
    assert.deepEqual(leaveRace.map(result => result.statusCode).sort(), [200, 409]);
    assert.equal(
      (
        await f.platform.query(
          `SELECT count(*)::integer AS count FROM "${a.names.schema}".tf_memberships WHERE role = 'admin' AND removed_at IS NULL`,
        )
      ).rows[0].count,
      1,
    );
    const workspaceLogin = await connect(f.login(a));
    try {
      await denied(workspaceLogin, 'SELECT * FROM app.users');
      await denied(workspaceLogin, `SELECT * FROM "${b.names.schema}".tf_memberships`);
      await denied(workspaceLogin, `DELETE FROM "${a.names.schema}".tf_retired_teams`);
      await denied(workspaceLogin, `UPDATE "${a.names.schema}".tf_retired_teams SET retired_at = clock_timestamp()`);
    } finally {
      await workspaceLogin.end();
    }
    await assert.rejects(
      identity.query(`SELECT * FROM "${a.names.schema}".tf_memberships`),
      error => error.code === '42501',
    );
    const spec = app.swagger();
    assert.ok(spec.paths['/v1/workspaces/{workspaceId}/governance/grants'].put.responses['404']);
    assert.ok(spec.paths['/v1/workspaces/{workspaceId}/governance/me'].get.responses['200']);
    assert.ok(spec.paths['/v1/invitations/redeem'].post.requestBody);
    assert.ok(spec.paths['/v1/invitations/redeem'].post.responses['413']);
    assert.ok(spec.paths['/v1/invitations/redeem'].post.responses['415']);
  } finally {
    await app?.close();
    await runtime?.close();
    await identity?.end();
    await f.close();
    const cleanup = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    try {
      await cleanup.query(`DROP ROLE IF EXISTS ${escapeIdentifier(identityRole)}`);
    } finally {
      await cleanup.end();
    }
  }
});
