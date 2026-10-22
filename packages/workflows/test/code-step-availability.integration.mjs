import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

test('code steps cannot be saved or activated without a configured runner', { timeout: 60000 }, async () => {
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
    const withoutRunner = createWorkflows(runtime),
      withRunner = createWorkflows(runtime, { codeSteps: true });
    const code = {
      version: 1,
      name: 'Arithmetic',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'javascript_total',
          kind: 'code',
          language: 'javascript',
          source: 'return {amount: input.amount + 2};',
          input: { kind: 'input', path: [] },
        },
      ],
    };
    const plain = {
      ...code,
      name: 'Copy',
      steps: [{ id: 'copy', kind: 'transform', fields: { amount: { kind: 'input', path: ['amount'] } } }],
    };

    const rejected = randomUUID();
    await assert.rejects(
      withoutRunner.save(w.id, w.userId, rejected, {
        revision: randomUUID(),
        expectedRevision: null,
        definition: code,
      }),
      { message: 'code-steps-unavailable' },
    );
    assert.deepEqual(await withoutRunner.list(w.id, w.userId), []);

    const plainId = randomUUID(),
      plainRevision = randomUUID();
    await withoutRunner.save(w.id, w.userId, plainId, {
      revision: plainRevision,
      expectedRevision: null,
      definition: plain,
    });
    assert.equal((await activate(withoutRunner, w.id, w.userId, plainId, plainRevision, true)).enabled, true);

    const saved = randomUUID(),
      revision = randomUUID();
    await withRunner.save(w.id, w.userId, saved, { revision, expectedRevision: null, definition: code });
    assert.equal(
      (await withoutRunner.save(w.id, w.userId, saved, { revision, expectedRevision: null, definition: code }))
        .revision,
      revision,
      'replaying a stored revision still succeeds',
    );
    await assert.rejects(
      withoutRunner.save(w.id, w.userId, saved, {
        revision: randomUUID(),
        expectedRevision: revision,
        definition: { ...code, name: 'Edited' },
      }),
      { message: 'code-steps-unavailable' },
    );
    await assert.rejects(activate(withoutRunner, w.id, w.userId, saved, revision, true), {
      message: 'code-steps-unavailable',
    });
    const blocked = (await withoutRunner.list(w.id, w.userId)).find(item => item.id === saved);
    assert.equal(blocked.enabled, false);
    assert.equal(blocked.activeRevision, null);

    assert.equal((await activate(withRunner, w.id, w.userId, saved, revision, true)).enabled, true);
    assert.equal((await activate(withoutRunner, w.id, w.userId, saved, revision, false)).enabled, false);
  } finally {
    await runtime?.close();
    await db.close();
  }
});
