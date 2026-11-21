import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPostgresKnowledgeRepository,
  createPostgresSearchSessions,
  createPostgresEmbeddingRepository,
  createPostgresLexicalIndex,
  createPostgresVectorIndex,
} from '../dist/index.js';

const factories = [
  createPostgresKnowledgeRepository,
  createPostgresSearchSessions,
  createPostgresEmbeddingRepository,
  createPostgresLexicalIndex,
  createPostgresVectorIndex,
];

for (const factory of factories) {
  test(`${factory.name} binds values and quotes configured names while returning results and errors`, async () => {
    const calls = [];
    const response = { rows: [{ retained: true }], rowCount: 1 };
    const failure = new Error('storage unavailable');
    let reject = false;
    const client = {
      async query(sql, values) {
        calls.push({ sql, values });
        if (reject) throw failure;
        return response;
      },
    };
    const repository = factory(
      client,
      { schema: 'tenant."one', tablePrefix: 'memory."_' },
      factory === createPostgresEmbeddingRepository ? { activeProfile: true } : () => 'eligible_scope',
    );
    const values = ["bound-value-' OR TRUE --"];
    for (const [method, operation] of Object.entries(repository)) {
      const extra =
        method === 'match'
          ? { broaden: false, publicationCount: 200 }
          : method === 'nearest'
            ? false
            : method === 'recordFailure'
              ? 'embedding'
              : undefined;
      assert.equal(await operation(values, extra), response);
      const call = calls.at(-1);
      assert.ok(!call.sql.includes(values[0]), method);
      if (operation.length > 0) assert.equal(call.values, values, method);
      else assert.equal(call.values, undefined, method);
      assert.ok(!call.sql.includes('tf_knowledge_'), method);
      if (!['currentTime', 'configureNearest'].includes(method))
        assert.ok(call.sql.includes('"tenant.""one"."memory.""_'), method);
      reject = true;
      await assert.rejects(operation(values, extra), error => error === failure);
      reject = false;
    }
  });
}
