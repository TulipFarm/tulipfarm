import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresRetrievalRepository } from '../dist/index.js';

for (const [name, values] of [
  ['anchors', [['publication'], [0], ['note'], [], []]],
  ['passages', [['publication'], [0], 8000, 32, ['excluded:1']]],
]) {
  test(`retrieval ${name} binds values and reads the configured tables`, async () => {
    const response = { rows: [], rowCount: 0 };
    const client = {
      async query(sql, input) {
        assert.deepEqual(input, values);
        assert.ok(sql.includes('"tenant""quoted"."reference_chunks"'));
        assert.ok(!sql.includes('"tf_knowledge_'));
        return response;
      },
    };
    const repository = createPostgresRetrievalRepository(client, {
      schema: 'tenant"quoted',
      tablePrefix: 'reference_',
    });
    assert.equal(await repository[name](values), response);
  });
}
