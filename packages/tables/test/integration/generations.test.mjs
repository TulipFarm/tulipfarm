import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixture, connect, denied } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { AccessDenied } from '@tulipfarm/access';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { createTableService } from '../../../tables/dist/service.js';
import {
  createGeneration,
  activateGeneration,
  writeGenerationRecord,
  pruneHistoryValues,
  generationProposalData,
} from '../../../tables/dist/store.js';

test(
  'generations persist typed records, restrict relationships, enforce authority and recover history on the full stream',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    const workspace = await db.create(migrations);
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
    const migrationClient = await connect(db.login(workspace, 'migration'));
    const raw = await connect(db.login(workspace));
    cleanup.push(
      () => migrationClient.end(),
      () => raw.end(),
    );
    const schema = workspace.names.schema;
    const s = `"${schema}"`;
    const maintenance = action =>
      inTransaction(migrationClient, async client => {
        await client.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
        return action({ client, schema });
      });
    const team = randomUUID(),
      deniedUser = randomUUID(),
      member = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      member,
      deniedUser,
    ]);
    const allowedFiles = new Set();
    const service = createTableService(
      runtime,
      { readableFiles: async (_tx, _actor, ids) => new Set(ids.filter(id => allowedFiles.has(id))) },
      { minimum: migrations.length, maximum: migrations.length },
    );
    const revision = '1'.repeat(40);
    const field = (kind, extra = {}) => ({ id: randomUUID(), label: kind, required: false, kind, ...extra });
    const customers = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Customers',
      fields: [field('text', { maxLength: 10000 })],
      uniqueKeys: [],
    };
    const customerGeneration = await maintenance(async tx => {
      const generation = await createGeneration(tx, { definition: customers, revision });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
      return generation;
    });
    const create = (definition, values, recordId = randomUUID()) =>
      service.mutate(workspace.id, workspace.userId, {
        kind: 'create',
        tableId: definition.id,
        revision,
        recordId,
        values,
      });
    const customer = await create(customers, { [customers.fields[0].id]: { kind: 'text', value: 'Acme' } });
    const option = randomUUID(),
      secondOption = randomUUID(),
      file = randomUUID(),
      reverseField = randomUUID();
    allowedFiles.add(file);
    const fields = {
      title: field('text', { maxLength: 10000 }),
      amount: field('numeric', { precision: 30, scale: 10 }),
      enabled: field('boolean'),
      date: field('date'),
      timestamp: field('timestamp', { timezone: 'UTC' }),
      status: field('single-select', { options: [{ id: option, label: 'Open', retired: false }] }),
      tags: field('multi-select', {
        options: [
          { id: option, label: 'A', retired: false },
          { id: secondOption, label: 'B', retired: false },
        ],
      }),
      customer: field('relationship', {
        targetTableId: customers.id,
        cardinality: 'one',
        inverseCardinality: 'one',
        reverse: { fieldId: reverseField, label: 'Ticket' },
        onDelete: 'restrict',
      }),
      files: field('file', { cardinality: 'many', access: 'independent' }),
    };
    const tickets = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Tickets',
      fields: Object.values(fields),
      uniqueKeys: [{ id: randomUUID(), fieldIds: [fields.title.id, fields.amount.id], nulls: 'distinct' }],
    };
    const generation = await maintenance(async tx => {
      const result = await createGeneration(tx, { definition: tickets, revision });
      await activateGeneration(tx, { generationId: result.id, expectedActiveGenerationId: null });
      return result;
    });
    const values = {
      [fields.title.id]: { kind: 'text', value: 'Broken printer' },
      [fields.amount.id]: { kind: 'numeric', value: '12.50' },
      [fields.enabled.id]: { kind: 'boolean', value: true },
      [fields.date.id]: { kind: 'date', value: '2026-10-01' },
      [fields.timestamp.id]: { kind: 'timestamp', value: '2026-10-01T12:30:00+05:30' },
      [fields.status.id]: { kind: 'single-select', optionId: option },
      [fields.tags.id]: { kind: 'multi-select', optionIds: [option, secondOption] },
      [fields.customer.id]: { kind: 'relationship', tableId: customers.id, recordIds: [customer.id] },
      [fields.files.id]: { kind: 'file', fileIds: [file] },
    };
    const record = await create(tickets, values);
    const read = () =>
      service.read(workspace.id, workspace.userId, { tableId: tickets.id, revision, recordId: record.id });
    const persisted = await read();
    assert.deepEqual(persisted.values[fields.amount.id], { kind: 'numeric', value: '12.5000000000' });
    assert.deepEqual(persisted.values[fields.timestamp.id], { kind: 'timestamp', value: '2026-10-01T07:00:00.000Z' });
    assert.deepEqual(persisted.values[fields.tags.id], {
      kind: 'multi-select',
      optionIds: [option, secondOption].sort(),
    });
    assert.deepEqual(persisted.values[fields.customer.id], values[fields.customer.id]);
    assert.deepEqual(persisted.values[fields.files.id], values[fields.files.id]);
    assert.deepEqual(persisted.values[fields.date.id], values[fields.date.id]);
    assert.deepEqual(persisted.values[fields.enabled.id], values[fields.enabled.id]);
    const columns = await raw.query(
      `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`,
      [schema, generation.physical_table],
    );
    const types = Object.fromEntries(columns.rows.map(row => [row.column_name, row.data_type]));
    assert.equal(types[`f_${fields.timestamp.id.replaceAll('-', '')}`], 'timestamp with time zone');
    assert.equal(types[`f_${fields.amount.id.replaceAll('-', '')}`], 'numeric');
    assert.equal(types[`f_${fields.tags.id.replaceAll('-', '')}`], 'ARRAY');
    assert.equal(types[`f_${fields.status.id.replaceAll('-', '')}`], 'uuid');
    assert.deepEqual(
      await service.reverse(workspace.id, workspace.userId, {
        tableId: customers.id,
        recordId: customer.id,
        fieldId: reverseField,
      }),
      { kind: 'relationship', tableId: tickets.id, cardinality: 'one', recordIds: [record.id], nextCursor: null },
    );
    assert.deepEqual(await service.reverseFields(workspace.id, workspace.userId, { tableId: customers.id }), {
      fields: [{ fieldId: reverseField, tableId: tickets.id, label: 'Tickets', cardinality: 'one' }],
      nextCursor: null,
    });
    await assert.rejects(
      create(tickets, { ...values, [fields.title.id]: { kind: 'text', value: 'Another' } }),
      error => error.code === '23505',
    );
    await assert.rejects(
      service.mutate(workspace.id, workspace.userId, {
        kind: 'delete',
        tableId: customers.id,
        revision,
        recordId: customer.id,
        expectedToken: customer.token,
      }),
      /linked-record/,
    );
    await assert.rejects(
      raw.query(`UPDATE ${s}.tf_table_identities SET live=false WHERE table_id=$1 AND row_id=$2`, [
        customers.id,
        customer.id,
      ]),
      error => error.code === '23503',
    );
    await assert.rejects(
      create(tickets, {
        ...values,
        [fields.customer.id]: null,
        [fields.amount.id]: { kind: 'numeric', value: '12.500' },
      }),
      /duplicate-key/,
    );
    await create(tickets, {
      ...values,
      [fields.customer.id]: null,
      [fields.amount.id]: { kind: 'numeric', value: '13' },
    });
    const longText = 'a'.repeat(9000);
    await create(tickets, {
      [fields.title.id]: { kind: 'text', value: longText },
      [fields.amount.id]: { kind: 'numeric', value: '1' },
    });
    await assert.rejects(
      create(tickets, {
        [fields.title.id]: { kind: 'text', value: longText },
        [fields.amount.id]: { kind: 'numeric', value: '1.0' },
      }),
      /duplicate-key/,
    );
    await create(tickets, {
      [fields.title.id]: { kind: 'text', value: longText + 'b' },
      [fields.amount.id]: { kind: 'numeric', value: '1' },
    });
    await create(tickets, {});
    await create(tickets, {});
    await assert.rejects(
      service.read(workspace.id, deniedUser, { tableId: tickets.id, revision, recordId: record.id }),
      AccessDenied,
    );
    await assert.rejects(
      service.mutate(workspace.id, deniedUser, {
        kind: 'create',
        tableId: tickets.id,
        revision,
        recordId: randomUUID(),
        values: {},
      }),
      AccessDenied,
    );
    await db.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [member, team]);
    for (const permission of ['read', 'create'])
      await db.platform.query(`INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,$3)`, [
        team,
        tickets.id,
        `table.row.${permission}`,
      ]);
    const memberRecord = await service.mutate(workspace.id, deniedUser, {
      kind: 'create',
      tableId: tickets.id,
      revision,
      recordId: randomUUID(),
      values: { [fields.title.id]: { kind: 'text', value: 'Allowed member' } },
    });
    assert.equal(
      (await service.read(workspace.id, deniedUser, { tableId: tickets.id, revision, recordId: memberRecord.id }))
        .values[fields.title.id].value,
      'Allowed member',
    );
    await assert.rejects(
      service.mutate(workspace.id, deniedUser, {
        kind: 'update',
        tableId: tickets.id,
        revision,
        recordId: memberRecord.id,
        expectedToken: memberRecord.token,
        values: {},
      }),
      AccessDenied,
    );
    await assert.rejects(
      service.mutate(workspace.id, deniedUser, {
        kind: 'create',
        tableId: tickets.id,
        revision,
        recordId: randomUUID(),
        values: { [fields.customer.id]: { kind: 'relationship', tableId: customers.id, recordIds: [customer.id] } },
      }),
      AccessDenied,
    );
    allowedFiles.delete(file);
    assert.deepEqual((await read()).unavailableFileIds, [file]);
    await assert.rejects(create(tickets, { [fields.files.id]: { kind: 'file', fileIds: [file] } }), AccessDenied);
    allowedFiles.add(file);
    const update = value =>
      service.mutate(workspace.id, workspace.userId, {
        kind: 'update',
        tableId: tickets.id,
        revision,
        recordId: record.id,
        expectedToken: record.token,
        values: { [fields.title.id]: { kind: 'text', value } },
      });
    const races = await Promise.allSettled([update('First'), update('Second')]);
    assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(races.find(result => result.status === 'rejected').reason.code, 'stale-record');
    const edited = await read();
    assert.notEqual(edited.token, record.token);
    assert.ok(['First', 'Second'].includes(edited.values[fields.title.id].value));
    const initialHistory = (
      await service.history(workspace.id, workspace.userId, { tableId: tickets.id, recordId: record.id })
    ).find(entry => entry.operation === 'create');
    const editHistory = (
      await service.history(workspace.id, workspace.userId, { tableId: tickets.id, recordId: record.id })
    ).find(entry => entry.operation === 'update');
    assert.equal(editHistory.before_values[fields.title.id].value, 'Broken printer');
    assert.equal(editHistory.values[fields.title.id].value, edited.values[fields.title.id].value);
    const restored = await service.mutate(workspace.id, workspace.userId, {
      kind: 'restore',
      tableId: tickets.id,
      revision,
      recordId: record.id,
      expectedToken: edited.token,
      historyId: initialHistory.id,
    });
    assert.equal((await read()).values[fields.title.id].value, 'Broken printer');
    await assert.rejects(
      service.mutate(workspace.id, workspace.userId, {
        kind: 'restore',
        tableId: tickets.id,
        revision,
        recordId: record.id,
        expectedToken: edited.token,
        historyId: initialHistory.id,
      }),
      /stale-record/,
    );
    const deleted = await service.mutate(workspace.id, workspace.userId, {
      kind: 'delete',
      tableId: tickets.id,
      revision,
      recordId: record.id,
      expectedToken: restored.token,
    });
    assert.equal(await read(), null);
    assert.deepEqual(
      (
        await service.reverse(workspace.id, workspace.userId, {
          tableId: customers.id,
          recordId: customer.id,
          fieldId: reverseField,
        })
      ).recordIds,
      [],
    );
    const recovered = await service.mutate(workspace.id, workspace.userId, {
      kind: 'restore',
      tableId: tickets.id,
      revision,
      recordId: record.id,
      expectedToken: deleted.token,
      historyId: initialHistory.id,
    });
    assert.equal(recovered.values[fields.title.id].value, 'Broken printer');
    assert.equal((await read()).id, record.id);
    await db.platform.query(
      `UPDATE ${s}.tf_table_row_history SET recoverable_until=now()-interval '1 second' WHERE id=$1`,
      [initialHistory.id],
    );
    await assert.rejects(
      service.mutate(workspace.id, workspace.userId, {
        kind: 'restore',
        tableId: tickets.id,
        revision,
        recordId: record.id,
        expectedToken: recovered.token,
        historyId: initialHistory.id,
      }),
      /recovery-expired/,
    );
    const holder = randomUUID();
    await maintenance(tx =>
      tx.client.query(`INSERT INTO ${s}.tf_table_history_holds(history_id,holder_id) VALUES($1,$2)`, [
        initialHistory.id,
        holder,
      ]),
    );
    assert.equal(await maintenance(tx => pruneHistoryValues(tx)), 0);
    await maintenance(tx => tx.client.query(`DELETE FROM ${s}.tf_table_history_holds WHERE holder_id=$1`, [holder]));
    assert.equal(await maintenance(tx => pruneHistoryValues(tx)), 1);
    const audit = (
      await raw.query(`SELECT actor,operation,field_ids,outcome,values FROM ${s}.tf_table_row_history WHERE id=$1`, [
        initialHistory.id,
      ])
    ).rows[0];
    assert.equal(audit.actor.userId, workspace.userId);
    assert.equal(audit.operation, 'create');
    assert.equal(audit.outcome, 'applied');
    assert.equal(audit.values, null);
    assert.ok(audit.field_ids.includes(fields.title.id));
    await denied(raw, `UPDATE ${s}.tf_table_generations SET state='retired'`);
    await denied(raw, `DELETE FROM ${s}.tf_table_row_history`);
    await denied(raw, `UPDATE ${s}.tf_table_row_history SET values=NULL`);
    const next = await maintenance(tx => createGeneration(tx, { definition: customers, revision: '2'.repeat(40) }));
    await denied(raw, `INSERT INTO ${s}."${next.physical_table}"(id,token) VALUES($1,$2)`, [
      randomUUID(),
      randomUUID(),
    ]);
    await assert.rejects(
      maintenance(tx =>
        activateGeneration(tx, { generationId: next.id, expectedActiveGenerationId: customerGeneration.id }),
      ),
      /stale-record/,
    );
    await maintenance(tx =>
      writeGenerationRecord(tx, {
        generationId: next.id,
        recordId: customer.id,
        token: customer.token,
        values: customer.values,
      }),
    );
    await maintenance(tx =>
      activateGeneration(tx, { generationId: next.id, expectedActiveGenerationId: customerGeneration.id }),
    );
    await denied(raw, `UPDATE ${s}."${customerGeneration.physical_table}" SET token=$1`, [randomUUID()]);
    const newCustomer = await service.read(workspace.id, workspace.userId, {
      tableId: customers.id,
      revision: '2'.repeat(40),
      recordId: customer.id,
    });
    assert.equal(newCustomer.values[customers.fields[0].id].value, 'Acme');
    await assert.rejects(
      service.read(workspace.id, workspace.userId, { tableId: customers.id, revision, recordId: customer.id }),
      /stale-generation/,
    );
    await runtime.transaction(workspace.id, { minimum: migrations.length, maximum: migrations.length }, async tx => {
      await generationProposalData.lock(tx, [tickets.id]);
      assert.equal((await generationProposalData.definition(tx, tickets.id)).definition.label, 'Tickets');
      assert.equal(
        (await generationProposalData.records(tx, tickets.id, null, [record.id]))[0].values[fields.title.id].value,
        'Broken printer',
      );
    });
    const many = field('relationship', {
      targetTableId: tickets.id,
      cardinality: 'many',
      inverseCardinality: 'many',
      reverse: { fieldId: randomUUID(), label: 'Groups' },
      onDelete: 'restrict',
    });
    const oneToMany = field('relationship', {
      targetTableId: tickets.id,
      cardinality: 'one',
      inverseCardinality: 'many',
      reverse: null,
      onDelete: 'restrict',
    });
    const manyToOne = field('relationship', {
      targetTableId: tickets.id,
      cardinality: 'many',
      inverseCardinality: 'one',
      reverse: { fieldId: randomUUID(), label: 'Assignment' },
      onDelete: 'restrict',
    });
    const singleFile = field('file', { cardinality: 'one', access: 'independent' });
    const groups = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Groups',
      fields: [many, oneToMany, manyToOne, singleFile],
      uniqueKeys: [],
    };
    await maintenance(async tx => {
      const g = await createGeneration(tx, { definition: groups, revision });
      await activateGeneration(tx, { generationId: g.id, expectedActiveGenerationId: null });
    });
    const group1 = await create(groups, {
      [many.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [record.id] },
      [oneToMany.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [record.id] },
      [manyToOne.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [record.id] },
      [singleFile.id]: { kind: 'file', fileIds: [file] },
    });
    const group2 = await create(groups, {
      [many.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [record.id] },
      [oneToMany.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [record.id] },
    });
    assert.deepEqual(
      (
        await service.reverse(workspace.id, workspace.userId, {
          tableId: tickets.id,
          recordId: record.id,
          fieldId: many.reverse.fieldId,
        })
      ).recordIds,
      [group1.id, group2.id].sort(),
    );
    assert.deepEqual(
      (await service.read(workspace.id, workspace.userId, { tableId: groups.id, recordId: group1.id, revision }))
        .values[singleFile.id],
      { kind: 'file', fileIds: [file] },
    );
    await assert.rejects(
      create(groups, { [manyToOne.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [record.id] } }),
      error => error.code === '23505',
    );
    await assert.rejects(
      create(groups, { [many.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [randomUUID()] } }),
      /linked-record/,
    );
    await assert.rejects(
      create(groups, {
        [oneToMany.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [record.id, randomUUID()] },
      }),
      /Single reference/,
    );
    const duplicateDefinition = { ...groups, id: randomUUID() };
    await assert.rejects(
      maintenance(async tx => {
        const g = await createGeneration(tx, { definition: duplicateDefinition, revision });
        await activateGeneration(tx, { generationId: g.id, expectedActiveGenerationId: null });
      }),
      error => error.code === '23505',
    );
    const createRaceId = randomUUID();
    const createRace = await Promise.allSettled([create(tickets, {}, createRaceId), create(tickets, {}, createRaceId)]);
    assert.equal(createRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(createRace.find(result => result.status === 'rejected').reason.code, 'stale-record');
    const uniqueRace = await Promise.allSettled(
      [1, 2].map(() =>
        create(tickets, {
          [fields.title.id]: { kind: 'text', value: 'Concurrent unique' },
          [fields.amount.id]: { kind: 'numeric', value: '99' },
        }),
      ),
    );
    assert.equal(uniqueRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(uniqueRace.find(result => result.status === 'rejected').reason.code, 'duplicate-key');
    for (let index = 0; index < 10; index++) {
      const target = await create(tickets, {});
      const raced = await Promise.allSettled([
        create(groups, { [many.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [target.id] } }),
        service.mutate(workspace.id, workspace.userId, {
          kind: 'delete',
          tableId: tickets.id,
          recordId: target.id,
          revision,
          expectedToken: target.token,
        }),
      ]);
      assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(raced.find(result => result.status === 'rejected').reason.code, 'linked-record');
      const invariant = await raw.query(
        `SELECT count(*)::int AS invalid FROM ${s}.tf_table_links l LEFT JOIN ${s}.tf_table_identities i ON i.table_id=l.target_table AND i.row_id=l.target_row AND i.live WHERE i.row_id IS NULL`,
      );
      assert.equal(invariant.rows[0].invalid, 0);
    }
    const source = await create(tickets, {});
    const peer = await create(tickets, {});
    const firstGroup = await create(groups, {
      [many.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [source.id] },
    });
    const secondGroup = await create(groups, {
      [many.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [peer.id] },
    });
    const switched = await Promise.all([
      service.mutate(workspace.id, workspace.userId, {
        kind: 'update',
        tableId: groups.id,
        recordId: firstGroup.id,
        revision,
        expectedToken: firstGroup.token,
        values: { [many.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [peer.id] } },
      }),
      service.mutate(workspace.id, workspace.userId, {
        kind: 'update',
        tableId: groups.id,
        recordId: secondGroup.id,
        revision,
        expectedToken: secondGroup.token,
        values: { [many.id]: { kind: 'relationship', tableId: tickets.id, recordIds: [source.id] } },
      }),
    ]);
    assert.deepEqual(
      switched.map(row => row.values[many.id].recordIds),
      [[peer.id], [source.id]],
    );
    t.diagnostic(`Applied ${migrations.length} common migrations on PostgreSQL 55483`);
  },
);
