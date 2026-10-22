import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createTableService } from '@tulipfarm/tables/service';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

test(
  'table steps find, create and update rows as the run member with row tokens, and run history names the changed rows',
  { timeout: 120000 },
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
      bob = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_teams')}(id,name) VALUES($1,'Sales')`, [team]);
    await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
      bob.membershipId,
      bob.userId,
    ]);
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
      bob.membershipId,
      team,
    ]);
    const revision = '1'.repeat(40);
    const open = { id: randomUUID(), label: 'Open', retired: false },
      closed = { id: randomUUID(), label: 'Closed', retired: false },
      overdue = { id: randomUUID(), label: 'Overdue', retired: false };
    const field = (label, kind, extra = {}) => ({ id: randomUUID(), label, required: false, kind, ...extra });
    const fields = {
      name: field('Name', 'text', { maxLength: 200 }),
      amount: field('Amount', 'numeric', { precision: 10, scale: 2 }),
      status: field('Status', 'single-select', { options: [open, closed, overdue] }),
      due: field('Due', 'timestamp', { timezone: 'UTC' }),
      contract: field('Contract', 'file', { cardinality: 'one', access: 'independent' }),
    };
    const leads = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Leads',
      fields: Object.values(fields),
      uniqueKeys: [{ id: randomUUID(), fieldIds: [fields.name.id], nulls: 'distinct' }],
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
    const row = async recordId => await records.read(w.id, w.userId, { tableId: leads.id, revision, recordId });
    const rowCount = async () =>
      Number(
        (
          await db.databaseAdmin.query(`SELECT count(*) FROM ${table('tf_table_identities')} WHERE table_id=$1`, [
            leads.id,
          ])
        ).rows[0].count,
      );

    const service = createWorkflows(runtime);
    const save = async (who, definition, id = randomUUID()) => {
      const workflowRevision = randomUUID();
      await service.save(w.id, who.userId, id, { revision: workflowRevision, expectedRevision: null, definition });
      return { id, revision: workflowRevision };
    };
    const drive = async runId => {
      for (let step = 0; step < 20; step++)
        if ((await service.advance({ workspaceId: w.id, runId })).kind === 'done') return;
      assert.fail('run did not finish');
    };
    const run = async (who, workflow, input) => {
      const { runId } = await service.start(w.id, who.userId, workflow.id, { requestId: randomUUID(), input });
      await drive(runId);
      return (await service.history(w.id, who.userId, workflow.id).then(page => page.runs)).find(
        item => item.id === runId,
      );
    };
    const input = path => ({ kind: 'input', path });
    const literal = value => ({ kind: 'literal', value });

    const addLead = {
      version: 1,
      name: 'Add lead',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'add',
          kind: 'create-row',
          tableId: leads.id,
          fields: {
            [fields.name.id]: input(['name']),
            [fields.amount.id]: input(['amount']),
            [fields.status.id]: literal('Open'),
          },
        },
        {
          id: 'find',
          kind: 'find-rows',
          tableId: leads.id,
          filters: [{ fieldId: fields.name.id, op: 'eq', value: input(['name']) }],
          limit: 5,
        },
        {
          id: 'close',
          kind: 'update-row',
          tableId: leads.id,
          row: { kind: 'step', step: 'find', path: ['rows', '0'] },
          fields: { [fields.status.id]: literal(closed.id) },
        },
        {
          id: 'find_closed',
          kind: 'find-rows',
          tableId: leads.id,
          filters: [{ fieldId: fields.status.id, op: 'eq', value: literal('Closed') }],
          limit: 5,
        },
      ],
    };
    const lead = await save(w, addLead);
    await activate(service, w.id, w.userId, lead.id, lead.revision, true);
    const added = await run(w, lead, { name: 'Acme', amount: 1250.5 });
    assert.equal(added.status, 'completed');
    const [create, found, update, closedRows] = added.steps.map(step => step.output);
    assert.deepEqual(
      { ...create, recordId: undefined, token: undefined },
      {
        operation: 'created',
        tableId: leads.id,
        recordId: undefined,
        token: undefined,
        fieldIds: [fields.name.id, fields.amount.id, fields.status.id].sort(),
      },
      'history names the created row and the fields the step wrote',
    );
    assert.deepEqual(
      found,
      {
        tableId: leads.id,
        more: false,
        rows: [
          {
            recordId: create.recordId,
            token: create.token,
            values: {
              [fields.name.id]: { kind: 'text', value: 'Acme' },
              [fields.amount.id]: { kind: 'numeric', value: '1250.50' },
              [fields.status.id]: { kind: 'single-select', optionId: open.id },
              [fields.due.id]: null,
            },
          },
        ],
      },
      'found rows carry their tokens and leave file values out of the run',
    );
    assert.deepEqual(
      { ...update, token: undefined },
      {
        operation: 'updated',
        tableId: leads.id,
        recordId: create.recordId,
        token: undefined,
        fieldIds: [fields.status.id],
      },
    );
    assert.deepEqual(
      closedRows.rows.map(row => row.recordId),
      [create.recordId],
      'find-rows filters a single-choice field by its option label',
    );
    assert.notEqual(update.token, create.token);
    const stored = await row(create.recordId);
    assert.equal(stored.token, update.token);
    assert.deepEqual(
      stored.values[fields.status.id],
      { kind: 'single-select', optionId: closed.id },
      'the update wrote the row',
    );
    assert.deepEqual(
      stored.values[fields.name.id],
      { kind: 'text', value: 'Acme' },
      'the update kept fields it did not map',
    );
    assert.deepEqual(
      (await records.history(w.id, w.userId, { tableId: leads.id, recordId: create.recordId }))
        .map(entry => [entry.operation, entry.actor])
        .sort(),
      [
        ['create', { kind: 'human', userId: w.userId, membershipId: w.membershipId }],
        ['update', { kind: 'human', userId: w.userId, membershipId: w.membershipId }],
      ],
      'row history records the run member as the writer',
    );

    const before = await rowCount();
    const duplicate = await run(w, lead, { name: 'Acme', amount: 1 });
    assert.deepEqual([duplicate.status, duplicate.error, duplicate.steps.length], ['failed', 'table-row-duplicate', 0]);
    assert.equal(await rowCount(), before, 'a failed write leaves no partial row');
    const invalidAmount = await run(w, lead, { name: 'Globex', amount: 'lots' });
    assert.deepEqual([invalidAmount.status, invalidAmount.error], ['failed', 'table-input-invalid']);

    const rename = await save(w, {
      version: 1,
      name: 'Rename lead',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'rename',
          kind: 'update-row',
          tableId: leads.id,
          row: input(['lead']),
          fields: { [fields.name.id]: input(['name']) },
        },
      ],
    });
    await activate(service, w.id, w.userId, rename.id, rename.revision, true);
    const stale = await run(w, rename, { lead: { recordId: create.recordId, token: create.token }, name: 'Stale' });
    assert.deepEqual(
      [stale.status, stale.error],
      ['failed', 'table-row-stale'],
      'an update with an old row token fails instead of overwriting a newer change',
    );
    assert.deepEqual((await row(create.recordId)).values[fields.name.id], { kind: 'text', value: 'Acme' });
    const wrongTable = await run(w, rename, {
      lead: { tableId: randomUUID(), recordId: create.recordId, token: update.token },
      name: 'Other',
    });
    assert.deepEqual(
      [wrongTable.status, wrongTable.error],
      ['failed', 'table-input-invalid'],
      'a row reference from another table is refused',
    );
    const renamed = await run(w, rename, {
      lead: { recordId: create.recordId, token: update.token },
      name: 'Acme Corp',
    });
    assert.equal(renamed.status, 'completed');
    assert.deepEqual((await row(create.recordId)).values[fields.name.id], { kind: 'text', value: 'Acme Corp' });

    const logOnce = await save(w, {
      version: 1,
      name: 'Log once',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'add',
          kind: 'create-row',
          tableId: leads.id,
          fields: { [fields.amount.id]: input(['amount']), [fields.status.id]: literal('Open') },
        },
      ],
    });
    await activate(service, w.id, w.userId, logOnce.id, logOnce.revision, true);
    const once = await service.start(w.id, w.userId, logOnce.id, {
      requestId: randomUUID(),
      input: { name: 'Hooli', amount: 3 },
    });
    const beforeRetry = await rowCount();
    await Promise.all([
      service.advance({ workspaceId: w.id, runId: once.runId }),
      service.advance({ workspaceId: w.id, runId: once.runId }),
    ]);
    await drive(once.runId);
    assert.equal(
      await rowCount(),
      beforeRetry + 1,
      'two concurrent advances of a create-row step write one row: the authorization write lock serializes them and the receipt primary key rejects a second receipt',
    );
    const receipts = (
      await db.databaseAdmin.query(
        `SELECT output FROM ${table('tf_workflow_steps')} WHERE run_id=$1 AND step_id='add'`,
        [once.runId],
      )
    ).rows;
    assert.equal(receipts.length, 1, 'the (run_id, step_id) primary key leaves exactly one receipt');
    assert.equal(
      (
        await db.databaseAdmin.query(
          `SELECT count(*)::integer AS count FROM ${table('tf_table_identities')} WHERE table_id=$1 AND row_id=$2`,
          [leads.id, receipts[0].output.recordId],
        )
      ).rows[0].count,
      1,
      'the receipt names the row that was written',
    );

    await assert.rejects(
      save(w, { ...addLead, steps: [{ ...addLead.steps[0], fields: { [randomUUID()]: literal('x') } }] }),
      { message: 'table-step-field-unavailable' },
      'a step naming a field the table lacks is refused at save',
    );
    await assert.rejects(
      save(w, { ...addLead, steps: [{ ...addLead.steps[0], fields: { [fields.contract.id]: literal(null) } }] }),
      { message: 'table-step-field-unavailable' },
      'file fields cannot be written',
    );
    await assert.rejects(
      save(bob, addLead),
      AccessDenied,
      'a member who cannot read the table cannot save a step on it',
    );
    await assert.rejects(
      service.checkTableSteps(w.id, bob.userId, addLead),
      AccessDenied,
      'a chat draft gets the same check before review',
    );
    assert.equal(
      await service.checkTableSteps(w.id, w.userId, { ...addLead, trigger: { kind: 'webhook' } }),
      undefined,
    );

    await service.share(w.id, w.userId, lead.id, {
      principal: { kind: 'person', id: bob.membershipId },
      permissions: ['read', 'invoke'],
    });
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [team, leads.id],
    );
    const readOnly = await rowCount();
    const refused = await run(bob, lead, { name: 'Initech', amount: 5 });
    assert.deepEqual(
      [refused.status, refused.error],
      ['blocked', 'table-authority-revoked'],
      'a requester without create permission cannot add rows',
    );
    assert.equal(await rowCount(), readOnly);

    const intake = await save(w, { ...addLead, name: 'Webhook intake', trigger: { kind: 'webhook' } });
    await service.share(w.id, w.userId, intake.id, {
      principal: { kind: 'person', id: bob.membershipId },
      permissions: ['read', 'invoke'],
    });
    await assert.rejects(
      service.sponsorship(w.id, w.userId, intake.id, {
        sponsorMembershipId: bob.membershipId,
        historyAudience: [bob.membershipId],
      }),
      { message: 'table-step-access-denied' },
      'a sponsor needs every write permission the steps use',
    );
    await assert.rejects(
      service.checkTableSteps(w.id, bob.userId, { ...addLead, trigger: { kind: 'webhook' } }),
      { message: 'table-step-access-denied' },
      'a chat draft of an unattended workflow needs the drafter to hold the write permissions',
    );
    assert.equal(
      await service.checkTableSteps(w.id, bob.userId, addLead),
      undefined,
      'a manual draft only needs read at review time',
    );
    await db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE team_id=$1`, [team]);
    await assert.rejects(
      service.sponsorship(w.id, w.userId, intake.id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId, bob.membershipId],
      }),
      { message: 'table-step-access-denied' },
      'the history audience must be able to read the rows the steps return',
    );
    await service.sponsorship(w.id, w.userId, intake.id, {
      sponsorMembershipId: w.membershipId,
      historyAudience: [w.membershipId],
    });
    await activate(service, w.id, w.userId, intake.id, intake.revision, true);

    const reminder = await save(w, {
      version: 1,
      name: 'Mark overdue',
      trigger: {
        kind: 'record',
        tableId: leads.id,
        field: {
          kind: 'timestamp',
          fieldId: fields.due.id,
          offset: { direction: 'after', amount: 0, unit: 'minutes' },
        },
      },
      steps: [
        {
          id: 'mark',
          kind: 'update-row',
          tableId: leads.id,
          row: input([]),
          fields: { [fields.status.id]: literal('Overdue') },
        },
      ],
    });
    await service.sponsorship(w.id, w.userId, reminder.id, {
      sponsorMembershipId: w.membershipId,
      historyAudience: [w.membershipId],
    });
    await activate(service, w.id, w.userId, reminder.id, reminder.revision, true);
    const dueSoon = new Date(Date.now() + 1500).toISOString();
    const invoice = await records.mutate(w.id, w.userId, {
      kind: 'create',
      tableId: leads.id,
      revision,
      recordId: randomUUID(),
      values: {
        [fields.name.id]: { kind: 'text', value: 'Invoice 7' },
        [fields.due.id]: { kind: 'timestamp', value: dueSoon },
      },
    });
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp() WHERE id=$1`, [
      reminder.id,
    ]);
    await service.due(w.id);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp() WHERE id=$1`, [
      reminder.id,
    ]);
    await service.due(w.id);
    const [fired] = await service.history(w.id, w.userId, reminder.id).then(page => page.runs);
    assert.deepEqual(fired.input.token, invoice.token, 'record runs carry the row token');
    await drive(fired.id);
    const marked = (await service.history(w.id, w.userId, reminder.id).then(page => page.runs))[0];
    assert.deepEqual(
      [marked.status, marked.steps[0].output.operation, marked.steps[0].output.recordId],
      ['completed', 'updated', invoice.id],
      'a record date run updates the row that fired it',
    );
    assert.deepEqual((await row(invoice.id)).values[fields.status.id], { kind: 'single-select', optionId: overdue.id });
  },
);
