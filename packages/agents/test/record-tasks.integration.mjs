import assert from 'node:assert/strict';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { createGeneration, activateGeneration, writeGenerationRecord } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { savedTaskAgent } from './task-fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskApprovals, createTaskApprovalDecision } from '../src/task-approvals.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { createAgentRecordTools } from '../src/record-tools.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createAgentChat } from '../src/chat.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { modelNativeTools } from '../src/model.ts';
import { readableTableFiles } from '../src/table-sources.ts';
import { commonCompatibility } from '@tulipfarm/workspaces/storage';

test('named-agent task records preserve exact protected approval with typed records', { timeout: 120000 }, async t => {
  const db = await fixture();
  let runtime, migration;
  t.after(async () => {
    await migration?.end();
    await runtime?.close();
    await db.close();
  });
  await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
  for (const name of ['0001_baseline.sql'])
    await db.platform.query(
      await readFile(new URL(`../../../apps/database/migrations/${name}`, import.meta.url), 'utf8'),
    );
  const stream = await workspaceTableMigrations();
  assert.equal(stream.length, commonCompatibility.maximum);
  const w = await db.create(stream),
    table = name => `"${w.names.schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  migration = await connect(db.login(w, 'migration'));
  const maintenance = operation =>
    inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      return operation({ client, schema: w.names.schema });
    });
  const user = randomUUID(),
    member = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
    member,
    user,
  ]);
  const tools = [
    'tables.list',
    'schema.inspect',
    'schema.status',
    'rows.list',
    'rows.get',
    'rows.create',
    'rows.update',
    'rows.delete',
  ];
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], tools);
  const owner = { kind: 'human', userId: user, membershipId: member };
  const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const permissions = ['table.row.read', 'table.row.create', 'table.row.update', 'table.row.delete'];
  const tableId = randomUUID(),
    fieldId = randomUUID(),
    fileField = randomUUID(),
    numericField = randomUUID(),
    optionField = randomUUID(),
    optionId = randomUUID(),
    dateField = randomUUID();
  const booleanField = randomUUID(),
    calendarField = randomUUID(),
    tagsField = randomUUID(),
    relationshipField = randomUUID();
  const revision = 'a'.repeat(40);
  const definition = {
    formatVersion: 2,
    id: tableId,
    owningTeamId: agent.teamId,
    label: 'Typed contacts',
    fields: [
      { id: fieldId, label: 'Name', kind: 'text', required: false, maxLength: 10000 },
      { id: fileField, label: 'Files', kind: 'file', required: false, cardinality: 'many', access: 'independent' },
      { id: numericField, label: 'Amount', kind: 'numeric', required: false, precision: 12, scale: 2 },
      {
        id: optionField,
        label: 'State',
        kind: 'single-select',
        required: false,
        options: [{ id: optionId, label: 'Open', retired: false }],
      },
      { id: dateField, label: 'Time', kind: 'timestamp', required: false, timezone: 'UTC' },
      { id: booleanField, label: 'Enabled', kind: 'boolean', required: false },
      { id: calendarField, label: 'Date', kind: 'date', required: false },
      {
        id: tagsField,
        label: 'Tags',
        kind: 'multi-select',
        required: false,
        options: [{ id: optionId, label: 'Open', retired: false }],
      },
      {
        id: relationshipField,
        label: 'Related',
        kind: 'relationship',
        required: false,
        targetTableId: tableId,
        cardinality: 'many',
        inverseCardinality: 'many',
        reverse: null,
        onDelete: 'restrict',
      },
    ],
    uniqueKeys: [],
  };
  const activate = async (target, rev, previous = null, rows = []) =>
    maintenance(async tx => {
      const generation = await createGeneration(tx, { definition: target, revision: rev });
      for (const record of rows)
        await writeGenerationRecord(tx, {
          generationId: generation.id,
          recordId: record.id,
          token: record.token,
          values: record.values,
        });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: previous });
      await tx.client.query(
        `UPDATE ${table('tf_table_catalog')} SET applied_revision=$2,target_revision=$2,applied_definition=$3,physical_table=$4 WHERE id=$1`,
        [target.id, rev, target, generation.physical_table],
      );
      return generation;
    });
  let generation = await activate(definition, revision);
  const scope = [{ assetId: tableId, permissions }];
  let policyVersion = 0;
  const configure = async () => {
    for (const entry of scope)
      for (const permission of permissions)
        await db.platform.query(
          `INSERT INTO ${table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [agent.teamId, entry.assetId, permission],
        );
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
      agent.activationId,
      JSON.stringify(scope),
    ]);
    await createAgentExecutor({ runtime }).configure(w.id, admin, {
      agentId: agent.agentId,
      version: policyVersion++,
      enabled: true,
      teamIds: [agent.teamId],
      limits: scope,
    });
  };
  await configure();
  const tableService = createTableService(
    runtime,
    {
      readableFiles: (tx, actor, ids) => {
        assert.equal(actor.kind, 'human');
        return readableTableFiles(tx, actor, ids);
      },
    },
    executionCompatibility,
  );
  const records = createAgentRecordTools(runtime),
    tasks = createAgentTasks(runtime),
    approvals = createTaskApprovals(runtime),
    executor = createAgentExecutor({ runtime });
  const decide = createTaskApprovalDecision({
    runtime,
    resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
  });
  const recordId = randomUUID();
  await tableService.mutate(w.id, user, {
    kind: 'create',
    tableId,
    revision,
    recordId,
    values: { [fieldId]: { kind: 'text', value: ' alice ' } },
  });
  const read = () => tableService.read(w.id, user, { tableId, revision, recordId });
  const update = values => ({ tool: 'rows.update', tableId, expectedAppliedRevision: revision, recordId, values });
  const start = async (calls, selectedScope = scope) => {
    const task = await tasks.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Exact changes',
      scope: selectedScope,
    });
    const read = call =>
      tableService.read(w.id, user, {
        tableId: call.tableId,
        revision: call.expectedAppliedRevision,
        recordId: call.recordId,
      });
    const proposal = await approvals.propose(w.id, user, task.id, {
      requestId: randomUUID(),
      generation: 0,
      calls: await Promise.all(
        calls.map(async call =>
          call.tool === 'rows.create' ? call : { ...call, expectedToken: (await read(call)).token },
        ),
      ),
    });
    return {
      task,
      proposal,
      execute: () => executor.execute({ workspaceId: w.id, runId: proposal.runId, callId: proposal.actions[0].id }),
      approve: () => decide(w.id, user, task.id, proposal.id, { digest: proposal.digest, decision: 'approve' }),
    };
  };
  const route = {
    id: 'record-task-test',
    modelId: 'claude-opus-5-5',
    provider: 'anthropic',
    deployment: 'claude-opus-5-5',
    location: 'test',
    adapterVersion: 1,
    qualification: 'scripted local protocol',
    lifecycle: 'current',
    maxInputTokens: 100000,
    maxOutputTokens: 4096,
    boundedDecision: true,
  };
  const bundle = modelBundleSchema.parse({
    format: 1,
    id: 'record-task-test',
    mapping: {
      ...initialModelMapping,
      revision: 'record-task-test',
      families: initialModelMapping.families.filter(f => f.id === 'claude-opus'),
    },
    models: initialBundleModels,
    routes: [route],
  });
  async function taskJourney(id, field, rev, expected) {
    const decisions = [];
    const model = {
      activeBundle: () => ({ bundle, activationRevision: 1 }),
      restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
      trustedBundle: () => bundle,
      allowed: () => true,
      actualModelIds: () => [route.modelId],
      health: createModelRouteHealth(db.platform, () => 'record-task-test'),
      budgetPicoUsd: () => '10000000000000',
      legacyFamily: () => 'claude-opus',
      infer: async (_resolution, input) => {
        const context = JSON.parse(input.prompt);
        let decision;
        if (!context.results.length)
          decision = { kind: 'tool', text: 'Inspect schema', call: { tool: 'schema.inspect', tableId: id } };
        else if (context.results.length === 1) {
          assert.equal(context.results[0].result.appliedDefinition.formatVersion, 2);
          decision = {
            kind: 'tool',
            text: 'Read record',
            call: { tool: 'rows.get', tableId: id, expectedAppliedRevision: rev, recordId: expected.id },
          };
        } else if (!context.results.some(r => r.call.tool === 'rows.update')) {
          assert.deepEqual(context.results[1].result.values[field], { kind: 'text', value: expected.before });
          decision = {
            kind: 'propose',
            text: 'Review exact update',
            calls: [
              {
                tool: 'rows.update',
                tableId: id,
                expectedAppliedRevision: rev,
                recordId: expected.id,
                expectedToken: context.results[1].result.token,
                values: { [field]: { kind: 'text', value: expected.after } },
              },
            ],
          };
        } else {
          assert.equal(context.results.at(-1).status, 'completed');
          assert.deepEqual(context.results.at(-1).result.values[field], { kind: 'text', value: expected.after });
          decision = { kind: 'answer', text: 'Approved update completed.' };
        }
        decisions.push(decision.kind);
        return {
          kind: 'success',
          decision,
          actualModel: route.modelId,
          requestId: randomUUID(),
          usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        };
      },
    };
    const engine = createTaskRuntime(runtime, model);
    const task = await tasks.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Read then update',
      scope,
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
    });
    for (let n = 0; n < 8 && (await tasks.read(w.id, user, task.id)).status === 'pending'; n++)
      await engine.process(w.id, task.id);
    assert.equal((await tasks.read(w.id, user, task.id)).status, 'waiting-approval');
    const [summary] = (await approvals.list(w.id, user, task.id)).proposals;
    const proposal = await approvals.read(w.id, user, task.id, summary.id);
    const token = (await tableService.read(w.id, user, { tableId: id, revision: rev, recordId: expected.id })).token;
    assert.deepEqual(proposal.actions[0].call, {
      tool: 'rows.update',
      tableId: id,
      expectedAppliedRevision: rev,
      recordId: expected.id,
      expectedToken: token,
      values: { [field]: { kind: 'text', value: expected.after } },
    });
    assert.equal(proposal.actions[0].token, token);
    await engine.process(w.id, task.id);
    assert.equal(
      (await tableService.read(w.id, user, { tableId: id, revision: rev, recordId: expected.id })).values[field].value,
      expected.before,
    );
    await decide(w.id, user, task.id, proposal.id, { digest: proposal.digest, decision: 'approve' });
    for (let n = 0; n < 6 && (await tasks.read(w.id, user, task.id)).status !== 'completed'; n++)
      await engine.process(w.id, task.id);
    assert.equal((await tasks.read(w.id, user, task.id)).status, 'completed');
    assert.deepEqual(decisions, ['tool', 'tool', 'propose', 'answer']);
    assert.equal((await tasks.read(w.id, user, task.id)).toolCalls, 3);
    return proposal;
  }
  await t.test('selected model contract and actual task runtime read then approved update', async () => {
    const schema = JSON.stringify(
      modelNativeTools({
        prompt: 'Read then update',
        definition: { name: 'Agent', instructions: 'Do work.', tools: ['rows.get', 'rows.update'] },
        scope: [],
        task: true,
      }).tools,
    );
    assert.ok(schema.includes('fileIds') && schema.includes('optionId') && schema.includes('timestamp'));
    assert.ok(!schema.includes('"rows.create"') && !schema.includes('"schema.save"'));
    await taskJourney(tableId, fieldId, revision, { id: recordId, before: ' alice ', after: 'Alice' });
  });
  await t.test(
    'a person edit between the task agent read and its proposal returns a conflict the agent re-reads from',
    async () => {
      const id = randomUUID(),
        contexts = [];
      await tableService.mutate(w.id, user, {
        kind: 'create',
        tableId,
        revision,
        recordId: id,
        values: { [fieldId]: { kind: 'text', value: 'Original' } },
      });
      const get = { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId: id };
      const change = row => ({
        tool: 'rows.update',
        tableId,
        expectedAppliedRevision: revision,
        recordId: id,
        expectedToken: row.token,
        values: { [fieldId]: { kind: 'text', value: `${row.values[fieldId].value} (checked)` } },
      });
      let stale;
      const model = {
        activeBundle: () => ({ bundle, activationRevision: 1 }),
        restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
        trustedBundle: () => bundle,
        allowed: () => true,
        actualModelIds: () => [route.modelId],
        health: createModelRouteHealth(db.platform, () => 'record-task-test'),
        budgetPicoUsd: () => '10000000000000',
        legacyFamily: () => 'claude-opus',
        infer: async (_resolution, input) => {
          const { results } = JSON.parse(input.prompt);
          contexts.push(results);
          let decision;
          if (results.length === 0 || results.length === 2)
            decision = { kind: 'tool', text: 'Read the row', call: get };
          else if (results.length === 1) {
            const person = await tableService.read(w.id, user, { tableId, revision, recordId: id });
            await tableService.mutate(w.id, user, {
              kind: 'update',
              tableId,
              revision,
              recordId: id,
              expectedToken: person.token,
              values: { [fieldId]: { kind: 'text', value: 'Person edit' } },
            });
            stale = change(results[0].result);
            decision = { kind: 'propose', text: 'Review the checked name', calls: [stale] };
          } else if (results.length === 3)
            decision = { kind: 'propose', text: 'Review the checked name', calls: [change(results[2].result)] };
          else decision = { kind: 'answer', text: 'The checked name was saved.' };
          return {
            kind: 'success',
            decision,
            actualModel: route.modelId,
            requestId: randomUUID(),
            usage: {
              kind: 'known',
              input: 10,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
          };
        },
      };
      const engine = createTaskRuntime(runtime, model);
      const task = await tasks.start(w.id, user, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        text: 'Mark the name checked',
        scope,
        limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
      });
      for (let n = 0; n < 10 && (await tasks.read(w.id, user, task.id)).status === 'pending'; n++)
        await engine.process(w.id, task.id);
      assert.equal((await tasks.read(w.id, user, task.id)).status, 'waiting-approval');
      assert.deepEqual(contexts[2][1], {
        call: stale,
        status: 'failed',
        result: {
          error: 'record-conflict',
          instruction:
            'The row changed after your last read or no read token was supplied. Read it again with rows.get, then retry with the new token.',
        },
      });
      const current = await tableService.read(w.id, user, { tableId, revision, recordId: id });
      const { proposals } = await approvals.list(w.id, user, task.id);
      assert.equal(proposals.length, 1);
      const proposal = await approvals.read(w.id, user, task.id, proposals[0].id);
      assert.deepEqual(proposal.actions[0].call, {
        tool: 'rows.update',
        tableId,
        expectedAppliedRevision: revision,
        recordId: id,
        expectedToken: current.token,
        values: { [fieldId]: { kind: 'text', value: 'Person edit (checked)' } },
      });
      assert.equal(proposal.actions[0].token, current.token);
      assert.deepEqual(proposal.actions[0].before.values[fieldId], { kind: 'text', value: 'Person edit' });
      await decide(w.id, user, task.id, proposal.id, { digest: proposal.digest, decision: 'approve' });
      for (let n = 0; n < 6 && (await tasks.read(w.id, user, task.id)).status !== 'completed'; n++)
        await engine.process(w.id, task.id);
      assert.equal((await tasks.read(w.id, user, task.id)).status, 'completed');
      assert.equal(
        (await tableService.read(w.id, user, { tableId, revision, recordId: id })).values[fieldId].value,
        'Person edit (checked)',
      );
      await tableService.mutate(w.id, user, {
        kind: 'delete',
        tableId,
        revision,
        recordId: id,
        expectedToken: (await tableService.read(w.id, user, { tableId, revision, recordId: id })).token,
      });
    },
  );
  await t.test('registry discovery and bounded record list retain filters, count and cursor', async () => {
    const run = await executor.startDelegated(w.id, owner, { activationId: agent.activationId, scope });
    const actor = { kind: 'agent', runId: run.runId };
    assert.equal((await records.list(w.id, actor)).tables[0].appliedDefinition.formatVersion, 2);
    const page = await records.listRecords(w.id, actor, tableId, revision, {
      filters: [{ fieldId, op: 'eq', value: 'Alice' }],
      limit: 1,
    });
    assert.equal(page.total, '1');
    assert.equal(page.nextCursor, null);
    assert.equal(page.records[0].id, recordId);
    assert.equal((await records.listRecords(w.id, actor, tableId, revision, { after: recordId })).records.length, 0);
    await assert.rejects(records.listRecords(w.id, actor, tableId, revision, { limit: 101 }));
    const callId = randomUUID(),
      id = randomUUID();
    await executor.queueCall(w.id, owner, {
      runId: run.runId,
      callId,
      sequence: 0,
      call: {
        tool: 'rows.create',
        tableId,
        expectedAppliedRevision: revision,
        values: { [fieldId]: { kind: 'text', value: 'Delegated' } },
      },
    });
    assert.equal(await executor.execute({ workspaceId: w.id, runId: run.runId, callId }), 'completed');
    assert.equal((await records.getRecord(w.id, user, tableId, revision, callId)).values[fieldId].value, 'Delegated');
    await records.createRecord(w.id, actor, tableId, revision, { [fieldId]: { kind: 'text', value: 'Direct' } }, id);
    const updated = await records.updateRecord(
      w.id,
      actor,
      tableId,
      revision,
      id,
      { [fieldId]: { kind: 'text', value: 'Updated' } },
      (await records.getRecord(w.id, actor, tableId, revision, id)).token,
    );
    assert.equal((await records.getRecord(w.id, actor, tableId, revision, id)).values[fieldId].value, 'Updated');
    await records.deleteRecord(w.id, actor, tableId, revision, id, updated.token);
    await records.deleteRecord(
      w.id,
      actor,
      tableId,
      revision,
      callId,
      (await records.getRecord(w.id, actor, tableId, revision, callId)).token,
    );
  });
  await t.test(
    'delegated agent writes use the token from the agent read and conflict after a person edit',
    async () => {
      const call = async value => {
        const run = await executor.startDelegated(w.id, owner, { activationId: agent.activationId, scope }),
          callId = randomUUID();
        await executor.queueCall(w.id, owner, { runId: run.runId, callId, sequence: 0, call: value });
        const status = await executor.execute({ workspaceId: w.id, runId: run.runId, callId });
        return {
          status,
          result: (await executor.readResult({ workspaceId: w.id, runId: run.runId, callId }, owner)).result,
        };
      };
      const id = randomUUID();
      await tableService.mutate(w.id, user, {
        kind: 'create',
        tableId,
        revision,
        recordId: id,
        values: { [fieldId]: { kind: 'text', value: 'Original' } },
      });
      const seen = await call({ tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId: id });
      assert.equal(seen.result.token, (await tableService.read(w.id, user, { tableId, revision, recordId: id })).token);
      const listed = await call({
        tool: 'rows.list',
        tableId,
        expectedAppliedRevision: revision,
        query: { filters: [{ fieldId, op: 'eq', value: 'Original' }] },
      });
      assert.equal(listed.result.records[0].token, seen.result.token);
      const person = await tableService.read(w.id, user, { tableId, revision, recordId: id });
      await tableService.mutate(w.id, user, {
        kind: 'update',
        tableId,
        revision,
        recordId: id,
        expectedToken: person.token,
        values: { [fieldId]: { kind: 'text', value: 'Person edit' } },
      });
      const conflict = {
        error: 'record-conflict',
        instruction:
          'The row changed after your last read or no read token was supplied. Read it again with rows.get, then retry with the new token.',
      };
      assert.deepEqual(
        await call({
          tool: 'rows.update',
          tableId,
          expectedAppliedRevision: revision,
          recordId: id,
          expectedToken: seen.result.token,
          values: { [fieldId]: { kind: 'text', value: 'Agent edit' } },
        }),
        { status: 'failed', result: conflict },
      );
      assert.deepEqual(
        await call({
          tool: 'rows.delete',
          tableId,
          expectedAppliedRevision: revision,
          recordId: id,
          expectedToken: seen.result.token,
        }),
        { status: 'failed', result: conflict },
      );
      assert.deepEqual(
        await call({
          tool: 'rows.update',
          tableId,
          expectedAppliedRevision: revision,
          recordId: id,
          values: { [fieldId]: { kind: 'text', value: 'Blind edit' } },
        }),
        { status: 'failed', result: conflict },
      );
      assert.equal(
        (await tableService.read(w.id, user, { tableId, revision, recordId: id })).values[fieldId].value,
        'Person edit',
      );
      const reread = await call({ tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId: id });
      const updated = await call({
        tool: 'rows.update',
        tableId,
        expectedAppliedRevision: revision,
        recordId: id,
        expectedToken: reread.result.token,
        values: { [fieldId]: { kind: 'text', value: 'Agent edit' } },
      });
      assert.equal(updated.status, 'completed');
      assert.equal(updated.result.values[fieldId].value, 'Agent edit');
      assert.deepEqual(
        await call({
          tool: 'rows.delete',
          tableId,
          expectedAppliedRevision: revision,
          recordId: id,
          expectedToken: updated.result.token,
        }),
        { status: 'completed', result: true },
      );
      assert.equal(await tableService.read(w.id, user, { tableId, revision, recordId: id }), null);
      const existing = randomUUID();
      await tableService.mutate(w.id, user, {
        kind: 'create',
        tableId,
        revision,
        recordId: existing,
        values: { [fieldId]: { kind: 'text', value: 'Existing' } },
      });
      const run = await executor.startDelegated(w.id, owner, { activationId: agent.activationId, scope });
      await executor.queueCall(w.id, owner, {
        runId: run.runId,
        callId: existing,
        sequence: 0,
        call: {
          tool: 'rows.create',
          tableId,
          expectedAppliedRevision: revision,
          values: { [fieldId]: { kind: 'text', value: 'Duplicate' } },
        },
      });
      const failures = [];
      const write = process.stdout.write.bind(process.stdout);
      t.mock.method(process.stdout, 'write', (line, ...rest) => {
        if (String(line).includes('"call_failed"')) failures.push(JSON.parse(line));
        return write(line, ...rest);
      });
      try {
        assert.equal(await executor.execute({ workspaceId: w.id, runId: run.runId, callId: existing }), 'failed');
      } finally {
        t.mock.restoreAll();
      }
      const toolFailures = failures.filter(line => line.category === 'tool');
      assert.equal(toolFailures.length, 1);
      assert.equal(toolFailures[0].tool, 'rows.create');
      assert.equal(toolFailures[0].outcome, 'error');
      assert.equal(typeof toolFailures[0].duration_ms, 'number');
      assert.match(toolFailures[0]['error.type'], /^[A-Za-z0-9]/);
      assert.deepEqual(
        (await executor.readResult({ workspaceId: w.id, runId: run.runId, callId: existing }, owner)).result,
        { code: 'tool-failed' },
      );
      await tableService.mutate(w.id, user, {
        kind: 'delete',
        tableId,
        revision,
        recordId: existing,
        expectedToken: (await tableService.read(w.id, user, { tableId, revision, recordId: existing })).token,
      });
    },
  );
  await t.test('chat turns read rows before direct updates or deletes and re-read after a person edit', async () => {
    const offered = [];
    for (const kind of ['update', 'delete']) {
      const id = randomUUID();
      await tableService.mutate(w.id, user, {
        kind: 'create',
        tableId,
        revision,
        recordId: id,
        values: { [fieldId]: { kind: 'text', value: 'Chat original' } },
      });
      const chat = createAgentChat(runtime, {
        activeBundle: () => ({ bundle, activationRevision: 1 }),
        restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
        trustedBundle: () => bundle,
        allowed: () => true,
        actualModelIds: () => [route.modelId],
        health: createModelRouteHealth(db.platform, () => 'record-task-test'),
        budgetPicoUsd: () => '10000000000000',
        legacyFamily: () => 'claude-opus',
        infer: async (_resolution, input) => {
          offered.push(input.definition.tools);
          const results = input.prompt.startsWith('{') ? JSON.parse(input.prompt).results : [];
          let call;
          if (!results.length) call = { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId: id };
          else if (kind === 'update' && results.length === 1) {
            const person = await tableService.read(w.id, user, { tableId, revision, recordId: id });
            await tableService.mutate(w.id, user, {
              kind: 'update',
              tableId,
              revision,
              recordId: id,
              expectedToken: person.token,
              values: { [fieldId]: { kind: 'text', value: 'Person edit' } },
            });
            call = {
              tool: 'rows.update',
              tableId,
              expectedAppliedRevision: revision,
              recordId: id,
              expectedToken: results[0].result.token,
              values: { [fieldId]: { kind: 'text', value: 'Chat edit' } },
            };
          } else if (kind === 'update' && results.length === 2) {
            assert.deepEqual(results[1].result, {
              error: 'record-conflict',
              instruction:
                'The row changed after your last read or no read token was supplied. Read it again with rows.get, then retry with the new token.',
            });
            call = { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId: id };
          } else if (kind === 'update')
            call = {
              tool: 'rows.update',
              tableId,
              expectedAppliedRevision: revision,
              recordId: id,
              expectedToken: results[2].result.token,
              values: { [fieldId]: { kind: 'text', value: 'Chat edit' } },
            };
          else
            call = {
              tool: 'rows.delete',
              tableId,
              expectedAppliedRevision: revision,
              recordId: id,
              expectedToken: results[0].result.token,
            };
          return {
            kind: 'success',
            decision: { kind: 'tool', text: 'Change the row', call },
            actualModel: route.modelId,
            requestId: randomUUID(),
            usage: {
              kind: 'known',
              input: 10,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
          };
        },
      });
      const turn = { id: randomUUID(), activationId: agent.activationId, scope, prompt: 'Change the row' };
      await chat.submit(w.id, user, agent.agentId, turn);
      for (let n = 0; n < 6 && (await chat.read(w.id, user, agent.agentId, turn.id)).status === 'pending'; n++)
        await chat.processTurn(w.id, turn.id);
      assert.equal((await chat.read(w.id, user, agent.agentId, turn.id)).status, 'answered');
      assert.equal(
        (
          await db.platform.query(`SELECT count(*)::int AS n FROM ${table('tf_agent_tool_calls')} WHERE run_id=$1`, [
            turn.id,
          ])
        ).rows[0].n,
        kind === 'update' ? 4 : 2,
      );
      const current = await tableService.read(w.id, user, { tableId, revision, recordId: id });
      if (kind === 'update') assert.equal(current.values[fieldId].value, 'Chat edit');
      else assert.equal(current, null);
    }
    assert.ok(offered.every(value => JSON.stringify(value) === JSON.stringify(tools)));
  });
  await t.test('protected approval, single-use admission, exact typed values and create/delete', async () => {
    const item = await start([
      update({
        [numericField]: { kind: 'numeric', value: '12.5' },
        [optionField]: { kind: 'single-select', optionId },
        [dateField]: { kind: 'timestamp', value: '2026-10-01T12:30:00+05:30' },
        [booleanField]: { kind: 'boolean', value: true },
        [calendarField]: { kind: 'date', value: '2026-10-02' },
        [tagsField]: { kind: 'multi-select', optionIds: [optionId] },
        [relationshipField]: { kind: 'relationship', tableId, recordIds: [recordId] },
      }),
    ]);
    assert.equal(item.proposal.actions[0].after.values[numericField].value, '12.50');
    assert.equal(await item.execute(), 'waiting');
    const raw = await connect(db.login(w));
    try {
      await denied(
        raw,
        `INSERT INTO ${table('tf_agent_task_decisions')}(proposal_id,digest,membership_id,decision) VALUES($1,$2,$3,'approve')`,
        [item.proposal.id, item.proposal.digest, member],
      );
    } finally {
      await raw.end();
    }
    await assert.rejects(
      decide(w.id, w.userId, item.task.id, item.proposal.id, { digest: item.proposal.digest, decision: 'approve' }),
      AccessDenied,
    );
    await assert.rejects(
      decide(w.id, user, item.task.id, item.proposal.id, { digest: 'f'.repeat(64), decision: 'approve' }),
      e => e.code === 'proposal-conflict',
    );
    const actor = { kind: 'agent', runId: item.proposal.runId };
    await assert.rejects(
      records.updateRecord(
        w.id,
        actor,
        tableId,
        revision,
        recordId,
        item.proposal.actions[0].call.values,
        item.proposal.actions[0].token,
      ),
      AccessDenied,
    );
    await item.approve();
    await assert.rejects(
      createAgentRecordTools(runtime, {}).updateRecord(
        w.id,
        actor,
        tableId,
        revision,
        recordId,
        item.proposal.actions[0].call.values,
        item.proposal.actions[0].token,
      ),
      AccessDenied,
    );
    const outcomes = await Promise.all([item.execute(), item.execute()]);
    assert.ok(outcomes.includes('completed') && outcomes.every(value => ['completed', 'waiting'].includes(value)));
    assert.equal(await item.execute(), 'completed');
    assert.deepEqual({ id: recordId, values: (await read()).values }, item.proposal.actions[0].after);
    const created = await start([
      {
        tool: 'rows.create',
        tableId,
        expectedAppliedRevision: revision,
        values: { [fieldId]: { kind: 'text', value: 'New' } },
      },
    ]);
    await created.approve();
    assert.equal(await created.execute(), 'completed');
    const id = created.proposal.actions[0].recordId;
    const { token: _, ...createdRecord } = await records.getRecord(w.id, user, tableId, revision, id);
    assert.deepEqual(createdRecord, created.proposal.actions[0].after);
    const deleted = await start([{ tool: 'rows.delete', tableId, expectedAppliedRevision: revision, recordId: id }]);
    await deleted.approve();
    assert.equal(await deleted.execute(), 'completed');
    assert.equal(await records.getRecord(w.id, user, tableId, revision, id), null);
  });
  await t.test('same-value writes invalidate exact tokens before and after approval', async () => {
    for (const approved of [false, true]) {
      const item = await start([update({ [fieldId]: { kind: 'text', value: 'Must not write' } })]);
      if (approved) await item.approve();
      const current = await read();
      await tableService.mutate(w.id, user, {
        kind: 'update',
        tableId,
        revision,
        recordId,
        expectedToken: current.token,
        values: { [fieldId]: current.values[fieldId] },
      });
      if (approved) assert.equal(await item.execute(), 'failed');
      else await assert.rejects(item.approve(), e => e.code === 'stale-proposal');
      assert.equal((await read()).values[fieldId].value, 'Alice');
      const refreshed = await approvals.recover(w.id, user, item.task.id, item.proposal.id, {
        requestId: randomUUID(),
        generation: 0,
      });
      assert.equal(refreshed.status.decision, null);
      assert.notEqual(refreshed.actions[0].token, item.proposal.actions[0].token);
      const token = (await read()).token;
      assert.deepEqual([refreshed.actions[0].call.expectedToken, refreshed.actions[0].token], [token, token]);
    }
  });
  await t.test('a proposal stored without a read token still writes with its pinned token', async () => {
    const item = await start([update({ [fieldId]: { kind: 'text', value: 'Legacy' } })]);
    const { expectedToken: _, ...legacy } = item.proposal.actions[0].call;
    await db.platform.query(
      `UPDATE ${table('tf_agent_task_proposals')} SET actions=jsonb_set(actions,'{0,call}',$2::jsonb) WHERE id=$1`,
      [item.proposal.id, JSON.stringify(legacy)],
    );
    await db.platform.query(`UPDATE ${table('tf_agent_tool_calls')} SET call=$2::jsonb WHERE id=$1`, [
      item.proposal.actions[0].id,
      JSON.stringify(legacy),
    ]);
    await item.approve();
    assert.equal(await item.execute(), 'completed');
    const current = await read();
    assert.equal(current.values[fieldId].value, 'Legacy');
    await tableService.mutate(w.id, user, {
      kind: 'update',
      tableId,
      revision,
      recordId,
      expectedToken: current.token,
      values: { [fieldId]: { kind: 'text', value: 'Alice' } },
    });
  });
  await t.test('a fault after mutation rolls back the record, token, history and completed receipt', async () => {
    const item = await start([update({ [fieldId]: { kind: 'text', value: 'Rollback' } })]);
    await item.approve();
    const before = await read();
    const history = (
      await db.platform.query(
        `SELECT count(*)::int AS n FROM ${table('tf_table_row_history')} WHERE table_id=$1 AND row_id=$2`,
        [tableId, recordId],
      )
    ).rows[0].n;
    const faulty = createAgentExecutor({
      runtime,
      internalActivity: async tx => {
        if (
          (
            await tx.client.query(
              `SELECT 1 FROM ${table('tf_agent_task_action_receipts')} WHERE call_id=$1 AND status='completed'`,
              [item.proposal.actions[0].id],
            )
          ).rowCount
        )
          throw new Error('injected-post-write-fault');
      },
    });
    await assert.rejects(
      faulty.execute({ workspaceId: w.id, runId: item.proposal.runId, callId: item.proposal.actions[0].id }),
      /Agent tool execution unavailable/,
    );
    assert.deepEqual(await read(), before);
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::int AS n FROM ${table('tf_table_row_history')} WHERE table_id=$1 AND row_id=$2`,
          [tableId, recordId],
        )
      ).rows[0].n,
      history,
    );
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::int AS n FROM ${table('tf_agent_task_action_receipts')} WHERE call_id=$1 AND status='completed'`,
          [item.proposal.actions[0].id],
        )
      ).rows[0].n,
      0,
    );
  });
  await t.test('current human, agent team, run scope and limits remain intersected', async () => {
    const item = await start([update({ [fieldId]: { kind: 'text', value: 'Denied' } })]);
    await item.approve();
    await db.platform.query(`DELETE FROM ${table('tf_agent_teams')} WHERE agent_id=$1`, [agent.agentId]);
    assert.equal(await item.execute(), 'blocked');
    await db.platform.query(`INSERT INTO ${table('tf_agent_teams')}(agent_id,team_id) VALUES($1,$2)`, [
      agent.agentId,
      agent.teamId,
    ]);
    const human = await start([update({ [fieldId]: { kind: 'text', value: 'Denied' } })]);
    await human.approve();
    await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1`, [member]);
    assert.equal(await human.execute(), 'blocked');
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
      member,
      agent.teamId,
    ]);
    await assert.rejects(
      start(
        [update({ [fieldId]: { kind: 'text', value: 'Denied' } })],
        [{ assetId: tableId, permissions: ['table.row.read'] }],
      ),
      AccessDenied,
    );
    const limited = await start([update({ [fieldId]: { kind: 'text', value: 'Denied' } })]);
    await limited.approve();
    await db.platform.query(`UPDATE ${table('tf_agent_limits')} SET scope=$2 WHERE agent_id=$1`, [
      agent.agentId,
      JSON.stringify([{ assetId: tableId, permissions: ['table.row.read'] }]),
    ]);
    assert.equal(await limited.execute(), 'blocked');
    await db.platform.query(`UPDATE ${table('tf_agent_limits')} SET scope=$2 WHERE agent_id=$1`, [
      agent.agentId,
      JSON.stringify(scope),
    ]);
    assert.equal((await read()).values[fieldId].value, 'Alice');
  });
  await t.test('activation revocation, task tool budgets and persisted payload tampering block writes', async () => {
    const revoked = await start([update({ [fieldId]: { kind: 'text', value: 'Denied' } })]);
    await revoked.approve();
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=clock_timestamp() WHERE id=$1`, [
      agent.activationId,
    ]);
    assert.equal(await revoked.execute(), 'blocked');
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=NULL WHERE id=$1`, [
      agent.activationId,
    ]);
    const limited = await start([update({ [fieldId]: { kind: 'text', value: 'Denied' } })]);
    await limited.approve();
    await db.platform.query(
      `UPDATE ${table('tf_agent_tasks')} SET tool_calls=(limits->>'toolCalls')::integer WHERE id=$1`,
      [limited.task.id],
    );
    assert.equal(await limited.execute(), 'waiting');
    assert.equal((await tasks.read(w.id, user, limited.task.id)).status, 'paused');
    const tampered = await start([update({ [fieldId]: { kind: 'text', value: 'Reviewed' } })]);
    await tampered.approve();
    await db.platform.query(`UPDATE ${table('tf_agent_tool_calls')} SET call=$2 WHERE id=$1`, [
      tampered.proposal.actions[0].id,
      update({ [fieldId]: { kind: 'text', value: 'Changed after approval' } }),
    ]);
    assert.equal(await tampered.execute(), 'failed');
    assert.equal((await read()).values[fieldId].value, 'Alice');
  });
  await t.test(
    'added file references need owner access while kept unavailable references stay readable and marked',
    async () => {
      const file = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_files')}(id,kind,creator_membership_id,name,object_key,media_type,size,sha256,ready) VALUES($1,'file',$2,'source.txt',$3,'text/plain',1,$4,true)`,
        [file, w.membershipId, randomUUID(), 'b'.repeat(64)],
      );
      const values = { [fileField]: { kind: 'file', fileIds: [file] } };
      await assert.rejects(start([update(values)]), AccessDenied);
      const grant = () =>
        db.platform.query(
          `INSERT INTO ${table('tf_file_grants')}(item_id,subject_kind,subject_id,role) VALUES($1,'individual',$2,'viewer')`,
          [file, member],
        );
      const revoke = () => db.platform.query(`DELETE FROM ${table('tf_file_grants')} WHERE item_id=$1`, [file]);
      await grant();
      const item = await start([update(values)]);
      await revoke();
      await assert.rejects(item.approve(), AccessDenied);
      await grant();
      await item.approve();
      await revoke();
      assert.equal(await item.execute(), 'blocked');
      await grant();
      const allowed = await start([update(values)]);
      await allowed.approve();
      assert.equal(await allowed.execute(), 'completed');
      const task = await tasks.start(w.id, user, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        text: 'Read file ref',
        scope,
      });
      const { runId } = await approvals.bindRun(w.id, user, task.id, { generation: 0 }),
        callId = randomUUID();
      await executor.queueCall(w.id, owner, {
        runId,
        callId,
        sequence: 0,
        call: { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId },
      });
      assert.equal(await executor.execute({ workspaceId: w.id, runId, callId }), 'completed');
      await revoke();
      const stored = await read();
      const marked = { id: recordId, token: stored.token, values: stored.values, unavailableFileIds: [file] };
      assert.deepEqual(stored.values[fileField], { kind: 'file', fileIds: [file] });
      assert.deepEqual((await executor.readResult({ workspaceId: w.id, runId, callId }, owner)).result, marked);
      assert.equal((await tasks.history(w.id, user, task.id)).messages[0].text, 'Read file ref');
      assert.deepEqual(await records.getRecord(w.id, { kind: 'agent', runId }, tableId, revision, recordId), marked);
      assert.deepEqual(
        (await records.listRecords(w.id, { kind: 'agent', runId }, tableId, revision, {})).records.find(
          record => record.id === recordId,
        ),
        marked,
      );
      assert.deepEqual(
        (await approvals.read(w.id, user, allowed.task.id, allowed.proposal.id)).actions[0].after.values[fileField],
        { kind: 'file', fileIds: [file] },
      );
      const kept = await start([update({ [fieldId]: { kind: 'text', value: 'Kept file' } })]);
      assert.deepEqual(
        [kept.proposal.actions[0].before.values[fileField], kept.proposal.actions[0].after.values[fileField]],
        [
          { kind: 'file', fileIds: [file] },
          { kind: 'file', fileIds: [file] },
        ],
      );
      await kept.approve();
      assert.equal(await kept.execute(), 'completed');
      const written = (
        await executor.readResult(
          { workspaceId: w.id, runId: kept.proposal.runId, callId: kept.proposal.actions[0].id },
          owner,
        )
      ).result;
      assert.deepEqual(
        [written.values[fieldId], written.values[fileField], written.unavailableFileIds],
        [{ kind: 'text', value: 'Kept file' }, { kind: 'file', fileIds: [file] }, [file]],
      );
      const other = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_files')}(id,kind,creator_membership_id,name,object_key,media_type,size,sha256,ready) VALUES($1,'file',$2,'other.txt',$3,'text/plain',1,$4,true)`,
        [other, w.membershipId, randomUUID(), 'b'.repeat(64)],
      );
      await assert.rejects(start([update({ [fileField]: { kind: 'file', fileIds: [file, other] } })]), AccessDenied);
      await grant();
      const current = await read();
      await tableService.mutate(w.id, user, {
        kind: 'update',
        tableId,
        revision,
        recordId,
        expectedToken: current.token,
        values: { [fieldId]: { kind: 'text', value: 'Alice' }, [fileField]: null },
      });
    },
  );
  await t.test('schema activation invalidates pending and approved task revisions', async () => {
    const pending = await start([update({ [fieldId]: { kind: 'text', value: 'Stale' } })]);
    const approved = await start([update({ [fieldId]: { kind: 'text', value: 'Stale' } })]);
    await approved.approve();
    generation = await activate(definition, 'b'.repeat(40), generation.id, [await read()]);
    await assert.rejects(pending.approve(), e => e.code === 'stale-proposal');
    assert.equal(await approved.execute(), 'failed');
    const refreshed = await approvals.recover(w.id, user, pending.task.id, pending.proposal.id, {
      requestId: randomUUID(),
      generation: 0,
    });
    assert.equal(refreshed.actions[0].call.expectedAppliedRevision, 'b'.repeat(40));
    assert.equal(refreshed.status.decision, null);
  });
});
