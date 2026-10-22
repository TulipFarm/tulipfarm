import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceNames, tableTableName } from '../src/names.ts';
import { createWorkspaceRuntime } from '../src/runtime.ts';

test('generated names use immutable validated UUIDs and reserve platform identifiers', () => {
  assert.deepEqual(workspaceNames('A477EC38-48DD-478C-A55F-01296E523A24'), {
    workspaceId: 'a477ec38-48dd-478c-a55f-01296e523a24',
    schema: 'ws_a477ec3848dd478ca55f01296e523a24',
    runtime: 'ws_a477ec3848dd478ca55f01296e523a24_runtime',
    migration: 'ws_a477ec3848dd478ca55f01296e523a24_migration',
    confirmation: 'ws_a477ec3848dd478ca55f01296e523a24_confirmation',
    customOwner: 'ws_a477ec3848dd478ca55f01296e523a24_owner',
  });
  for (const input of ['a"; DROP SCHEMA app; --', '../app', 'tf_memberships', 'pg_class', 'x'.repeat(49)])
    assert.throws(() => tableTableName(input));
  assert.throws(() => workspaceNames('x; DROP DATABASE postgres'));
  assert.equal(tableTableName('invoices_2026'), 'invoices_2026');
});

test('replica connection budget includes reserved identity and maintenance connections', () => {
  assert.throws(
    () =>
      createWorkspaceRuntime({
        replicaCount: 3,
        reservedConnections: 10,
        databaseConnectionBudget: 20,
        resolveCredential: async () => {
          throw new Error('unused');
        },
      }),
    /budget/,
  );
});
