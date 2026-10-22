import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createFiles } from '@tulipfarm/files';
import { createKnowledgeEmbeddings, createKnowledgeSearch, createLocalKnowledge } from '../dist/index.js';

function nodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test('search bounds lexical transfer and page authorization without changing the ranked window', async t => {
  const db = await fixture();
  let runtime, search;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const ws = await db.create(await workspaceTableMigrations());
    const table = name => qualified(ws.names.schema, `tf_knowledge_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 1,
      connectionsPerPool: 2,
      reservedConnections: 2,
      databaseConnectionBudget: 10,
      resolveCredential: async id => {
        assert.equal(id, ws.id);
        return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
      },
    });
    const local = createLocalKnowledge({
      runtime,
      files: createFiles(runtime, {
        putIfAbsent: async () => {},
        read: async () => {
          throw new Error('No file fixture');
        },
      }),
    });
    const seed = await local.save(ws.id, ws.userId, {
      commandId: randomUUID(),
      documentId: randomUUID(),
      expectedRevisionId: null,
      title: 'Scaling',
      input: { kind: 'note', text: 'scalingneedle' },
    });
    for (const work of await local.due(ws.id)) await local.process(work);
    await db.platform.query(`CREATE TEMP TABLE search_documents AS
      SELECT i,gen_random_uuid() AS id,gen_random_uuid() AS revision_id,gen_random_uuid() AS publication_id
      FROM generate_series(1,300) i`);
    await db.platform.query(
      `INSERT INTO ${table('documents')} (id,source_id,native_id)
      SELECT b.id,d.source_id,b.id::text FROM search_documents b CROSS JOIN ${table('documents')} d WHERE d.id=$1`,
      [seed.documentId],
    );
    await db.platform.query(
      `INSERT INTO ${table('revisions')} (id,document_id,source_revision,title,original,original_bytes,parser_profile,sources,fingerprint)
      SELECT b.revision_id,b.id,b.revision_id::text,'Scaling',r.original||jsonb_build_object('key',b.revision_id::text),
        r.original_bytes,r.parser_profile,'[]',repeat(md5(b.i::text),2)
      FROM search_documents b CROSS JOIN ${table('revisions')} r WHERE r.id=$1`,
      [seed.revisionId],
    );
    await db.platform.query(
      `INSERT INTO ${table('local_revisions')} (revision_id,owner_membership_id,owner_user_id,filename,media_type,command_fingerprint)
      SELECT revision_id,$1,$2,'scaling.txt','text/plain',repeat(md5(i::text),2) FROM search_documents`,
      [ws.membershipId, ws.userId],
    );
    await db.platform
      .query(`INSERT INTO ${table('publications')} (id,document_id,revision_id,markdown,pages,tokens,chunk_count,fingerprint)
      SELECT publication_id,id,revision_id,'scalingneedle',0,3,3,repeat(md5(i::text),2) FROM search_documents`);
    await db.platform
      .query(`INSERT INTO ${table('chunks')} (publication_id,ordinal,heading,passage,tokens,source_offset,input_hash,search_title)
      SELECT b.publication_id,n,'',repeat('scalingneedle ',CASE WHEN n=0 THEN 1 ELSE 3 END)
        ||CASE WHEN b.i=300 THEN ' /ops/scalingneedle.md' ELSE '' END,1,'{"kind":"passage"}',repeat(md5(b.i::text),2),'Scaling'
      FROM search_documents b CROSS JOIN generate_series(0,2) n`);
    await db.platform
      .query(`UPDATE ${table('documents')} d SET observed_revision_id=b.revision_id,lexical_publication_id=b.publication_id
      FROM search_documents b WHERE d.id=b.id`);
    for (const name of ['documents', 'sources', 'local_revisions', 'revisions', 'publications', 'chunks'])
      await db.platform.query(`ANALYZE ${table(name)}`);
    const transfers = [],
      pagePlans = [];
    const observed = {
      transaction: (id, compatibility, operation) =>
        runtime.transaction(id, compatibility, tx =>
          operation({
            ...tx,
            client: {
              query: async (...args) => {
                const result = await tx.client.query(...args);
                if (args[0].includes('SELECT DISTINCT ON (publication_id)')) transfers.push(result.rowCount);
                if (args[0].includes('jsonb_array_elements($6::jsonb)')) {
                  const explain = await tx.client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${args[0]}`, args[1]);
                  const eligible = nodes(explain.rows[0]['QUERY PLAN'][0].Plan).find(
                    node => node['Subplan Name'] === 'CTE eligible',
                  );
                  assert.ok(eligible, 'The page plan must expose its materialized eligibility work');
                  pagePlans.push(eligible['Actual Rows']);
                }
                return result;
              },
            },
          }),
        ),
    };
    search = createKnowledgeSearch({
      runtime: observed,
      embeddings: createKnowledgeEmbeddings({ runtime, config: { kind: 'disabled' } }),
    });
    for (const query of ['scalingneedle', '/ops/scalingneedle.md']) {
      const rows = (
        await db.platform.query(
          `WITH matches AS (
        SELECT k.publication_id,k.ordinal,k.identifiers @> ARRAY[$1]::text[] AS exact,
          ts_rank_cd(k.search_vector,websearch_to_tsquery('english',$1)) AS rank
        FROM ${table('chunks')} k WHERE k.search_vector @@ websearch_to_tsquery('english',$1) OR k.identifiers @> ARRAY[$1]::text[])
        SELECT best.*,p.document_id FROM
          (SELECT DISTINCT ON (publication_id) * FROM matches ORDER BY publication_id,exact DESC,rank DESC,ordinal) best
        JOIN ${table('publications')} p ON p.id=best.publication_id`,
          [query],
        )
      ).rows;
      const expected = rows
        .sort(
          (a, b) =>
            Number(b.exact) - Number(a.exact) ||
            b.rank - a.rank ||
            (a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : a.ordinal - b.ordinal),
        )
        .slice(0, 100);
      const commandId = randomUUID();
      const first = await search.search(ws.id, ws.userId, { kind: 'submitted', commandId, query });
      const stored = (
        await db.platform.query(`SELECT candidates FROM ${table('search_sessions')} WHERE id=$1`, [commandId])
      ).rows[0].candidates;
      assert.deepEqual(
        stored.map(row => [row.document_id, row.ordinal, row.exact]),
        expected.map(row => [row.document_id, row.ordinal, row.exact]),
      );
      const hits = [...first.hits];
      let continuation = first.continuation;
      while (continuation) {
        const next = await search.search(ws.id, ws.userId, { kind: 'continue', continuation });
        hits.push(...next.hits);
        continuation = next.continuation;
      }
      assert.deepEqual(
        hits.map(hit => hit.citation.documentId),
        expected.map(row => row.document_id),
      );
      await db.platform.query(`UPDATE ${table('documents')} SET tombstoned_at=clock_timestamp() WHERE id=$1`, [
        expected[0].document_id,
      ]);
      const replay = await search.search(ws.id, ws.userId, { kind: 'submitted', commandId, query });
      assert.ok(replay.hits.every(hit => hit.citation.documentId !== expected[0].document_id));
      await db.platform.query(`UPDATE ${table('documents')} SET tombstoned_at=NULL WHERE id=$1`, [
        expected[0].document_id,
      ]);
    }
    assert.deepEqual((await search.search(ws.id, ws.userId, { kind: 'typing', query: 'absentneedle' })).hits, []);
    const filtered = await search.search(ws.id, ws.userId, {
      kind: 'typing',
      query: 'scalingneedle',
      filters: { documentIds: [seed.documentId] },
    });
    assert.deepEqual(
      filtered.hits.map(hit => hit.citation.documentId),
      [seed.documentId],
    );
    await t.test('at most 200 lexical matches cross the database boundary', () => {
      assert.ok(transfers.length > 0);
      assert.ok(
        transfers.every(count => count <= 200),
        `Returned lexical rows: ${transfers}`,
      );
    });
    await t.test('page authorization evaluates only the frozen candidate window', () => {
      assert.ok(pagePlans.length > 0);
      assert.ok(
        pagePlans.every(count => count <= 100),
        `Materialized eligible rows: ${pagePlans}`,
      );
    });
  } finally {
    await search?.close();
    await runtime?.close();
    await db.close();
  }
});
