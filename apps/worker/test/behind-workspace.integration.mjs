import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestFixture } from '../../../packages/conversations/test/request-fixture.mjs';
import { createSecretsSweep } from '../src/secrets-sweep.ts';

const env = {
  INTEGRATION_CREDENTIAL_KEY_ID: 'test',
  INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
};

// A release starts its jobs before workspace-rollout migrates every workspace; until then the sweep passes over it.
test('the secrets sweep skips a workspace still waiting for the secrets migration', { timeout: 60000 }, async t => {
  const f = await requestFixture(stream => stream.filter(migration => migration.name < '0032'));
  t.after(() => f.close());
  const failures = [];
  const sweep = createSecretsSweep(f.runtime, async after => (after ? [] : [f.workspace.id]), env);
  await sweep((workspaceId, error) => failures.push({ workspaceId, error }));
  assert.deepEqual(failures, []);
});
