import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  fixture,
  connect,
  loadPlatformBaseline,
  markWorkspaceReady,
  seedPlatformUser,
} from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createMemberProfileProjection, memberProfileSource } from '@tulipfarm/workspaces/member-profiles';
import { createTableService } from '@tulipfarm/tables/service';
import {
  activeGeneration,
  projectWorkspaceMemberProfile,
  refreshWorkspaceMemberAccess,
  workspaceMembersTable,
} from '@tulipfarm/tables/store';
import { workspaceMemberAccess, workspaceMemberFields } from '@tulipfarm/tables/workspace-members';

test(
  'profile capture, projection, queued-version fencing, and revoked access preserve business identity',
  { timeout: 45000 },
  async t => {
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const workspace = await db.create();
    await markWorkspaceReady(db.platform, workspace.id);
    const raw = await connect(db.login(workspace));
    cleanup.push(() => raw.end());
    const s = `"${workspace.names.schema}"`;
    const runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({
        workspaceId: workspace.id,
        generation: 1,
        connectionString: db.login(workspace),
      }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    cleanup.push(() => runtime.close());
    const source = memberProfileSource(db.platform);
    const projection = createMemberProfileProjection({
      runtime,
      source,
      discover: async after => (after ? [] : [workspace.id]),
    });
    const memberId = (
      await raw.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`, [workspace.userId])
    ).rows[0].member_id;
    const sourceProfile = async () => (await source.read(workspace.id, [workspace.userId]))[0];
    const firstProfile = await sourceProfile();
    assert.equal(firstProfile.revision, '1');
    await db.platform.query('BEGIN');
    await db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [workspace.userId, 'Rolled back']);
    assert.equal((await source.pending()).find(event => event.user_id === workspace.userId).revision, '2');
    await db.platform.query('ROLLBACK');
    assert.equal((await sourceProfile()).revision, '1');
    await projection.dispatch();
    assert.equal((await projection.project(workspace.id)).applied, 1);
    const tx = { client: raw, schema: workspace.names.schema };
    const directory = await activeGeneration(tx, (await workspaceMembersTable(tx)).coreDefinition.id);
    const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
    const read = () =>
      tables.read(workspace.id, workspace.userId, {
        tableId: directory.table_id,
        revision: directory.revision,
        recordId: memberId,
      });
    let row = await read();
    assert.equal(row.id, memberId);
    assert.equal(row.values[workspaceMemberFields.name].value, firstProfile.name);
    assert.equal(row.values[workspaceMemberFields.accountEmail].value, firstProfile.email);
    await assert.rejects(
      tables.mutate(workspace.id, workspace.userId, {
        kind: 'update',
        tableId: directory.table_id,
        revision: directory.revision,
        recordId: memberId,
        expectedToken: row.token,
        values: { [workspaceMemberFields.name]: { kind: 'text', value: 'Bypass account profile' } },
      }),
      /member-field-protected/,
    );
    row = await tables.mutate(workspace.id, workspace.userId, {
      kind: 'update',
      tableId: directory.table_id,
      revision: directory.revision,
      recordId: memberId,
      expectedToken: row.token,
      values: {
        [workspaceMemberFields.contactEmail]: { kind: 'text', value: 'business@example.test' },
        [workspaceMemberFields.active]: { kind: 'boolean', value: false },
      },
    });
    const token = row.token;
    await db.platform.query('UPDATE app.users SET name=$2,image=$3 WHERE id=$1', [
      workspace.userId,
      'Ada',
      `data:image/png;base64,${'A'.repeat(20000)}`,
    ]);
    await projection.dispatch();
    assert.equal(
      await runtime.transaction(workspace.id, commonCompatibility, tx =>
        projectWorkspaceMemberProfile(tx, {
          memberId,
          membershipId: workspace.membershipId,
          profile: firstProfile,
        }),
      ),
      'stale',
    );
    assert.equal(
      (await raw.query(`SELECT profile_status FROM ${s}.tf_workspace_member_accounts WHERE member_id=$1`, [memberId]))
        .rows[0].profile_status,
      'pending',
    );
    assert.equal((await projection.project(workspace.id)).applied, 1);
    row = await read();
    assert.notEqual(row.token, token);
    assert.equal(row.values[workspaceMemberFields.name].value, 'Ada');
    assert.equal(row.values[workspaceMemberFields.contactEmail].value, 'business@example.test');
    assert.equal(row.values[workspaceMemberFields.active].value, false);
    assert.ok(row.values[workspaceMemberFields.photo].value.length < 2048);
    assert.equal(
      (
        await raw.query(`SELECT length(image) AS size FROM ${s}.tf_workspace_member_images WHERE member_id=$1`, [
          memberId,
        ])
      ).rows[0].size,
      20022,
    );
    const latestProfile = await sourceProfile();
    await raw.query('BEGIN');
    await raw.query(`SELECT id FROM ${s}.tf_authorization_lock WHERE id=1 FOR UPDATE`);
    await raw.query(`UPDATE ${s}.tf_memberships SET removed_at=clock_timestamp() WHERE id=$1`, [
      workspace.membershipId,
    ]);
    await refreshWorkspaceMemberAccess(tx, memberId);
    await raw.query('COMMIT');
    assert.deepEqual(await source.read(workspace.id, [workspace.userId]), []);
    assert.equal(
      await runtime.transaction(workspace.id, commonCompatibility, tx =>
        projectWorkspaceMemberProfile(tx, {
          memberId,
          membershipId: workspace.membershipId,
          profile: { ...latestProfile, revision: '3', name: 'Must not leak' },
        }),
      ),
      'detached',
    );
    const snapshot = (
      await raw.query(
        `SELECT f_4de907c4859049f19c45694e9fc36101 AS name,
    f_4de907c4859049f19c45694e9fc36104 AS email,f_4de907c4859049f19c45694e9fc36105 AS active,
    f_4de907c4859049f19c45694e9fc36106 AS access FROM ${s}."${directory.physical_table}" WHERE id=$1`,
        [memberId],
      )
    ).rows[0];
    assert.deepEqual(snapshot, { name: 'Ada', email: null, active: false, access: workspaceMemberAccess.none });
    const newAccessId = randomUUID();
    await raw.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'admin')`, [
      newAccessId,
      workspace.userId,
    ]);
    assert.equal(
      (await raw.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`, [workspace.userId]))
        .rows[0].member_id,
      memberId,
    );
    assert.equal((await projection.project(workspace.id)).applied, 1);
    assert.equal((await read()).values[workspaceMemberFields.active].value, false);
    const audit = (
      await raw.query(`SELECT actor FROM ${s}.tf_table_row_history WHERE table_id=$1 AND actor->>'kind'='system'`, [
        directory.table_id,
      ])
    ).rows;
    assert.ok(audit.length >= 3);
    assert.ok(audit.every(({ actor }) => !('email' in actor) && !('image' in actor) && !('provider' in actor)));
  },
);

test(
  'source failures are retryable and cannot overwrite replacement workers or newer queued profiles',
  { timeout: 45000 },
  async t => {
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const workspace = await db.create();
    await markWorkspaceReady(db.platform, workspace.id);
    const raw = await connect(db.login(workspace));
    cleanup.push(() => raw.end());
    const s = `"${workspace.names.schema}"`;
    const runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({
        workspaceId: workspace.id,
        generation: 1,
        connectionString: db.login(workspace),
      }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    cleanup.push(() => runtime.close());
    const source = memberProfileSource(db.platform),
      discover = async after => (after ? [] : [workspace.id]);
    const projection = createMemberProfileProjection({ runtime, source, discover });
    const status = async () =>
      (
        await raw.query(
          `SELECT profile_status,profile_error,profile_revision::text,requested_revision::text
    FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`,
          [workspace.userId],
        )
      ).rows[0];
    const unavailable = createMemberProfileProjection({
      runtime,
      discover,
      source: {
        ...source,
        read: async () => {
          throw new Error('Fixture source is offline');
        },
      },
    });
    await assert.rejects(unavailable.project(workspace.id), /Workspace member profile source unavailable/);
    assert.equal((await status()).profile_status, 'failed');
    assert.equal((await status()).profile_error, 'profile-projection-failed');
    await raw.query(`UPDATE ${s}.tf_workspace_member_accounts SET next_attempt_at=clock_timestamp()`);
    const replaced = createMemberProfileProjection({
      runtime,
      discover,
      source: {
        ...source,
        read: async () => {
          await projection.project(workspace.id);
          throw new Error('Replaced worker failed');
        },
      },
    });
    await assert.rejects(replaced.project(workspace.id), /Workspace member profile source unavailable/);
    assert.equal((await status()).profile_status, 'current');
    assert.equal((await status()).profile_error, null);
    await db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [workspace.userId, 'Version two']);
    await projection.dispatch();
    const superseded = createMemberProfileProjection({
      runtime,
      discover,
      source: {
        ...source,
        read: async () => {
          await db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [workspace.userId, 'Version three']);
          await projection.dispatch();
          throw new Error('Older queued profile failed');
        },
      },
    });
    await assert.rejects(superseded.project(workspace.id), /Workspace member profile source unavailable/);
    assert.deepEqual(await status(), {
      profile_status: 'pending',
      profile_error: null,
      profile_revision: '1',
      requested_revision: '3',
    });
    assert.equal((await projection.project(workspace.id)).applied, 1);
    assert.deepEqual(await status(), {
      profile_status: 'current',
      profile_error: null,
      profile_revision: '3',
      requested_revision: '3',
    });
  },
);

test(
  'bounded reconciliation catches up behind blocked fan-out and pending events rotate without losing revisions',
  { timeout: 45000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const workspace = await db.create();
    await markWorkspaceReady(db.platform, workspace.id);
    const s = `"${workspace.names.schema}"`;
    runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({
        workspaceId: workspace.id,
        generation: 1,
        connectionString: db.login(workspace),
      }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const source = memberProfileSource(db.platform);
    const discover = async after => (after ? [] : [workspace.id]);
    const projection = createMemberProfileProjection({ runtime, source, discover });
    await projection.project(workspace.id);
    const broken = randomUUID();
    const blocked = createMemberProfileProjection({
      source,
      discover: async () => [broken, workspace.id],
      runtime: {
        transaction: (id, range, operation) => {
          if (id === broken) throw new Error('Fixture workspace unavailable');
          return runtime.transaction(id, range, operation);
        },
      },
    });
    await db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [workspace.userId, 'Catch up without fan-out']);
    await assert.rejects(blocked.dispatch(), /dispatch incomplete/);
    assert.equal(
      (await db.platform.query(`SELECT profile_status FROM ${s}.tf_workspace_member_accounts`)).rows[0].profile_status,
      'current',
    );
    const due = () =>
      db.platform.query(`UPDATE ${s}.tf_workspace_member_accounts SET next_attempt_at=clock_timestamp()`);
    await due();
    assert.equal((await projection.project(workspace.id)).applied, 1);
    const directory = await runtime.transaction(workspace.id, commonCompatibility, async tx =>
      activeGeneration(tx, (await workspaceMembersTable(tx)).coreDefinition.id),
    );
    const record = (
      await db.platform.query(
        `SELECT token,f_4de907c4859049f19c45694e9fc36101 AS name FROM ${s}."${directory.physical_table}"`,
      )
    ).rows[0];
    assert.equal(record.name, 'Catch up without fan-out');
    await due();
    assert.equal((await projection.project(workspace.id)).unchanged, 1);
    assert.equal(
      (await db.platform.query(`SELECT token FROM ${s}."${directory.physical_table}"`)).rows[0].token,
      record.token,
    );
    assert.equal(
      (
        await db.platform.query(
          `SELECT next_attempt_at>clock_timestamp() AS deferred FROM ${s}.tf_workspace_member_accounts`,
        )
      ).rows[0].deferred,
      true,
    );
    await due();
    const unavailable = createMemberProfileProjection({
      runtime,
      discover,
      source: {
        ...source,
        read: async () => {
          throw new Error('Fixture reconciliation unavailable');
        },
      },
    });
    await assert.rejects(unavailable.project(workspace.id), /source unavailable/);
    assert.equal(
      (await db.platform.query(`SELECT profile_status FROM ${s}.tf_workspace_member_accounts`)).rows[0].profile_status,
      'failed',
    );
    const ids = Array.from({ length: 22 }, () => randomUUID());
    for (const id of ids) await seedPlatformUser(db.platform, { id, name: 'Fair queue' });
    const first = await source.pending(),
      second = await source.pending();
    assert.equal(first.length, 10);
    assert.equal(second.length, 10);
    assert.equal(
      new Set([...first, ...second].map(event => event.user_id)).size,
      20,
      'Failed/unacknowledged events cannot pin the first page',
    );
    assert.equal(
      (
        await db.platform.query('SELECT revision::text FROM app.member_profile_outbox WHERE user_id=$1', [
          workspace.userId,
        ])
      ).rows[0].revision,
      '2',
    );
  },
);
