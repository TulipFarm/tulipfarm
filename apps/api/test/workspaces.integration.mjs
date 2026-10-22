import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';

test('workspace routes fail closed until isolated storage is configured', async () => {
  const app = buildApp();
  try {
    for (const url of [
      '/v1/workspaces',
      '/v1/workspaces/acme',
      '/v1/workspace-setups/00000000-0000-4000-8000-000000000001',
    ]) {
      const response = await app.inject(url);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: 'Workspace storage is unavailable' });
    }
  } finally {
    await app.close();
  }
});
