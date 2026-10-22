import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Client } from 'pg';
import { provisionWorkspace, inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { AccessDenied } from '@tulipfarm/access';
import { createAgentStore } from '../dist/store.js';
import { createAgentChat as createContinuityChat } from '../dist/chat.js';
import { syntheticContinuity } from './continuity-fixture.mjs';
import { createSavedAgentService } from '../dist/saved-service.js';
import { createSoulAgentFixture, policyVersion } from './soul-fixture.mjs';
import { provisionTestPgvector } from '../../workspace-storage/test/integration/pgvector.fixture.mjs';
import { registerPlatformWorkspace } from '../../workspace-storage/test/integration/fixture.mjs';

const createAgentChat = (runtime, model) => createContinuityChat(runtime, model ? syntheticContinuity(model) : null);

test(
  'persisted chat pins revisions, serializes replay, executes real authorized tools and rejects revoked or hostile model decisions',
  { timeout: 180000 },
  async () => {
    const workspaceId = randomUUID();
    const membershipId = randomUUID();
    const agentId = randomUUID();
    const teamId = randomUUID();
    const tableId = randomUUID();
    const database = `chat_${randomUUID().replaceAll('-', '')}`;
    const adminUrl =
      process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres';
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await provisionTestPgvector(admin, database);
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${database}`;
    const url = databaseUrl.href;
    const owner = new Client({ connectionString: url });
    await owner.connect();
    let runtime;
    let names;
    let soulFixture;
    try {
      await owner.query('CREATE SCHEMA app');
      await owner.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const passwords = { runtime: randomUUID(), migration: randomUUID(), confirmation: randomUUID() };
      names = await provisionWorkspace({
        connectionString: url,
        workspaceId,
        passwords,
        initialAdmin: { userId: 'admin', membershipId },
        migrations: await workspaceTableMigrations(),
      });
      await registerPlatformWorkspace(owner, workspaceId);
      const runtimeConnection = new URL(url);
      runtimeConnection.username = names.runtime;
      runtimeConnection.password = passwords.runtime;
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: runtimeConnection.href }),
      });
      const table = name => `"${names.schema}".${name}`;
      const store = createAgentStore(runtime);
      const actor = { kind: 'human', userId: 'admin', membershipId };
      await owner.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Synthetic')`, [teamId]);
      // #478 removed admins' automatic team access, so the saving admin must belong to the team.
      await owner.query(
        `INSERT INTO ${table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager')`,
        [membershipId, teamId],
      );
      const definition = {
        name: 'Synthetic inspector',
        instructions: 'Inspect the requested resource',
        tools: ['schema.inspect', 'rows.list', 'rows.delete'],
        skills: [{ id: 'table-authoring', revision: '1' }],
      };
      soulFixture = await createSoulAgentFixture({ runtime, owner, table, workspaceId, createdBy: randomUUID() });
      const saved = await soulFixture.save(workspaceId, actor, agentId, teamId, definition);
      const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
      await store.configure(workspaceId, actor, {
        agentId,
        version: await policyVersion(owner, table, agentId),
        enabled: true,
        teamIds: [teamId],
        limits: scope,
      });
      const activation = await store.activate(workspaceId, actor, { agentId, revision: saved.revision, scope });
      await owner.query(
        `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [teamId, tableId],
      );
      const applied = {
        formatVersion: 2,
        id: tableId,
        owningTeamId: teamId,
        label: 'Synthetic target',
        fields: [],
        uniqueKeys: [],
      };
      const appliedRevision = 'a'.repeat(40);
      await inTransaction(owner, async client => {
        await client.query(`SET LOCAL ROLE "${names.customOwner}"`);
        const tx = { client, schema: names.schema };
        const generation = await createGeneration(tx, { definition: applied, revision: appliedRevision });
        await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
        await client.query(
          `UPDATE ${table('tf_table_catalog')} SET applied_revision=$2, applied_definition=$3, physical_table=$4 WHERE id=$1`,
          [tableId, appliedRevision, applied, generation.physical_table],
        );
      });
      let calls = 0;
      let release;
      let started;
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const entered = new Promise(resolve => {
        started = resolve;
      });
      const chat = createAgentChat(runtime, async input => {
        calls++;
        assert.equal(input.definition.instructions, definition.instructions);
        assert.deepEqual(input.definition.skills, [{ id: 'table-authoring', revision: '1' }]);
        started();
        await gate;
        return { kind: 'tool', text: 'Inspecting the requested resource.', call: { tool: 'schema.inspect', tableId } };
      });
      const input = {
        id: randomUUID(),
        activationId: activation.activationId,
        scope,
        prompt: 'Inspect synthetic resource',
      };
      const receipts = await Promise.all([
        chat.submit(workspaceId, 'admin', agentId, input),
        chat.submit(workspaceId, 'admin', agentId, input),
      ]);
      await soulFixture.save(workspaceId, actor, agentId, teamId, {
        ...definition,
        skills: [{ id: 'agent-authoring', revision: '1' }],
      });
      assert.deepEqual(receipts, [
        { id: input.id, revision: saved.revision, status: 'pending' },
        { id: input.id, revision: saved.revision, status: 'pending' },
      ]);
      const pending = await chat.read(workspaceId, 'admin', agentId, input.id);
      assert.deepEqual(
        { ...pending, model: undefined },
        {
          id: input.id,
          revision: saved.revision,
          status: 'pending',
          text: null,
          call: null,
          execution: null,
          model: undefined,
        },
      );
      assert.equal(pending.model.generation, 0);
      await assert.rejects(
        chat.submit(workspaceId, 'admin', agentId, { ...input, prompt: 'different' }),
        error => error.code === 'chat-identity-conflict',
      );
      const work = chat.processTurn(workspaceId, input.id);
      await entered;
      await chat.processTurn(workspaceId, input.id);
      assert.equal(calls, 1);
      const readerId = randomUUID();
      await owner.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'reader','member')`, [
        readerId,
      ]);
      await owner.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        readerId,
        teamId,
      ]);
      await owner.query(`INSERT INTO ${table('tf_agent_grants')} (team_id,agent_id,permission) VALUES ($1,$2,'read')`, [
        teamId,
        agentId,
      ]);
      assert.equal(
        (await createSavedAgentService(runtime, async () => definition).list(workspaceId, 'reader')).agents[0].id,
        agentId,
      );
      await assert.rejects(chat.submit(workspaceId, 'reader', agentId, { ...input, id: randomUUID() }), AccessDenied);
      await assert.rejects(chat.read(workspaceId, 'reader', agentId, input.id), AccessDenied);
      release();
      await work;
      const result = await chat.read(workspaceId, 'admin', agentId, input.id);
      assert.equal(result.status, 'answered');
      assert.equal(result.execution.status, 'completed');
      assert.equal(result.execution.result.name, 'Synthetic target');
      await chat.processTurn(workspaceId, input.id);
      assert.equal(calls, 1);
      await owner.query(`UPDATE ${table('tf_agent_chat_turns')} SET status='tool',attempts=5 WHERE id=$1`, [input.id]);
      await chat.processTurn(workspaceId, input.id);
      assert.equal((await chat.read(workspaceId, 'admin', agentId, input.id)).status, 'answered');
      assert.equal(calls, 1);
      const invalidQuery = createAgentChat(runtime, async () => ({
        kind: 'tool',
        text: 'Find records',
        call: {
          tool: 'rows.list',
          tableId,
          expectedAppliedRevision: appliedRevision,
          query: { filters: [{ fieldId: randomUUID(), op: 'eq', value: 'private-filter' }] },
        },
      }));
      const invalidInput = { ...input, id: randomUUID() };
      await invalidQuery.submit(workspaceId, 'admin', agentId, invalidInput);
      await invalidQuery.processTurn(workspaceId, invalidInput.id);
      const invalidResult = await invalidQuery.read(workspaceId, 'admin', agentId, invalidInput.id);
      assert.equal(invalidResult.status, 'failed');
      assert.deepEqual(invalidResult.execution, { status: 'failed', result: { code: 'tool-failed' } });
      assert.equal((await invalidQuery.pending(workspaceId)).includes(invalidInput.id), false);
      await invalidQuery.processTurn(workspaceId, invalidInput.id);
      assert.equal((await invalidQuery.read(workspaceId, 'admin', agentId, invalidInput.id)).status, 'failed');
      await owner.query(`UPDATE ${table('tf_agent_chat_turns')} SET status='tool',attempts=5 WHERE id=$1`, [input.id]);
      await owner.query(`UPDATE ${table('tf_agent_tool_calls')} SET status='pending',result=NULL WHERE run_id=$1`, [
        input.id,
      ]);
      await chat.processTurn(workspaceId, input.id);
      assert.equal(
        (await chat.read(workspaceId, 'admin', agentId, input.id)).execution.result.name,
        'Synthetic target',
      );
      assert.equal(calls, 1);
      const forbidden = createAgentChat(runtime, async () => ({
        kind: 'tool',
        text: 'Delete',
        call: { tool: 'rows.delete', tableId, recordId: randomUUID(), expectedAppliedRevision: appliedRevision },
      }));
      const hostile = { ...input, id: randomUUID() };
      await forbidden.submit(workspaceId, 'admin', agentId, hostile);
      await forbidden.processTurn(workspaceId, hostile.id);
      assert.equal((await forbidden.read(workspaceId, 'admin', agentId, hostile.id)).status, 'failed');
      assert.deepEqual(
        (await owner.query(`SELECT status FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`, [hostile.id])).rows,
        [],
      );
      const undeclared = createAgentChat(runtime, async () => ({
        kind: 'tool',
        text: 'Status',
        call: { tool: 'schema.status', tableId },
      }));
      const undeclaredInput = { ...input, id: randomUUID() };
      await undeclared.submit(workspaceId, 'admin', agentId, undeclaredInput);
      await undeclared.processTurn(workspaceId, undeclaredInput.id);
      assert.equal((await undeclared.read(workspaceId, 'admin', agentId, undeclaredInput.id)).status, 'failed');
      assert.equal(
        (
          await owner.query(`SELECT count(*)::integer AS count FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`, [
            undeclaredInput.id,
          ])
        ).rows[0].count,
        0,
      );
      const answer = createAgentChat(runtime, async () => ({ kind: 'answer', text: 'Synthetic answer.' }));
      const answerInput = { ...input, id: randomUUID() };
      await answer.submit(workspaceId, 'admin', agentId, answerInput);
      await answer.processTurn(workspaceId, answerInput.id);
      assert.equal((await answer.read(workspaceId, 'admin', agentId, answerInput.id)).text, 'Synthetic answer.');
      const cancelledInput = { ...input, id: randomUUID() };
      const cancelled = createAgentChat(runtime, async () => {
        await store.revoke(workspaceId, actor, { kind: 'run', id: cancelledInput.id });
        return { kind: 'tool', text: 'Inspect', call: { tool: 'schema.inspect', tableId } };
      });
      await cancelled.submit(workspaceId, 'admin', agentId, cancelledInput);
      await cancelled.processTurn(workspaceId, cancelledInput.id);
      assert.deepEqual((await cancelled.read(workspaceId, 'admin', agentId, cancelledInput.id)).execution, {
        status: 'blocked',
        result: null,
      });
      assert.equal(
        (
          await owner.query(`SELECT count(*)::integer AS count FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`, [
            cancelledInput.id,
          ])
        ).rows[0].count,
        0,
      );
      const revokedInput = { ...input, id: randomUUID() };
      const revoked = createAgentChat(runtime, async () => {
        await store.revoke(workspaceId, actor, { kind: 'activation', id: activation.activationId });
        return { kind: 'tool', text: 'Inspect', call: { tool: 'schema.inspect', tableId } };
      });
      await revoked.submit(workspaceId, 'admin', agentId, revokedInput);
      await revoked.processTurn(workspaceId, revokedInput.id);
      assert.deepEqual((await revoked.read(workspaceId, 'admin', agentId, revokedInput.id)).execution, {
        status: 'blocked',
        result: null,
      });
      assert.equal(
        (
          await owner.query(`SELECT count(*)::integer AS count FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`, [
            revokedInput.id,
          ])
        ).rows[0].count,
        0,
      );
      const concealed = await chat.read(workspaceId, 'admin', agentId, input.id);
      assert.equal(concealed.text, null);
      assert.equal(concealed.call, null);
      assert.deepEqual(concealed.execution, { status: 'blocked', result: null });
      await owner.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [membershipId]);
      await owner.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'admin','admin')`, [
        randomUUID(),
      ]);
      await assert.rejects(chat.read(workspaceId, 'admin', agentId, input.id), AccessDenied);
      await assert.rejects(
        createAgentChat(runtime, null).submit(workspaceId, 'admin', agentId, { ...input, id: randomUUID() }),
        error => error.code === 'model-not-configured',
      );
    } finally {
      await runtime?.close();
      await owner.end();
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (names)
        for (const role of [names.runtime, names.migration, names.confirmation, names.customOwner])
          await admin.query(`DROP ROLE "${role}"`);
      await admin.end();
      await soulFixture?.close();
    }
  },
);
