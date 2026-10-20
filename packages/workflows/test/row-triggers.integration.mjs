import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createTableService } from '@tulipfarm/tables/service';
import {
  createGeneration,
  activateGeneration,
  activeGeneration,
  identity,
  persistMutation,
  pruneHistoryValues,
  readRecords,
  writeGenerationRecord,
} from '@tulipfarm/tables/store';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

test(
  'row triggers retain every accepted event through capacity, restart, retention and authorization changes',
  { timeout: 180000 },
  async t => {
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    const w = await db.create(migrations);
    const table = name => qualified(w.names.schema, name);
    const runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    cleanup.push(() => runtime.close());
    const migration = await connect(db.login(w, 'migration'));
    cleanup.push(() => migration.end());

    const team = randomUUID(),
      revision = '1'.repeat(40);
    await db.platform.query(`INSERT INTO ${table('tf_teams')}(id,name) VALUES($1,'Sales')`, [team]);
    const field = (kind, extra = {}) => ({ id: randomUUID(), label: kind, required: false, kind, ...extra });
    const fields = {
      name: field('text', { maxLength: 200 }),
      amount: field('numeric', { precision: 12, scale: 2 }),
      close: field('date'),
      notes: field('text', { maxLength: 200 }),
    };
    const leads = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Leads',
      fields: Object.values(fields),
      uniqueKeys: [],
    };
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      const tx = { client, schema: w.names.schema };
      const generation = await createGeneration(tx, { definition: leads, revision });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
    });
    const records = createTableService(
      runtime,
      { readableFiles: async (_tx, _actor, ids) => new Set(ids) },
      { minimum: migrations.length, maximum: migrations.length },
    );
    const values = ({ name = 'Lead', amount = null, close = null, notes = null }) => ({
      [fields.name.id]: { kind: 'text', value: name },
      [fields.amount.id]: amount && { kind: 'numeric', value: amount },
      [fields.close.id]: close && { kind: 'date', value: close },
      [fields.notes.id]: notes && { kind: 'text', value: notes },
    });
    const create = input =>
      records.mutate(w.id, w.userId, {
        kind: 'create',
        tableId: leads.id,
        revision,
        recordId: randomUUID(),
        values: values(input),
      });
    const update = (row, changes) =>
      records.mutate(w.id, w.userId, {
        kind: 'update',
        tableId: leads.id,
        revision,
        recordId: row.id,
        expectedToken: row.token,
        values: changes,
      });
    const remove = row =>
      records.mutate(w.id, w.userId, {
        kind: 'delete',
        tableId: leads.id,
        revision,
        recordId: row.id,
        expectedToken: row.token,
      });
    const restore = async row => {
      const entry = (await records.history(w.id, w.userId, { tableId: leads.id, recordId: row.id })).find(
        item => item.operation === 'delete',
      );
      return records.mutate(w.id, w.userId, {
        kind: 'restore',
        tableId: leads.id,
        revision,
        recordId: row.id,
        expectedToken: entry.token,
        historyId: entry.id,
        version: 'after',
      });
    };

    const service = createWorkflows(runtime);
    const steps = [{ id: 'note', kind: 'transform', fields: { record: { kind: 'input', path: ['recordId'] } } }];
    const definition = trigger => ({ version: 1, name: 'Lead follow-up', trigger, steps });
    const launch = async (trigger, workflowSteps = steps) => {
      const id = randomUUID(),
        workflowRevision = randomUUID();
      await service.save(w.id, w.userId, id, {
        revision: workflowRevision,
        expectedRevision: null,
        definition: { ...definition(trigger), steps: workflowSteps },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await activate(service, w.id, w.userId, id, workflowRevision, true);
      return id;
    };
    const sweep = async () => {
      await db.databaseAdmin.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=LEAST(next_run_at,clock_timestamp()) WHERE enabled`,
      );
      await service.due(w.id);
    };
    const runs = async id =>
      (await service.history(w.id, w.userId, id).then(page => page.runs)).filter(run => run.source === 'row').reverse();
    const inputs = async id => (await runs(id)).map(run => run.input);
    const changedAt = input => {
      assert.match(input.changedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      const { changedAt: _changedAt, ...rest } = input;
      return rest;
    };
    const tableId = leads.id;

    await create({ name: 'Before activation' });
    const created = await launch({ kind: 'row', tableId, event: 'created' });
    const updated = await launch({ kind: 'row', tableId, event: 'updated' });
    const amountChanged = await launch({ kind: 'row', tableId, event: 'updated', fieldIds: [fields.amount.id] });
    const deleted = await launch({ kind: 'row', tableId, event: 'deleted' });
    await sweep();
    assert.deepEqual(await inputs(created), [], 'a row created before activation does not run');

    const acme = await create({ name: 'Acme', amount: '1200' });
    const renamed = await update(acme, { [fields.name.id]: { kind: 'text', value: 'Acme Corp' } });
    const repriced = await update(renamed, { [fields.amount.id]: { kind: 'numeric', value: '1500' } });
    const rewritten = await update(repriced, { [fields.amount.id]: { kind: 'numeric', value: '1500' } });
    await sweep();
    assert.deepEqual(
      (await inputs(created)).map(changedAt),
      [
        {
          event: 'created',
          tableId,
          recordId: acme.id,
          token: acme.token,
          values: values({ name: 'Acme', amount: '1200' }),
        },
      ],
      'a created row runs once with its values and row token',
    );
    assert.deepEqual(
      (await inputs(updated)).map(changedAt),
      [
        {
          event: 'updated',
          tableId,
          recordId: acme.id,
          token: renamed.token,
          changedFieldIds: [fields.name.id],
          values: values({ name: 'Acme Corp', amount: '1200.00' }),
          previousValues: values({ name: 'Acme', amount: '1200.00' }),
        },
        {
          event: 'updated',
          tableId,
          recordId: acme.id,
          token: repriced.token,
          changedFieldIds: [fields.amount.id],
          values: values({ name: 'Acme Corp', amount: '1500' }),
          previousValues: values({ name: 'Acme Corp', amount: '1200.00' }),
        },
      ],
      'each update runs with the previous values and changed fields, and a write that changes nothing does not run',
    );
    assert.deepEqual(
      (await inputs(amountChanged)).map(input => input.changedFieldIds),
      [[fields.amount.id]],
      'an update trigger on chosen fields ignores changes to other fields',
    );
    const rewriteHistory = (await records.history(w.id, w.userId, { tableId, recordId: acme.id })).find(
      entry => entry.token === rewritten.token,
    );
    assert.deepEqual(
      rewriteHistory.field_ids,
      [],
      'a numeric rewrite with fewer trailing zeros names no changed fields',
    );

    const last = values({ name: 'Acme Corp', amount: '1500.00' });
    await remove(rewritten);
    await sweep();
    assert.deepEqual(
      (await inputs(deleted)).map(changedAt),
      [{ event: 'deleted', tableId, recordId: acme.id, values: last }],
      'a deleted row runs with its last values and no token',
    );
    const back = await restore(acme);
    await sweep();
    assert.deepEqual(
      (await inputs(created)).map(changedAt).at(-1),
      { event: 'created', tableId, recordId: acme.id, token: back.token, values: last },
      'restoring a deleted row runs the created trigger',
    );
    await sweep();
    assert.equal((await runs(created)).length, 2, 'rereading the change window does not run a change twice');
    assert.equal((await runs(updated)).length, 2);

    const large = await launch({
      kind: 'row',
      tableId,
      event: 'created',
      filter: { fieldId: fields.amount.id, match: 'gte', value: { kind: 'numeric', value: '1000' } },
    });
    const closing = await launch({
      kind: 'row',
      tableId,
      event: 'created',
      filter: { fieldId: fields.close.id, match: 'lt', value: { kind: 'date', value: '2027-01-01' } },
    });
    const unnoted = await launch({
      kind: 'row',
      tableId,
      event: 'created',
      filter: { fieldId: fields.notes.id, match: 'is-empty' },
    });
    const big = await create({ name: 'Big', amount: '1000.50', close: '2026-12-31', notes: 'Call back' });
    await create({ name: 'Small', amount: '999.99', close: '2027-02-01' });
    await create({ name: 'Blank' });
    await sweep();
    const names = async id => (await inputs(id)).map(input => input.values[fields.name.id].value);
    assert.deepEqual(await names(large), ['Big'], 'a number filter compares decimal values');
    assert.deepEqual(await names(closing), ['Big'], 'a date filter compares calendar days and skips rows without one');
    assert.deepEqual(await names(unnoted), ['Small', 'Blank'], 'an empty check matches rows without a value');

    await assert.rejects(
      launch({ kind: 'row', tableId, event: 'updated', fieldIds: [randomUUID()] }),
      { message: 'record-field-unavailable' },
      'an update trigger cannot watch a field the table lacks',
    );
    await assert.rejects(
      launch({
        kind: 'row',
        tableId,
        event: 'created',
        filter: { fieldId: fields.name.id, match: 'gt', value: { kind: 'numeric', value: '1' } },
      }),
      { message: 'record-field-unavailable' },
      'a number filter on a text field is refused',
    );
    await assert.rejects(
      service.save(w.id, w.userId, randomUUID(), {
        revision: randomUUID(),
        expectedRevision: null,
        definition: {
          ...definition({ kind: 'row', tableId, event: 'created' }),
          steps: [
            {
              id: 'copy',
              kind: 'create-row',
              tableId,
              fields: { [fields.name.id]: { kind: 'literal', value: 'Copy' } },
            },
          ],
        },
      }),
      /A step cannot make the row change that triggers this workflow/,
      'a workflow cannot create the rows that trigger it',
    );

    const record = filter =>
      launch({
        kind: 'record',
        tableId,
        field: {
          kind: 'date',
          fieldId: fields.close.id,
          offset: { direction: 'before', amount: 0, unit: 'days' },
          time: '09:00',
          timezone: 'UTC',
        },
        filter,
      });
    const future = await create({ name: 'Future', amount: '50', close: '2099-01-01' });
    const upcoming = async id => {
      await sweep();
      return (await service.list(w.id, w.userId))
        .find(item => item.id === id)
        .upcomingRecords.map(item => item.recordId);
    };
    assert.deepEqual(
      await upcoming(
        await record({ fieldId: fields.amount.id, match: 'lt', value: { kind: 'numeric', value: '100' } }),
      ),
      [future.id],
      'a record trigger filters on a number',
    );
    assert.deepEqual(
      await upcoming(await record({ fieldId: fields.notes.id, match: 'is-not-empty' })),
      [big.id],
      'a record trigger filters on an empty check',
    );

    const bulk = await launch(
      {
        kind: 'row',
        tableId,
        event: 'created',
        filter: { fieldId: fields.notes.id, match: 'is', value: { kind: 'text', value: 'Imported' } },
      },
      [{ id: 'review', kind: 'human', prompt: 'Review imported row', timeoutSeconds: 3600 }],
    );
    // An import page writes its rows in one transaction, so their history entries share one change time.
    await runtime.transaction(w.id, { minimum: migrations.length, maximum: migrations.length }, async tx => {
      const generation = await activeGeneration(tx, tableId);
      for (let index = 0; index < 130; index++)
        await persistMutation(tx, {
          generation,
          recordId: randomUUID(),
          before: null,
          values: values({ name: `Import ${index}`, notes: 'Imported' }),
          actor: { kind: 'human', userId: w.userId, membershipId: w.membershipId },
          operation: 'create',
        });
    });
    assert.equal(
      Number(
        (
          await db.databaseAdmin.query(
            `SELECT count(DISTINCT created_at) AS times FROM ${table('tf_table_row_history_data')} WHERE values->$1->>'value'='Imported'`,
            [fields.notes.id],
          )
        ).rows[0].times,
      ),
      1,
      'the imported rows share one change time',
    );
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflow_runs')} SET status='completed' WHERE status='queued'`);
    await sweep();
    const skipped = await service.history(w.id, w.userId, bulk, { status: 'skipped' });
    assert.equal(skipped.runs.length, 0, 'capacity never creates a skipped row run');
    assert.equal(
      (await runs(bulk)).filter(run => run.status === 'queued').length,
      10,
      'the workflow run cap still applies',
    );
    const bulkQueue = (await service.list(w.id, w.userId)).find(item => item.id === bulk).rowQueue;
    assert.equal(bulkQueue.pending + bulkQueue.blocked, 120, 'every remaining import event is retained');
    assert.deepEqual(bulkQueue.blockers, [{ reason: 'capacity', count: 1 }]);
    for (const run of await runs(bulk)) await service.advance({ workspaceId: w.id, runId: run.id });
    assert.equal(
      (await runs(bulk)).filter(run => run.status === 'waiting').length,
      10,
      'approval waits consume finite admission slots',
    );
    await db.databaseAdmin.query(
      `UPDATE ${table('tf_table_row_history_data')} SET recoverable_until=clock_timestamp()-interval '31 days'`,
    );
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      await pruneHistoryValues({ client, schema: w.names.schema });
    });
    assert.equal(
      Number(
        (
          await db.databaseAdmin.query(
            `SELECT count(*) AS count FROM ${table('tf_workflow_row_events')} WHERE workflow_id=$1 AND settled_at IS NULL AND snapshot->'values' IS NOT NULL`,
            [bulk],
          )
        ).rows[0].count,
      ),
      120,
      'pending snapshots survive table history retention',
    );
    assert.equal(
      (await inputs(bulk)).every(input => input.values[fields.notes.id].value === 'Imported'),
      true,
      'runs awaiting human approval retain their complete input after history pruning',
    );
    for (let round = 0; round < 20; round++) {
      await db.databaseAdmin.query(
        `UPDATE ${table('tf_workflow_runs')} SET status='completed' WHERE status IN ('queued','waiting')`,
      );
      await db.databaseAdmin.query(`UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp() WHERE enabled`);
      await createWorkflows(runtime).due(w.id);
    }
    const admitted = (
      await db.databaseAdmin.query(
        `SELECT input->'values'->$2->>'value' AS name FROM ${table('tf_workflow_runs')} WHERE workflow_id=$1 AND status<>'skipped' ORDER BY created_at`,
        [bulk, fields.name.id],
      )
    ).rows.map(row => row.name);
    assert.deepEqual(
      admitted,
      Array.from({ length: 130 }, (_, index) => `Import ${index}`),
      'all 130 imported events run exactly once after restart and pruning',
    );
    assert.equal(
      Number(
        (
          await db.databaseAdmin.query(
            `SELECT count(*) AS count FROM ${table('tf_workflow_runs')} WHERE workflow_id=$1 AND status='skipped'`,
            [bulk],
          )
        ).rows[0].count,
      ),
      0,
    );
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflows')} SET enabled=false`);

    const started = Promise.withResolvers(),
      commitLate = Promise.withResolvers();
    const lateMutation = runtime.transaction(
      w.id,
      { minimum: migrations.length, maximum: migrations.length },
      async tx => {
        const generation = await activeGeneration(tx, tableId);
        await tx.client.query('SELECT now()');
        started.resolve();
        await commitLate.promise;
        const client = new Proxy(tx.client, {
          get(target, key) {
            if (key !== 'query') {
              const value = target[key];
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return (sql, parameters) =>
              target.query(
                typeof sql === 'string' && sql.includes('INSERT INTO') && sql.includes('tf_table_row_history_data')
                  ? sql
                      .replace('(id,table_id', '(created_at,id,table_id')
                      .replace('VALUES($1', "VALUES(now()-interval '2 hours',$1")
                  : sql,
                parameters,
              );
          },
        });
        return persistMutation(
          { ...tx, client },
          {
            generation,
            recordId: randomUUID(),
            before: null,
            values: values({ name: 'Late commit' }),
            actor: { kind: 'human', userId: w.userId, membershipId: w.membershipId },
            operation: 'create',
          },
        );
      },
    );
    await started.promise;
    const durable = await launch({ kind: 'row', tableId, event: 'created' });
    const earlierCommit = await create({ name: 'Early commit' });
    await sweep();
    assert.deepEqual(
      (await inputs(durable)).map(input => input.recordId),
      [earlierCommit.id],
    );
    commitLate.resolve();
    const laterCommit = await lateMutation;
    await sweep();
    assert.deepEqual(
      new Set((await inputs(durable)).map(input => input.recordId)),
      new Set([earlierCommit.id, laterCommit.id]),
      'a transaction started before activation, with a two-hour-old change time, still captures its later mutation after another transaction commits and sweeps',
    );
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp() WHERE id=$1`, [
      durable,
    ]);
    const captured = Promise.withResolvers(),
      releaseFirst = Promise.withResolvers();
    const firstWriter = runtime.transaction(
      w.id,
      { minimum: migrations.length, maximum: migrations.length },
      async tx => {
        const generation = await activeGeneration(tx, tableId);
        const row = await persistMutation(tx, {
          generation,
          recordId: randomUUID(),
          before: null,
          values: values({ name: 'Allocated first, committed last' }),
          actor: { kind: 'human', userId: w.userId, membershipId: w.membershipId },
          operation: 'create',
        });
        captured.resolve(row);
        await releaseFirst.promise;
        return row;
      },
    );
    const firstAllocated = await captured.promise;
    const committedFirst = await create({ name: 'Allocated last, committed first' });
    const pageRead = Promise.withResolvers(),
      releasePage = Promise.withResolvers();
    const interleaved = {
      ...runtime,
      transaction: (workspaceId, compatibility, operation) =>
        runtime.transaction(workspaceId, compatibility, tx =>
          operation({
            ...tx,
            client: new Proxy(tx.client, {
              get(client, key) {
                if (key !== 'query') {
                  const value = client[key];
                  return typeof value === 'function' ? value.bind(client) : value;
                }
                return async (sql, params) => {
                  const result = await client.query(sql, params);
                  if (typeof sql === 'string' && sql.startsWith('SELECT history_id AS')) {
                    pageRead.resolve(result.rows);
                    await releasePage.promise;
                  }
                  return result;
                };
              },
            }),
          }),
        ),
    };
    const secondSweep = createWorkflows(interleaved).due(w.id);
    const visiblePage = await pageRead.promise;
    assert.equal(visiblePage.length, 1, 'the sweep sees only the committed writer');
    releaseFirst.resolve();
    await firstWriter;
    releasePage.resolve();
    await secondSweep;
    await sweep();
    assert.equal(
      (await inputs(durable)).filter(input => input.recordId === firstAllocated.id).length,
      1,
      'an earlier allocated history ID is not lost behind a later commit',
    );
    assert.equal((await inputs(durable)).filter(input => input.recordId === committedFirst.id).length, 1);
    const beforeRollback = Number(
      (
        await db.databaseAdmin.query(
          `SELECT count(*) AS count FROM ${table('tf_workflow_row_events')} WHERE workflow_id=$1`,
          [durable],
        )
      ).rows[0].count,
    );
    await assert.rejects(
      runtime.transaction(w.id, { minimum: migrations.length, maximum: migrations.length }, async tx => {
        const generation = await activeGeneration(tx, tableId);
        await persistMutation(tx, {
          generation,
          recordId: randomUUID(),
          before: null,
          values: values({ name: 'Rolled back' }),
          actor: { kind: 'human', userId: w.userId, membershipId: w.membershipId },
          operation: 'create',
        });
        throw new Error('rollback-row');
      }),
      /rollback-row/,
    );
    assert.equal(
      Number(
        (
          await db.databaseAdmin.query(
            `SELECT count(*) AS count FROM ${table('tf_workflow_row_events')} WHERE workflow_id=$1`,
            [durable],
          )
        ).rows[0].count,
      ),
      beforeRollback,
      'a rolled-back mutation leaves no event',
    );
    const retryRow = await create({ name: 'Retry admission' });
    let failedAdmission = false;
    const failing = {
      ...runtime,
      transaction: (workspaceId, compatibility, operation) =>
        runtime.transaction(workspaceId, compatibility, tx =>
          operation({
            ...tx,
            client: new Proxy(tx.client, {
              get(client, key) {
                if (key !== 'query') {
                  const value = client[key];
                  return typeof value === 'function' ? value.bind(client) : value;
                }
                return async (sql, params) => {
                  const result = await client.query(sql, params);
                  if (
                    !failedAdmission &&
                    typeof sql === 'string' &&
                    sql.includes('INSERT INTO') &&
                    sql.includes('tf_workflow_runs')
                  ) {
                    failedAdmission = true;
                    throw new Error('lost-after-admission');
                  }
                  return result;
                };
              },
            }),
          }),
        ),
    };
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp() WHERE id=$1`, [
      durable,
    ]);
    await createWorkflows(failing).due(w.id);
    assert.equal(failedAdmission, true);
    assert.equal(
      (await inputs(durable)).some(input => input.recordId === retryRow.id),
      false,
      'admission and queue settlement roll back together',
    );
    await db.databaseAdmin.query(
      `UPDATE ${table('tf_audit_events')} SET created_at=clock_timestamp()-interval '6 minutes' WHERE subject_id=$1 AND operation='workflow.sweep-failed'`,
      [durable],
    );
    await sweep();
    await sweep();
    assert.equal(
      (await inputs(durable)).filter(input => input.recordId === retryRow.id).length,
      1,
      'restart retries the retained event exactly once',
    );
    const held = await create({ name: 'Disabled then resumed' });
    const durableRevision = (await service.list(w.id, w.userId)).find(item => item.id === durable).revision;
    await activate(service, w.id, w.userId, durable, durableRevision, false);
    let durableQueue = (await service.list(w.id, w.userId)).find(item => item.id === durable).rowQueue;
    assert.deepEqual(durableQueue.blockers, [{ reason: 'workflow-disabled', count: 1 }]);
    await create({ name: 'While disabled' });
    await activate(service, w.id, w.userId, durable, durableRevision, true);
    await sweep();
    assert.equal(
      (await inputs(durable)).filter(input => input.recordId === held.id).length,
      1,
      'reenabling the same revision resumes its retained event only',
    );
    await create({ name: 'Pinned to old revision' });
    const replacement = randomUUID();
    await service.save(w.id, w.userId, durable, {
      revision: replacement,
      expectedRevision: durableRevision,
      definition: definition({ kind: 'row', tableId, event: 'created' }),
    });
    await service.sponsorship(w.id, w.userId, durable, {
      sponsorMembershipId: w.membershipId,
      historyAudience: [w.membershipId],
    });
    await activate(service, w.id, w.userId, durable, replacement, true);
    durableQueue = (await service.list(w.id, w.userId)).find(item => item.id === durable).rowQueue;
    assert.deepEqual(
      durableQueue.blockers,
      [{ reason: 'revision-replaced', count: 1 }],
      'revision replacement keeps old accepted snapshots visibly blocked',
    );
    const current = (await service.list(w.id, w.userId)).find(item => item.id === durable);
    const cancellation = { commandId: randomUUID(), expectedGeneration: current.generation };
    await service.cancelRowEvents(w.id, w.userId, durable, cancellation);
    await create({ name: 'After cancellation' });
    await service.cancelRowEvents(w.id, w.userId, durable, cancellation);
    durableQueue = (await service.list(w.id, w.userId)).find(item => item.id === durable).rowQueue;
    assert.equal(durableQueue.pending, 1, 'replaying cancellation does not cancel newly captured events');
    assert.equal(durableQueue.cancelled, 1);
    await service.archive(w.id, w.userId, durable, {
      commandId: randomUUID(),
      expectedGeneration: current.generation + 1,
    });
    const archived = (await service.list(w.id, w.userId, { archived: true })).find(item => item.id === durable);
    assert.deepEqual(archived.rowQueue.blockers, [{ reason: 'workflow-archived', count: 1 }]);
    await service.cancelRowEvents(w.id, w.userId, durable, {
      commandId: randomUUID(),
      expectedGeneration: archived.generation,
    });
    assert.equal(
      Number(
        (
          await db.databaseAdmin.query(
            `SELECT count(*) AS count FROM ${table('tf_workflow_row_events')} WHERE workflow_id=$1 AND snapshot IS NOT NULL`,
            [durable],
          )
        ).rows[0].count,
      ),
      0,
      'explicit cancellation releases pending snapshots without deleting the outcome',
    );

    const docFields = {
      title: field('text', { maxLength: 200 }),
      body: field('text', { maxLength: 10000 }),
      attachment: field('file', { cardinality: 'one', access: 'independent' }),
    };
    const docs = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Docs',
      fields: Object.values(docFields),
      uniqueKeys: [],
    };
    const docRevision = '3'.repeat(40);
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      const tx = { client, schema: w.names.schema };
      const generation = await createGeneration(tx, { definition: docs, revision: docRevision });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
    });
    const docValues = ({ title = 'Doc', body = null, attachment = null }) => ({
      [docFields.title.id]: { kind: 'text', value: title },
      [docFields.body.id]: body && { kind: 'text', value: body },
      [docFields.attachment.id]: attachment && { kind: 'file', fileIds: [attachment] },
    });
    const shown = input => {
      const { [docFields.attachment.id]: _file, ...rest } = docValues(input);
      return rest;
    };
    const createDoc = input =>
      records.mutate(w.id, w.userId, {
        kind: 'create',
        tableId: docs.id,
        revision: docRevision,
        recordId: randomUUID(),
        values: docValues(input),
      });
    const updateDoc = (row, changes) =>
      records.mutate(w.id, w.userId, {
        kind: 'update',
        tableId: docs.id,
        revision: docRevision,
        recordId: row.id,
        expectedToken: row.token,
        values: changes,
      });
    const workflow = async (who, id) => (await service.list(w.id, who.userId)).find(item => item.id === id);
    const pick = ({ enabled, disabledReason }) => ({ enabled, disabledReason });

    const docCreated = await launch({ kind: 'row', tableId: docs.id, event: 'created' });
    const docUpdated = await launch({ kind: 'row', tableId: docs.id, event: 'updated' });
    const signed = await createDoc({ title: 'Contract', attachment: randomUUID() });
    const resigned = await updateDoc(signed, {
      [docFields.title.id]: { kind: 'text', value: 'Signed contract' },
      [docFields.attachment.id]: { kind: 'file', fileIds: [randomUUID()] },
    });
    await sweep();
    assert.deepEqual(
      (await inputs(docCreated)).map(changedAt),
      [
        {
          event: 'created',
          tableId: docs.id,
          recordId: signed.id,
          token: signed.token,
          values: shown({ title: 'Contract' }),
        },
      ],
      'a created row leaves its file values out of the run',
    );
    assert.deepEqual(
      (await inputs(docUpdated)).map(changedAt),
      [
        {
          event: 'updated',
          tableId: docs.id,
          recordId: signed.id,
          token: resigned.token,
          changedFieldIds: [docFields.title.id],
          values: shown({ title: 'Signed contract' }),
          previousValues: shown({ title: 'Contract' }),
        },
      ],
      'an update leaves file values and changed file fields out of the run',
    );

    // JSON escapes each control character as six bytes, so a 10,000-character body outgrows the 32 KiB run input.
    const huge = '\u0001'.repeat(10000);
    const titled = await launch({
      kind: 'row',
      tableId: docs.id,
      event: 'created',
      filter: { fieldId: docFields.title.id, match: 'is', value: { kind: 'text', value: 'Huge' } },
    });
    const bodied = await launch({
      kind: 'row',
      tableId: docs.id,
      event: 'created',
      filter: { fieldId: docFields.body.id, match: 'is-not-empty' },
    });
    const hugeDoc = await createDoc({ title: 'Huge', body: huge });
    await sweep();
    assert.deepEqual(await inputs(titled), [], 'required row values are never silently truncated to fit a run');
    const queued = async id => (await service.list(w.id, w.userId)).find(item => item.id === id).rowQueue;
    assert.deepEqual((await queued(titled)).blockers, [{ reason: 'values-too-large', count: 1 }]);
    assert.deepEqual((await queued(bodied)).blockers, [{ reason: 'values-too-large', count: 1 }]);
    await sweep();
    assert.equal(
      (await service.history(w.id, w.userId, bodied).then(page => page.runs)).filter(
        run => run.input.recordId === hugeDoc.id,
      ).length,
      0,
      'an oversized event stays blocked, not a successful-looking identity-only run',
    );
    const missing = await launch({
      kind: 'row',
      tableId: docs.id,
      event: 'created',
      filter: { fieldId: docFields.title.id, match: 'is', value: { kind: 'text', value: 'Missing snapshot' } },
    });
    const missingDoc = await createDoc({ title: 'Missing snapshot' });
    const retained = (
      await db.databaseAdmin.query(
        `SELECT history_id,snapshot FROM ${table('tf_workflow_row_events')} WHERE workflow_id=$1`,
        [missing],
      )
    ).rows[0];
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflow_row_events')} SET snapshot=NULL WHERE workflow_id=$1`, [
      missing,
    ]);
    await sweep();
    assert.deepEqual(
      (await queued(missing)).blockers,
      [{ reason: 'values-unavailable', count: 1 }],
      'missing required data blocks visibly instead of marking an event fired',
    );
    await db.databaseAdmin.query(
      `UPDATE ${table('tf_workflow_row_events')} SET snapshot=$2 WHERE workflow_id=$1 AND history_id=$3`,
      [missing, JSON.stringify(retained.snapshot), retained.history_id],
    );
    await sweep();
    assert.deepEqual(
      (await inputs(missing)).map(input => input.recordId),
      [missingDoc.id],
      'restored snapshot data retries without a duplicate event',
    );

    const bob = { userId: randomUUID(), membershipId: randomUUID() },
      readers = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_teams')}(id,name) VALUES($1,'Readers')`, [readers]);
    await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
      bob.membershipId,
      bob.userId,
    ]);
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
      bob.membershipId,
      readers,
    ]);
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [readers, docs.id],
    );
    const bobs = randomUUID(),
      bobsRevision = randomUUID();
    await service.save(w.id, bob.userId, bobs, {
      revision: bobsRevision,
      expectedRevision: null,
      definition: definition({ kind: 'row', tableId: docs.id, event: 'created' }),
    });
    await service.sponsorship(w.id, bob.userId, bobs, {
      sponsorMembershipId: bob.membershipId,
      historyAudience: [bob.membershipId],
    });
    await activate(service, w.id, bob.userId, bobs, bobsRevision, true);
    await sweep();
    assert.deepEqual(pick(await workflow(bob, bobs)), { enabled: true, disabledReason: null });
    const revokedDoc = await createDoc({ title: 'Accepted before revocation' });
    await db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE team_id=$1`, [readers]);
    await sweep();
    assert.deepEqual(
      pick(await workflow(bob, bobs)),
      { enabled: false, disabledReason: 'sponsor-access-lost' },
      'a sponsor who loses table access stops the row trigger and the workflow says why',
    );
    assert.equal((await workflow(bob, bobs)).rowQueue, null, 'revoked source access hides queue metadata');
    assert.equal(
      Number(
        (
          await db.databaseAdmin.query(
            `SELECT count(*) AS count FROM ${table('tf_workflow_row_events')} WHERE workflow_id=$1 AND state='blocked' AND snapshot IS NOT NULL`,
            [bobs],
          )
        ).rows[0].count,
      ),
      1,
      'source revocation retains the accepted snapshot',
    );
    await assert.rejects(
      service.cancelRowEvents(w.id, bob.userId, bobs, {
        commandId: randomUUID(),
        expectedGeneration: (await workflow(bob, bobs)).generation,
      }),
      { message: 'Resource not found' },
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [readers, docs.id],
    );
    await activate(service, w.id, bob.userId, bobs, bobsRevision, true);
    await sweep();
    assert.deepEqual(
      (await service.history(w.id, bob.userId, bobs)).runs.map(run => run.input.recordId),
      [revokedDoc.id],
      'restoring source access and enabling resumes the retained event',
    );

    const watched = await launch({ kind: 'row', tableId: docs.id, event: 'updated', fieldIds: [docFields.body.id] });
    await sweep();
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      const tx = { client, schema: w.names.schema };
      const current = await activeGeneration(tx, docs.id);
      const next = await createGeneration(tx, {
        definition: { ...docs, fields: docs.fields.filter(item => item.id !== docFields.body.id) },
        revision: '4'.repeat(40),
      });
      for (const record of await readRecords(tx, current)) {
        const { [docFields.body.id]: _body, ...kept } = record.values;
        await writeGenerationRecord(tx, {
          generationId: next.id,
          recordId: record.id,
          token: (await identity(tx, docs.id, record.id)).token,
          values: kept,
        });
      }
      await activateGeneration(tx, { generationId: next.id, expectedActiveGenerationId: current.id });
    });
    await sweep();
    assert.deepEqual(
      pick(await workflow(w, watched)),
      { enabled: false, disabledReason: 'record-field-unavailable' },
      'deleting a watched field stops the row trigger and the workflow says why',
    );
    assert.equal(
      Number(
        (
          await db.databaseAdmin.query(
            `SELECT count(*) AS count FROM ${table('tf_workflow_row_events')} q JOIN ${table('tf_table_row_history_data')} h ON h.id=q.history_id WHERE h.operation='transform'`,
          )
        ).rows[0].count,
      ),
      0,
      'generation copies never enter the row event queue',
    );
  },
);
