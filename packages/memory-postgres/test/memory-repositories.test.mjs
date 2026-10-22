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
  test(`${factory.name} preserves values, results, errors, and tenant identifier quoting`, async () => {
    const response = { rows: [], rowCount: 0 };
    const failure = new Error('storage failure');
    let reject = false;
    const client = {
      async query(sql, values) {
        assert.equal(this, client);
        assert.equal(values, bound);
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

test('requester transcript storage retains every identity, coverage, manual-edit, and internal-publication fence', async () => {
  let query;
  const transcript = createPostgresTranscriptSource(
    {
      async query(sql) {
        query = sql;
        return { rows: [], rowCount: 0 };
      },
    },
    { schema: 'tenant', tablePrefix: 'tf_' },
  );
  await transcript.requesterMessages(['chat', 'member', 4, null, 2]);
  for (const predicate of [
    "m.author_kind='human'",
    'm.membership_id=$2',
    't.accepted_sequence<=$3',
    'generation<$5 AND memory_complete',
    'm.created_at>$4',
    'tf_internal_publications',
    'i.message_id=m.id',
    'ORDER BY m.sequence',
  ])
    assert.ok(query.includes(predicate), predicate);
});
