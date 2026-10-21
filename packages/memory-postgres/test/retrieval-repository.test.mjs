import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresRetrievalRepository } from '../dist/index.js';

for (const [name, values, marker] of [
  ['anchors', [['publication'], [0], ['note'], [], []], 'ORDER BY a.position'],
  ['passages', [['publication'], [0], 8000, 32, ['excluded:1']], 'selected_priority<=$4'],
]) {
  test(`retrieval ${name} preserves client receiver, bound values, promise, and configured identifiers`, async () => {
    const response = { rows: [], rowCount: 0 };
    const promise = Promise.resolve(response);
    const client = {
      query(sql, input) {
        assert.equal(this, client);
        assert.equal(input, values);
        assert.ok(sql.includes(marker));
        assert.ok(sql.includes('"tenant""quoted"."reference_chunks"'));
        assert.ok(!sql.includes('"tf_knowledge_'));
        return promise;
      },
    };
    const repository = createPostgresRetrievalRepository(client, {
      schema: 'tenant"quoted',
      tablePrefix: 'reference_',
    });
    assert.equal(repository[name](values), promise);
    assert.equal(await promise, response);
  });
}
