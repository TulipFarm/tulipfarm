import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';

test('synthetic pgvector cosine ANN recall against exact authorized subsets', { timeout: 120000 }, async t => {
  const db = await fixture();
  try {
    await db.databaseAdmin.query(
      'CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions',
    );
    await db.databaseAdmin.query(
      'CREATE TABLE public.ann_evaluation (id integer PRIMARY KEY, principal integer NOT NULL, embedding extensions.vector(1536) NOT NULL)',
    );
    await db.databaseAdmin.query(`INSERT INTO public.ann_evaluation SELECT i,i%100,
      ARRAY(SELECT sin(i * (d+1) * 0.731)::real FROM generate_series(1,1536) d)::extensions.vector(1536)
      FROM generate_series(1,4000) i`);
    await db.databaseAdmin.query(
      'CREATE INDEX ann_evaluation_hnsw ON public.ann_evaluation USING hnsw (embedding extensions.vector_cosine_ops)',
    );
    await db.databaseAdmin.query('ANALYZE public.ann_evaluation');
    for (const selectivity of [100, 10, 1]) {
      let recalled = 0;
      let strategyRecalled = 0;
      for (const id of [103, 1207, 2501, 3901]) {
        const query = (
          await db.databaseAdmin.query('SELECT embedding::text FROM public.ann_evaluation WHERE id=$1', [id])
        ).rows[0].embedding;
        await db.databaseAdmin.query('BEGIN');
        try {
          await db.databaseAdmin.query(
            "SET LOCAL hnsw.iterative_scan='strict_order'; SET LOCAL hnsw.ef_search=200; SET LOCAL hnsw.max_scan_tuples=20000; SET LOCAL enable_seqscan=off",
          );
          const sql =
            'SELECT id FROM public.ann_evaluation WHERE principal<$1 ORDER BY embedding OPERATOR(extensions.<=>) $2::extensions.vector(1536) LIMIT 20';
          const plan = await db.databaseAdmin.query(`EXPLAIN (FORMAT JSON) ${sql}`, [selectivity, query]);
          assert.match(JSON.stringify(plan.rows), /ann_evaluation_hnsw/);
          const approximate = (await db.databaseAdmin.query(sql, [selectivity, query])).rows.map(row => row.id);
          await db.databaseAdmin.query('SET LOCAL enable_indexscan=off; SET LOCAL enable_seqscan=on');
          const exact = (await db.databaseAdmin.query(sql, [selectivity, query])).rows.map(row => row.id);
          const overlap = approximate.filter(candidate => exact.includes(candidate)).length;
          assert.equal(exact.length, 20);
          assert.ok(approximate.every(candidate => candidate % 100 < selectivity));
          recalled += overlap;
          if ((4000 * selectivity) / 100 <= 2048) {
            const selected = (
              await db.databaseAdmin.query(
                `WITH eligible AS MATERIALIZED (SELECT * FROM public.ann_evaluation WHERE principal<$1)
              SELECT id FROM eligible ORDER BY embedding OPERATOR(extensions.<=>) $2::extensions.vector(1536) LIMIT 20`,
                [selectivity, query],
              )
            ).rows.map(row => row.id);
            assert.deepEqual(selected, exact);
            strategyRecalled += selected.filter(candidate => exact.includes(candidate)).length;
          } else strategyRecalled += overlap;
        } finally {
          await db.databaseAdmin.query('ROLLBACK');
        }
      }
      const recall = recalled / 80;
      t.diagnostic(`1536-dimensional synthetic cosine recall@20, ${selectivity}% eligible, four queries: ${recall}`);
      t.diagnostic(`Serving strategy recall@20 with exact search at <=2048 eligible chunks: ${strategyRecalled / 80}`);
      assert.ok(
        strategyRecalled / 80 >= 0.95,
        `Serving recall ${strategyRecalled / 80} below .95 for ${selectivity}% eligible`,
      );
    }
    await db.databaseAdmin.query(
      'CREATE TABLE public.halfvec_mechanics (id integer PRIMARY KEY, embedding extensions.halfvec(3072))',
    );
    await db.databaseAdmin.query(
      `INSERT INTO public.halfvec_mechanics VALUES (1,ARRAY(SELECT 0.125::real FROM generate_series(1,3072))::extensions.halfvec(3072))`,
    );
    await db.databaseAdmin.query(
      'CREATE INDEX halfvec_mechanics_hnsw ON public.halfvec_mechanics USING hnsw (embedding extensions.halfvec_cosine_ops)',
    );
    assert.equal(
      (
        await db.databaseAdmin.query(
          'SELECT extensions.vector_dims(embedding) AS dimensions FROM public.halfvec_mechanics',
        )
      ).rows[0].dimensions,
      3072,
    );
    t.diagnostic(
      '3072 halfvec type/index mechanics only. No actual 3072 Azure profile comparison or representative human relevance judgments. These synthetic results do not select a release profile.',
    );
  } finally {
    await db.close();
  }
});
