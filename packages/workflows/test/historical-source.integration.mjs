import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';
import { definitionSchema, saveSchema } from '../src/contracts.ts';
import { activate } from './commands.fixture.mjs';

test('historical Unicode definitions remain readable and revocable while oversized execution fails once', async () => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const service = createWorkflows(runtime, {
      snippets: {
        submit: async () => {
          throw new Error('invalid historical job must not reach broker');
        },
      },
    });
    const id = randomUUID(),
      revision = randomUUID();
    const definition = {
      version: 1,
      name: 'Historical Unicode',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'code',
          kind: 'code',
          language: 'javascript',
          source: 'return input;',
          input: { kind: 'input', path: [] },
        },
      ],
    };
    await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
    await activate(service, w.id, w.userId, id, revision, true);
    const first = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: { retained: true } });
    const source = `/*${'漢'.repeat(20000)}*/return input;`;
    const historical = { ...definition, steps: [{ ...definition.steps[0], source }] };
    assert.equal(definitionSchema.parse(historical).steps[0].source, source);
    assert.equal(saveSchema.safeParse({ revision, expectedRevision: null, definition: historical }).success, false);
    await db.platform.query(
      `UPDATE ${qualified(w.names.schema, 'tf_workflow_revisions')} SET definition=$1 WHERE workflow_id=$2 AND id=$3`,
      [JSON.stringify(historical), id, revision],
    );
    assert.equal((await service.list(w.id, w.userId))[0].definition.steps[0].source, source);
    assert.equal((await service.history(w.id, w.userId, id).then(page => page.runs))[0].status, 'queued');
    assert.deepEqual(await service.advance({ workspaceId: w.id, runId: first.runId }), { kind: 'done' });
    assert.deepEqual(await service.advance({ workspaceId: w.id, runId: first.runId }), { kind: 'done' });
    assert.equal((await service.history(w.id, w.userId, id).then(page => page.runs))[0].error, 'snippet-input-invalid');
    assert.equal((await service.history(w.id, w.userId, id).then(page => page.runs))[0].steps.length, 0);
    const queued = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: null });
    await activate(service, w.id, w.userId, id, revision, false);
    assert.equal((await service.list(w.id, w.userId))[0].enabled, false);
    assert.equal(
      (await service.history(w.id, w.userId, id).then(page => page.runs)).find(run => run.id === queued.runId).status,
      'blocked',
    );
    const healthyId = randomUUID(),
      healthyRevision = randomUUID();
    await service.save(w.id, w.userId, healthyId, {
      revision: healthyRevision,
      expectedRevision: null,
      definition: { ...definition, name: 'Unaffected', steps: [{ id: 'copy', kind: 'transform', fields: {} }] },
    });
    await activate(service, w.id, w.userId, healthyId, healthyRevision, true);
    const healthy = await service.start(w.id, w.userId, healthyId, { requestId: randomUUID(), input: null });
    await service.advance({ workspaceId: w.id, runId: healthy.runId });
    await service.advance({ workspaceId: w.id, runId: healthy.runId });
    assert.equal((await service.history(w.id, w.userId, healthyId).then(page => page.runs))[0].status, 'completed');
    assert.equal((await service.list(w.id, w.userId)).length, 2);
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT definition FROM ${qualified(w.names.schema, 'tf_workflow_revisions')} WHERE workflow_id=$1 AND id=$2`,
          [id, revision],
        )
      ).rows[0].definition,
      historical,
    );
  } finally {
    await runtime?.close();
    await db.close();
  }
});
