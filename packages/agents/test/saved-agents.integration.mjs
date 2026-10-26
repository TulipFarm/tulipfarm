import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { provisionWorkspace } from '@tulipfarm/workspace-storage/provisioning';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createGovernanceService } from '@tulipfarm/workspaces/governance';
import { initializeSoul, soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision, readVerifiedProjection, verifySoulRevision } from '@tulipfarm/workspaces/soul-revisions';
import { AccessDenied, lockAuthorization, requireCurrentActor } from '@tulipfarm/access';
import { createAgentAuthoring } from '../dist/authoring.js';
import { createSavedAgentService } from '../dist/saved-service.js';
import { agentCompatibility, createAgentStore } from '../dist/store.js';
import { createAgentSchedules } from '../dist/schedules.js';
import { policyVersion, soulStorageSkip } from './soul-fixture.mjs';

async function saveRace(owner, table, operations) {
  await owner.query('BEGIN');
  await owner.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id = 1 FOR UPDATE`);
  const pending = Promise.allSettled(operations.map(operation => operation()));
  try {
    let blocked = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      await owner.query('SELECT pg_stat_clear_snapshot()');
      blocked = (
        await owner.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%tf_soul_head%FOR UPDATE%'`,
        )
      ).rows[0].count;
      if (blocked === operations.length) break;
      await setTimeout(25);
    }
    assert.equal(blocked, operations.length, 'both saves must reach the held PostgreSQL Soul-head lock');
  } finally {
    await owner.query('COMMIT');
  }
  const outcomes = await pending;
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  return outcomes.map(outcome => outcome.value);
}

