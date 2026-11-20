import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPostgresMemoryRepository,
  createPostgresMemoryReconciliationRepository,
  createPostgresTranscriptSource,
} from '../dist/index.js';

for (const factory of [
  createPostgresMemoryRepository,
  createPostgresMemoryReconciliationRepository,
  createPostgresTranscriptSource,
]) {
  test(`${factory.name} binds values, returns results and errors, and quotes tenant identifiers`, async () => {
    const response = { rows: [], rowCount: 0 };
    const failure = new Error('storage failure');
    let reject = false;
    const client = {
      async query(sql, values) {
        assert.deepEqual(values, bound);
        assert.ok(sql.includes('"tenant.""one"."prefix.""_'));
        assert.ok(!sql.includes(bound[0]));
        if (reject) throw failure;
        return response;
      },
    };
    const bound = ["bound-' OR TRUE --"];
    const repository = factory(client, { schema: 'tenant."one', tablePrefix: 'prefix."_' });
    for (const operation of Object.values(repository)) {
      assert.equal(await operation(bound), response);
      reject = true;
      await assert.rejects(operation(bound), error => error === failure);
      reject = false;
    }
  });
}
