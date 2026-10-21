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
  test(`${factory.name} binds values and quotes configured names without changing results or errors`, async () => {
    const calls = [];
    const response = { rows: [{ retained: true }], rowCount: 1 };
    const failure = new Error('storage unavailable');
    let reject = false;
    const client = {
      async query(sql, values) {
        assert.equal(this, client);
        calls.push({ sql, values });
        if (reject) throw failure;
        return response;
      },
    };
    const repository = factory(client, { schema: 'tenant."one', tablePrefix: 'memory."_' }, () => 'eligible_scope');
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

test('lexical broadening and the 200-publication cutoff retain their exact query branches', async () => {
  const queries = [];
  const repository = createPostgresLexicalIndex(
    {
      async query(sql) {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    },
    { schema: 'tenant', tablePrefix: 'memory_' },
    () => 'eligible',
  );
  for (const broaden of [false, true])
    for (const publicationCount of [200, 201]) {
      await repository.match(['topic', 'topic:*', false, 'topic', []], { broaden, publicationCount });
      const sql = queries.at(-1);
      assert.equal(sql.includes("websearch_to_tsquery('english',$1)"), !broaden);
      assert.equal(sql.includes('string_agg(quote_literal(lexeme)'), broaden);
      assert.equal(sql.includes('LIMIT 200'), publicationCount > 200);
    }
});

test('vector exact and ANN queries preserve distance operator, ordering, dimension, and exclusion', async () => {
  const queries = [];
  const index = createPostgresVectorIndex(
    {
      async query(sql) {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    },
    { schema: 'tenant', tablePrefix: 'memory_' },
    () => 'eligible',
  );
  await index.nearest(['profile', [], '[1]'], true);
  assert.match(queries.at(-1), /DISTINCT ON \(lexical_publication_id\)/);
  assert.ok(!queries.at(-1).includes('LIMIT 2000'));
  await index.configureNearest();
  assert.match(queries.at(-1), /hnsw\.iterative_scan','strict_order'/);
  await index.nearest(['profile', [], '[1]', []], false);
  assert.match(queries.at(-1), /NOT\(lexical_publication_id=ANY\(\$4::uuid\[\]\)\)/);
  assert.match(queries.at(-1), /OPERATOR\(extensions\.<=>\) \$3::extensions\.vector\(1536\) LIMIT 2000/);
});

test('work failure axes retain their separate updates and original attempt ceiling', async () => {
  const queries = [];
  const repository = createPostgresKnowledgeRepository(
    {
      async query(sql) {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    },
    { schema: 'tenant', tablePrefix: 'memory_' },
  );
  await repository.recordFailure(['revision', 'failed', 'provider'], 'embedding');
  assert.match(queries.at(-1), /SET embedding=\$2,failure=\$3,attempts=attempts\+1/);
  await repository.recordFailure(['revision', 'failed', 'malformed'], 'parsing');
  assert.match(queries.at(-1), /parsing=CASE WHEN parsing='ocr-unavailable'/);
  assert.ok(queries.every(sql => sql.includes('attempts<8')));
});