test(
  'saved agents accept immutable Soul revisions with live grants and exact activations',
  { timeout: 180000, skip: soulStorageSkip },
  async () => {
    const soul = soulStorageConfig();
    assert.equal(soul.bucket, 'tulipfarm-cloud-soul-local');
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const database = `saved_agents_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({ connectionString: 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres' });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await provisionTestPgvector(admin, database);
    const connectionString = `postgresql://postgres:local-postgres@127.0.0.1:5432/${database}`;
    const owner = new Client({ connectionString });
    await owner.connect();
    let names;
    let runtime;
    try {
      await owner.query('CREATE SCHEMA app');
      await owner.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const passwords = { runtime: randomUUID(), migration: randomUUID(), confirmation: randomUUID() };
      names = await provisionWorkspace({
        connectionString,
        workspaceId,
        passwords,
        initialAdmin: { userId, membershipId },
        migrations: await workspaceTableMigrations(),
      });
      await registerPlatformWorkspace(owner, workspaceId);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({
          workspaceId: id,
          generation: 1,
          connectionString: `postgresql://${names.runtime}:${passwords.runtime}@127.0.0.1:5432/${database}`,
        }),
      });
      const seed = { workspaceId, createdBy: userId, createdAt: new Date().toISOString() };
      const initial = await initializeSoul(soul, seed);
      const table = name => `"${names.schema}".${name}`;
      await owner.query(`UPDATE ${table('tf_soul_head')} SET revision = $1`, [initial.commit]);
      const engineering = randomUUID();
      const readers = randomUUID();
      const memberId = randomUUID();
      const member = randomUUID();
      const readerId = randomUUID();
      const reader = randomUUID();
      await owner.query(`INSERT INTO ${table('tf_teams')} (id, name) VALUES ($1,'Engineering'),($2,'Readers')`, [
        engineering,
        readers,
      ]);
      await owner.query(
        `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
        [memberId, member, readerId, reader],
      );
      await owner.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2),($3,$4)`, [
        memberId,
        engineering,
        readerId,
        readers,
      ]);
      // The creator manages both teams explicitly. Workspace admin status grants no team or agent authority.
      await owner.query(
        `INSERT INTO ${table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager'),($1,$3,'manager')`,
        [membershipId, engineering, readers],
      );
      const creatorGrants = [{ membershipId, permissions: ['delete', 'edit', 'invoke', 'manage', 'read'] }];
      const commands = createAgentAuthoring(runtime);
      const service = createSavedAgentService(runtime, (id, projection) =>
        readVerifiedProjection(soul, id, projection),
      );
      const executor = createAgentStore(runtime);
      let pause = async () => {};
      const worker = commands.withWriter(async input => {
        const parent = input.parent
          ? { commit: input.expectedParentCommit, bucket: soul.bucket, ...input.parent }
          : initial;
        const prepared = await prepareSoulRevision(soul, seed, parent, {
          kind: 'agent',
          commandId: input.commandId,
          expectedParentCommit: input.expectedParentCommit,
          createdAt: input.createdAt,
          definition: input.definition,
        });
        await pause();
        return prepared;
      });
      const agentId = randomUUID();
      const definition = {
        name: 'Invoice assistant',
        instructions: 'Only read the requested invoices.',
        tools: ['github.issue.read', 'rows.list', 'schema.inspect'],
        skills: [{ id: 'table-authoring', revision: '1' }],
      };
      const input = {
        requestId: randomUUID(),
        expectedSoulRevision: initial.commit,
        expectedSavedRevision: null,
        owningTeamId: engineering,
        definition,
      };
      await assert.rejects(
        commands.save(workspaceId, member, agentId, { ...input, owningTeamId: readers }),
        AccessDenied,
      );
      const [command, duplicate] = await saveRace(owner, table, [
        () => commands.save(workspaceId, userId, agentId, input),
        () =>
          commands.save(
            workspaceId.toUpperCase(),
            { kind: 'human', userId, membershipId: membershipId.toUpperCase() },
            agentId.toUpperCase(),
            { ...input, requestId: input.requestId.toUpperCase(), owningTeamId: engineering.toUpperCase() },
          ),
      ]);
      assert.deepEqual(duplicate, command);
      assert.equal(
        (
          await owner.query(`SELECT count(*)::int AS count FROM ${table('tf_agent_commands')} WHERE request_id = $1`, [
            input.requestId,
          ])
        ).rows[0].count,
        1,
      );
      assert.deepEqual(await commands.save(workspaceId, userId, agentId, input), command);
      assert.deepEqual(await service.list(workspaceId, userId), { agents: [], count: 0, nextCursor: null });
      const accepted = await worker.prepare(workspaceId.toUpperCase(), command.commandId.toUpperCase());
      assert.equal(accepted.status, 'accepted');
      assert.deepEqual(
        await commands.save(workspaceId.toUpperCase(), userId, agentId.toUpperCase(), {
          ...input,
          requestId: input.requestId.toUpperCase(),
          owningTeamId: engineering.toUpperCase(),
        }),
        accepted,
      );
      assert.deepEqual(
        await commands.commandStatus(
          workspaceId.toUpperCase(),
          { kind: 'human', userId, membershipId: membershipId.toUpperCase() },
          command.commandId.toUpperCase(),
        ),
        accepted,
      );
      await assert.rejects(
        commands.save(workspaceId, userId, agentId, {
          ...input,
          definition: { ...definition, instructions: 'Different replay' },
        }),
        error => error.code === 'idempotency-conflict',
      );
      const first = await service.detail(workspaceId, userId, agentId);
      assert.deepEqual(first.definition, definition);
      assert.deepEqual(first.activations, []);
      assert.deepEqual(await service.list(workspaceId, member), { agents: [], count: 0, nextCursor: null });
      await assert.rejects(service.detail(workspaceId, member, agentId), AccessDenied);
      await assert.rejects(
        owner.query(`DELETE FROM ${table('tf_teams')} WHERE id=$1`, [engineering]),
        error => error.code === '23503',
      );
      const actor = { kind: 'human', userId, membershipId };
      await assert.rejects(
        executor.saveDefinition(workspaceId, actor, agentId, { ...definition, instructions: 'Bypass Soul' }),
        AccessDenied,
      );
      const legacyId = randomUUID();
      await assert.rejects(executor.saveDefinition(workspaceId, actor, legacyId, definition), AccessDenied);
      assert.equal(
        (await owner.query(`SELECT count(*)::int AS count FROM ${table('tf_agents')} WHERE id=$1`, [legacyId])).rows[0]
          .count,
        0,
      );
      const legacyRevision = 'c'.repeat(64);
      const legacyActivation = randomUUID();
      const legacySchedule = randomUUID();
      const legacyRun = randomUUID();
      await owner.query(`INSERT INTO ${table('tf_agents')} (id) VALUES ($1)`, [legacyId]);
      await owner.query(
        `INSERT INTO ${table('tf_agent_definitions')} (agent_id, revision, definition) VALUES ($1,$2,$3)`,
        [legacyId, legacyRevision, definition],
      );
      await owner.query(
        `INSERT INTO ${table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,'[]')`,
        [legacyActivation, legacyId, legacyRevision],
      );
      await owner.query(`INSERT INTO ${table('tf_agent_limits')} (agent_id,scope) VALUES ($1,'[]')`, [legacyId]);
      await owner.query(`INSERT INTO ${table('tf_agent_schedules')} (id,activation_id,scope) VALUES ($1,$2,'[]')`, [
        legacySchedule,
        legacyActivation,
      ]);
      await owner.query(
        `INSERT INTO ${table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,schedule_id,scope) VALUES ($1,$2,$3,$4,'scheduled',$5,'[]')`,
        [legacyRun, legacyId, legacyActivation, legacyRevision, legacySchedule],
      );
      await assert.rejects(
        executor.activate(workspaceId, actor, { agentId: legacyId, revision: legacyRevision, scope: [] }),
        AccessDenied,
      );
      await assert.rejects(
        executor.startDelegated(workspaceId, actor, { activationId: legacyActivation, scope: [] }),
        AccessDenied,
      );
      await assert.rejects(
        executor.startScheduled(workspaceId, { scheduleId: legacySchedule, runId: randomUUID() }),
        AccessDenied,
      );
      await assert.rejects(
        runtime.transaction(workspaceId, agentCompatibility, async transaction => {
          await lockAuthorization(transaction);
          await requireCurrentActor(transaction, { kind: 'agent', runId: legacyRun });
        }),
        AccessDenied,
      );
      await service.updatePolicy(workspaceId, userId, agentId, {
        version: 0,
        owningTeamId: engineering,
        grants: [
          { teamId: engineering, permissions: ['read', 'edit'] },
          { teamId: readers, permissions: ['read'] },
        ],
        personGrants: creatorGrants,
      });
      assert.equal((await service.list(workspaceId, member, { limit: 1 })).count, 1);
      assert.equal(
        (await service.detail(workspaceId, reader, agentId)).definition.instructions,
        definition.instructions,
      );
      const activation = await service.activate(workspaceId, userId, agentId, {
        revision: first.definitionRevision,
        scope: [],
      });
      const staleVersion = await policyVersion(owner, table, agentId);
      const taskLimits = { toolCalls: 25, credits: 250, activeMilliseconds: 600000 };
      await service.configure(workspaceId, userId, agentId, {
        version: staleVersion,
        enabled: true,
        teamIds: [engineering],
        limits: [],
        taskLimits,
      });
      assert.deepEqual((await service.policy(workspaceId, userId, agentId)).taskLimits, taskLimits);
      const configuration = async () => ({
        agent: (await owner.query(`SELECT enabled, policy_version FROM ${table('tf_agents')} WHERE id=$1`, [agentId]))
          .rows[0],
        teams: (
          await owner.query(`SELECT team_id FROM ${table('tf_agent_teams')} WHERE agent_id=$1 ORDER BY team_id`, [
            agentId,
          ])
        ).rows,
        limits: (await owner.query(`SELECT scope FROM ${table('tf_agent_limits')} WHERE agent_id=$1`, [agentId]))
          .rows[0].scope,
        audits: (
          await owner.query(
            `SELECT count(*)::int AS count FROM ${table('tf_audit_events')} WHERE subject_id=$1 AND operation='agent.configure'`,
            [agentId],
          )
        ).rows[0].count,
      });
      const configured = await configuration();
      assert.deepEqual(configured, {
        agent: { enabled: true, policy_version: staleVersion + 1 },
        teams: [{ team_id: engineering }],
        limits: [],
        audits: 1,
      });
      assert.throws(
        () => service.configure(workspaceId, userId, agentId, { enabled: false, teamIds: [readers], limits: [] }),
        error => error.name === 'ZodError',
      );
      assert.deepEqual(await configuration(), configured);
      await assert.rejects(
        service.configure(workspaceId, userId, agentId, {
          version: staleVersion,
          enabled: false,
          teamIds: [readers],
          limits: [{ assetId: readers, permissions: ['table.create'] }],
        }),
        error => error.code === 'policy-version-conflict',
      );
      assert.deepEqual(await configuration(), configured);
      const races = await Promise.allSettled([
        service.configure(workspaceId, userId, agentId, {
          version: configured.agent.policy_version,
          enabled: true,
          teamIds: [engineering],
          limits: [],
        }),
        service.configure(workspaceId, userId, agentId, {
          version: configured.agent.policy_version,
          enabled: true,
          teamIds: [readers],
          limits: [],
        }),
      ]);
      assert.equal(races.filter(outcome => outcome.status === 'fulfilled').length, 1);
      assert.equal(races.find(outcome => outcome.status === 'rejected').reason.code, 'policy-version-conflict');
      assert.deepEqual(await configuration(), {
        agent: { enabled: true, policy_version: configured.agent.policy_version + 1 },
        teams: [{ team_id: races[0].status === 'fulfilled' ? engineering : readers }],
        limits: [],
        audits: 2,
      });
      const beforeConfigure = await service.policy(workspaceId, userId, agentId);
      await service.configure(workspaceId, userId, agentId, {
        version: beforeConfigure.version,
        enabled: true,
        teamIds: [engineering],
        limits: [],
      });
      const afterConfigure = await service.policy(workspaceId, userId, agentId);
      assert.deepEqual(afterConfigure, {
        ...beforeConfigure,
        version: beforeConfigure.version + 1,
        enrollment: [engineering],
        enabled: true,
        limits: [],
      });
      const configuredBeforeStalePolicy = await configuration();
      await assert.rejects(
        service.updatePolicy(workspaceId, userId, agentId, {
          version: beforeConfigure.version,
          owningTeamId: readers,
          grants: [],
          personGrants: creatorGrants,
        }),
        error => error.code === 'policy-version-conflict',
      );
      assert.deepEqual(await service.policy(workspaceId, userId, agentId), afterConfigure);
      assert.deepEqual(await configuration(), configuredBeforeStalePolicy);
      await service.updatePolicy(workspaceId, userId, agentId, {
        version: afterConfigure.version,
        owningTeamId: readers,
        grants: [{ teamId: engineering, permissions: ['read', 'edit'] }],
        personGrants: creatorGrants,
      });
      const afterPolicy = await service.policy(workspaceId, userId, agentId);
      assert.deepEqual(afterPolicy, {
        ...afterConfigure,
        version: afterConfigure.version + 1,
        owningTeamId: readers,
        grants: [{ teamId: engineering, permissions: ['edit', 'read'] }],
      });
      assert.deepEqual(afterPolicy.personGrants, creatorGrants);
      await assert.rejects(
        service.configure(workspaceId, userId, agentId, {
          version: afterConfigure.version,
          enabled: false,
          teamIds: [readers],
          limits: [{ assetId: readers, permissions: ['table.create'] }],
        }),
        error => error.code === 'policy-version-conflict',
      );
      assert.deepEqual(await service.policy(workspaceId, userId, agentId), afterPolicy);
      assert.deepEqual(await configuration(), {
        ...configuredBeforeStalePolicy,
        agent: { enabled: true, policy_version: afterPolicy.version },
      });
      const memberActor = { kind: 'human', userId: member, membershipId: memberId };
      await assert.rejects(
        executor.startDelegated(workspaceId, memberActor, { activationId: activation.activationId, scope: [] }),
        AccessDenied,
      );
      await service.updatePolicy(workspaceId, userId, agentId, {
        version: await policyVersion(owner, table, agentId),
        owningTeamId: engineering,
        grants: [
          { teamId: engineering, permissions: ['read', 'edit', 'invoke'] },
          { teamId: readers, permissions: ['read'] },
        ],
        personGrants: creatorGrants,
      });
      const delegated = await executor.startDelegated(workspaceId, memberActor, {
        activationId: activation.activationId,
        scope: [],
      });
      const liveRun = () =>
        runtime.transaction(workspaceId, agentCompatibility, async transaction => {
          await lockAuthorization(transaction);
          await requireCurrentActor(transaction, { kind: 'agent', runId: delegated.runId });
          return 'authorized';
        });
      assert.equal(await liveRun(), 'authorized');
      const beforeRevocation = await policyVersion(owner, table, agentId);
      await service.updatePolicy(workspaceId, userId, agentId, {
        version: beforeRevocation,
        owningTeamId: engineering,
        grants: [
          { teamId: engineering, permissions: ['read', 'edit'] },
          { teamId: readers, permissions: ['read'] },
        ],
        personGrants: creatorGrants,
      });
      await assert.rejects(liveRun(), AccessDenied);
      await assert.rejects(
        service.updatePolicy(workspaceId, userId, agentId, {
          version: beforeRevocation,
          owningTeamId: readers,
          grants: [],
          personGrants: creatorGrants,
        }),
        error => error.code === 'policy-version-conflict',
      );
      const edit = {
        ...input,
        requestId: randomUUID(),
        expectedSoulRevision: first.savedRevision,
        expectedSavedRevision: first.savedRevision,
        definition: {
          ...definition,
          instructions: 'A newly saved instruction.',
          skills: [{ id: 'agent-authoring', revision: '1' }],
        },
      };
      await assert.rejects(commands.save(workspaceId, reader, agentId, edit), AccessDenied);
      const editCommand = await commands.save(workspaceId, member, agentId, edit);
      const concurrent = await commands.save(workspaceId, userId, agentId, {
        ...edit,
        requestId: randomUUID(),
        definition: { ...definition, instructions: 'Must not overwrite.' },
      });
      assert.equal((await worker.prepare(workspaceId, editCommand.commandId)).status, 'accepted');
      assert.equal((await worker.prepare(workspaceId, concurrent.commandId)).status, 'conflict');
      const changed = await service.detail(workspaceId, member, agentId);
      assert.equal(changed.definition.instructions, 'A newly saved instruction.');
      assert.deepEqual(changed.activations, [
        { id: activation.activationId, revision: first.definitionRevision, scope: [] },
      ]);
      assert.deepEqual(changed.definition.skills, [{ id: 'agent-authoring', revision: '1' }]);
      const pinned = (
        await owner.query(
          `SELECT d.definition FROM ${table('tf_agent_activations')} a JOIN ${table('tf_agent_definitions')} d ON d.agent_id=a.agent_id AND d.revision=a.definition_revision WHERE a.id=$1`,
          [activation.activationId],
        )
      ).rows[0].definition;
      assert.deepEqual(pinned.skills, [{ id: 'table-authoring', revision: '1' }]);
      const receipt = (
        await owner.query(
          `SELECT r.*, s.projection FROM ${table('tf_soul_revisions')} r JOIN ${table('tf_agent_saved_revisions')} s ON s.soul_revision=r.revision WHERE r.revision=$1`,
          [changed.savedRevision],
        )
      ).rows[0];
      const restored = await verifySoulRevision(
        soul,
        seed,
        { commit: receipt.revision, bucket: soul.bucket, key: receipt.bundle_key, sha256: receipt.bundle_sha256 },
        receipt.projection,
      );
      assert.equal(restored.definition.instructions, 'A newly saved instruction.');
      assert.deepEqual(restored.definition.skills, [{ id: 'agent-authoring', revision: '1' }]);
      const queued = await commands.save(workspaceId, member, agentId, {
        ...edit,
        requestId: randomUUID(),
        expectedSoulRevision: changed.savedRevision,
        expectedSavedRevision: changed.savedRevision,
      });
      pause = async () =>
        service.updatePolicy(workspaceId, userId, agentId, {
          version: await policyVersion(owner, table, agentId),
          owningTeamId: readers,
          grants: [{ teamId: readers, permissions: ['read'] }],
          personGrants: creatorGrants,
        });
      assert.equal((await worker.prepare(workspaceId, queued.commandId)).status, 'failed');
      await assert.rejects(service.detail(workspaceId, member, agentId), AccessDenied);
      assert.equal((await service.detail(workspaceId, userId, agentId)).savedRevision, changed.savedRevision);
      const midRead = createSavedAgentService(runtime, async (id, projection) => {
        const value = await readVerifiedProjection(soul, id, projection);
        await service.updatePolicy(workspaceId, userId, agentId, {
          version: await policyVersion(owner, table, agentId),
          owningTeamId: readers,
          grants: [],
          personGrants: creatorGrants,
        });
        return value;
      });
      await assert.rejects(midRead.detail(workspaceId, reader, agentId), AccessDenied);
      assert.deepEqual((await service.context(workspaceId, member)).teams, [{ id: engineering, name: 'Engineering' }]);
      pause = async () => {};
      const newId = randomUUID();
      const creation = await commands.save(workspaceId, member, newId, {
        ...input,
        requestId: randomUUID(),
        expectedSoulRevision: changed.savedRevision,
      });
      await owner.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [memberId]);
      await owner.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        randomUUID(),
        member,
      ]);
      assert.equal((await worker.prepare(workspaceId, creation.commandId)).status, 'failed');
      const otherAgentId = randomUUID();
      const otherCommand = await commands.save(workspaceId, userId, otherAgentId, {
        ...input,
        requestId: randomUUID(),
        expectedSoulRevision: changed.savedRevision,
      });
      assert.equal((await worker.prepare(workspaceId, otherCommand.commandId)).status, 'accepted');
      const schedules = createAgentSchedules(runtime);
      const tableId = randomUUID();
      const inspectionScope = [{ assetId: tableId, permissions: ['table.row.read'] }];
      await service.configure(workspaceId, userId, agentId, {
        version: await policyVersion(owner, table, agentId),
        enabled: true,
        teamIds: [engineering],
        limits: inspectionScope,
      });
      const inspectionId = randomUUID();
      const inspectionInput = {
        id: inspectionId.toUpperCase(),
        revision: first.definitionRevision,
        tableId: tableId.toUpperCase(),
      };
      assert.deepEqual(
        await schedules.activate(workspaceId.toUpperCase(), userId, agentId.toUpperCase(), inspectionInput),
        { activationId: inspectionId },
      );
      assert.deepEqual(
        await schedules.activate(workspaceId, userId, agentId, { ...inspectionInput, id: inspectionId, tableId }),
        { activationId: inspectionId },
      );
      const inspectionRow = async () =>
        (
          await owner.query(
            `SELECT agent_id, definition_revision, scope, revoked_at FROM ${table('tf_agent_activations')} WHERE id=$1`,
            [inspectionId],
          )
        ).rows[0];
      const liveInspection = {
        agent_id: agentId,
        definition_revision: first.definitionRevision,
        scope: inspectionScope,
        revoked_at: null,
      };
      assert.deepEqual(await inspectionRow(), liveInspection);
      await assert.rejects(service.revokeActivation(workspaceId, userId, otherAgentId, inspectionId), AccessDenied);
      assert.deepEqual(await inspectionRow(), liveInspection);
      await service.updatePolicy(workspaceId, userId, agentId, {
        version: await policyVersion(owner, table, agentId),
        owningTeamId: readers,
        grants: [{ teamId: readers, permissions: ['read', 'edit', 'invoke'] }],
        personGrants: creatorGrants,
      });
      await assert.rejects(service.revokeActivation(workspaceId, reader, agentId, inspectionId), AccessDenied);
      assert.deepEqual(await inspectionRow(), liveInspection);
      const inspectionRun = await executor.startDelegated(workspaceId, actor, {
        activationId: inspectionId,
        scope: inspectionScope,
      });
      assert.equal(inspectionRun.revision, first.definitionRevision);
      assert.deepEqual(
        await service.revokeActivation(
          workspaceId.toUpperCase(),
          userId,
          agentId.toUpperCase(),
          inspectionId.toUpperCase(),
        ),
        { saved: true },
      );
      const revokedInspection = await inspectionRow();
      assert.ok(revokedInspection.revoked_at instanceof Date);
      assert.deepEqual(await service.revokeActivation(workspaceId, userId, agentId, inspectionId), { saved: true });
      assert.deepEqual(await inspectionRow(), revokedInspection);
      assert.deepEqual(
        await schedules.activate(workspaceId, userId, agentId, { ...inspectionInput, id: inspectionId, tableId }),
        { activationId: inspectionId },
      );
      assert.deepEqual(await inspectionRow(), revokedInspection);
      await assert.rejects(
        executor.startDelegated(workspaceId, actor, { activationId: inspectionId, scope: inspectionScope }),
        AccessDenied,
      );
      await assert.rejects(
        runtime.transaction(workspaceId, agentCompatibility, async transaction => {
          await lockAuthorization(transaction);
          await requireCurrentActor(transaction, { kind: 'agent', runId: inspectionRun.runId });
        }),
        AccessDenied,
      );
      assert.deepEqual((await service.detail(workspaceId, userId, agentId)).activations, [
        { id: activation.activationId, revision: first.definitionRevision, scope: [] },
      ]);
      const disposableTeam = randomUUID();
      await owner.query(`INSERT INTO ${table('tf_teams')} (id, name) VALUES ($1,'Policy revocation')`, [
        disposableTeam,
      ]);
      await owner.query(
        `INSERT INTO ${table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager')`,
        [membershipId, disposableTeam],
      );
      await service.updatePolicy(workspaceId, userId, agentId, {
        version: await policyVersion(owner, table, agentId),
        owningTeamId: readers,
        grants: [{ teamId: disposableTeam, permissions: ['read'] }],
        personGrants: creatorGrants,
      });
      await service.configure(workspaceId, userId, agentId, {
        version: await policyVersion(owner, table, agentId),
        enabled: true,
        teamIds: [disposableTeam],
        limits: [],
      });
      const beforeTeamDeletion = await service.policy(workspaceId, userId, agentId);
      const governance = createGovernanceService({ runtime, identity: owner, compatibility: agentCompatibility });
      await governance.deleteTeam(workspaceId, userId, disposableTeam);
      assert.deepEqual(await service.policy(workspaceId, userId, agentId), {
        ...beforeTeamDeletion,
        version: beforeTeamDeletion.version + 1,
        grants: [],
        enrollment: [],
      });
      await assert.rejects(
        service.configure(workspaceId, userId, agentId, {
          version: beforeTeamDeletion.version,
          enabled: true,
          teamIds: [engineering],
          limits: inspectionScope,
        }),
        error => error.code === 'policy-version-conflict',
      );
      await assert.rejects(
        service.updatePolicy(workspaceId, userId, agentId, {
          version: beforeTeamDeletion.version,
          owningTeamId: readers,
          grants: [],
          personGrants: creatorGrants,
        }),
        error => error.code === 'policy-version-conflict',
      );
      await service.remove(workspaceId, userId, otherAgentId);
      await service.remove(workspaceId, userId, agentId);
      assert.deepEqual(await service.list(workspaceId, userId), { agents: [], count: 0, nextCursor: null });
      await assert.rejects(service.detail(workspaceId, userId, agentId), AccessDenied);
      await governance.deleteTeam(workspaceId, userId, readers);
      assert.equal(
        (await owner.query(`SELECT count(*)::int AS count FROM ${table('tf_teams')} WHERE id=$1`, [readers])).rows[0]
          .count,
        0,
      );
      assert.deepEqual(
        (
          await owner.query(
            `SELECT DISTINCT operation FROM ${table('tf_audit_events')} WHERE operation LIKE 'agent.%' ORDER BY operation`,
          )
        ).rows.map(row => row.operation),
        [
          'agent.activate',
          'agent.activation.revoke',
          'agent.configure',
          'agent.definition.accepted',
          'agent.delete',
          'agent.inspection.activate',
          'agent.policy.update',
        ],
      );
      const modelAuthoring = createAgentAuthoring(runtime, () => true);
      for (const skills of [[], [{ id: 'table-authoring', revision: '1' }]]) {
        for (const selection of [
          { modelFamilyId: 'claude-opus', skills },
          { skills, modelFamilyId: 'claude-opus' },
        ]) {
          const id = randomUUID();
          const combined = {
            name: 'Model and skills',
            instructions: 'Read authorized records.',
            tools: ['rows.list'],
            ...selection,
          };
          const head = (await owner.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0].revision;
          const command = await modelAuthoring.save(workspaceId, userId, id, {
            requestId: randomUUID(),
            expectedSoulRevision: head,
            expectedSavedRevision: null,
            owningTeamId: engineering,
            definition: combined,
          });
          assert.equal((await worker.prepare(workspaceId, command.commandId)).status, 'accepted');
          const detail = await service.detail(workspaceId, userId, id);
          assert.deepEqual(detail.definition, combined);
          const row = (
            await owner.query(
              `SELECT r.*,s.projection FROM ${table('tf_soul_revisions')} r JOIN ${table('tf_agent_saved_revisions')} s ON s.soul_revision=r.revision WHERE r.revision=$1`,
              [detail.savedRevision],
            )
          ).rows[0];
          const restored = await verifySoulRevision(
            soul,
            seed,
            { commit: row.revision, bucket: soul.bucket, key: row.bundle_key, sha256: row.bundle_sha256 },
            row.projection,
          );
          assert.deepEqual(restored.definition, { formatVersion: 1, id, ...combined });
          assert.equal((await worker.prepare(workspaceId, command.commandId)).status, 'accepted');
        }
      }
    } finally {
      await runtime?.close();
      await owner.end();
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (names)
        for (const role of [names.runtime, names.migration, names.confirmation, names.customOwner])
          await admin.query(`DROP ROLE "${role}"`);
      await admin.end();
      const objects = await soul.client.send(
        new ListObjectsV2Command({ Bucket: soul.bucket, Prefix: `workspaces/${workspaceId}/` }),
      );
      if (objects.Contents?.length)
        await soul.client.send(
          new DeleteObjectsCommand({
            Bucket: soul.bucket,
            Delete: { Objects: objects.Contents.map(object => ({ Key: object.Key })) },
          }),
        );
      soul.client.destroy();
    }
  },
);
import { provisionTestPgvector } from '../../workspace-storage/test/integration/pgvector.fixture.mjs';
