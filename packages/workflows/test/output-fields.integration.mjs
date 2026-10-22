import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows } from '../src/service.ts';
import { definitionSchema } from '../src/contracts.ts';

test(
  'save checks live table output fields without persisting invalid paths or changing historical reads and authority',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime, migration;
    t.after(async () => {
      await migration?.end();
      await runtime?.close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    const table = name => qualified(w.names.schema, name);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    migration = await connect(db.login(w, 'migration'));
    const team = randomUUID(),
      outsider = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_teams')}(id,name) VALUES($1,'Sales')`, [team]);
    await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
      outsider.membershipId,
      outsider.userId,
    ]);
    const amount = {
      id: randomUUID(),
      label: 'Invoice total',
      required: false,
      kind: 'numeric',
      precision: 10,
      scale: 2,
    };
    const file = {
      id: randomUUID(),
      label: 'Contract',
      required: false,
      kind: 'file',
      cardinality: 'one',
      access: 'independent',
    };
    const choice = {
      id: randomUUID(),
      label: 'Status',
      required: false,
      kind: 'single-select',
      options: [{ id: randomUUID(), label: 'Open', retired: false }],
    };
    const schema = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Invoices',
      fields: [amount, file, choice],
      uniqueKeys: [],
    };
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      const tx = { client, schema: w.names.schema };
      const generation = await createGeneration(tx, { definition: schema, revision: '1'.repeat(40) });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
    });
    const service = createWorkflows(runtime);
    const definition = path => ({
      version: 1,
      name: 'Check live output fields',
      trigger: { kind: 'manual' },
      steps: [
        { id: 'find', kind: 'find-rows', tableId: schema.id, filters: [], limit: 5 },
        { id: 'copy', kind: 'transform', fields: { value: { kind: 'step', step: 'find', path } } },
      ],
    });
    const save = (path, id = randomUUID(), userId = w.userId) =>
      service.save(w.id, userId, id, { revision: randomUUID(), expectedRevision: null, definition: definition(path) });
    const missing = randomUUID();
    for (const path of [
      ['rows', '0', 'values', missing],
      ['rows', '0', 'values', file.id],
      ['rows', '0', 'values', choice.id, 'value'],
      ['rows', '0', 'values', amount.id, 'value', 'nested'],
    ]) {
      const rejectedId = randomUUID();
      assert.equal(definitionSchema.safeParse(definition(path)).success, true);
      await assert.rejects(
        save(path, rejectedId),
        error =>
          error.name === 'ZodError' &&
          error.issues.some(
            issue =>
              issue.message.includes('copy') && issue.message.includes('find') && issue.message.includes(path[3]),
          ),
      );
      assert.equal(
        (
          await db.platform.query(`SELECT count(*)::integer AS count FROM ${table('tf_workflows')} WHERE id=$1`, [
            rejectedId,
          ])
        ).rows[0].count,
        0,
      );
      await assert.rejects(
        service.checkTableSteps(w.id, w.userId, definition(path)),
        error => error.name === 'ZodError',
        'chat authoring gets the same live field check',
      );
    }
    const validPath = ['rows', '0', 'values', amount.id, 'value'];
    const saved = await save(validPath);
    assert.deepEqual(saved.definition.steps[1].fields.value.path, validPath);
    await assert.rejects(save(validPath, randomUUID(), outsider.userId), AccessDenied);
    await assert.rejects(
      save(['rows', '0', 'values', missing], randomUUID(), outsider.userId),
      AccessDenied,
      'field details are not disclosed before permission checks',
    );
    await db.platform.query(
      `UPDATE ${table('tf_workflow_revisions')} SET definition=$3 WHERE workflow_id=$1 AND id=$2`,
      [saved.id, saved.revision, JSON.stringify(definition(['rows', '0', 'values', missing]))],
    );
    const historical = (await service.list(w.id, w.userId)).find(item => item.id === saved.id);
    assert.deepEqual(
      historical.definition.steps[1].fields.value.path,
      ['rows', '0', 'values', missing],
      'existing definitions remain readable',
    );
  },
);
