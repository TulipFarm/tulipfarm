import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { verifyWorkspaceIsolation } from '@tulipfarm/workspace-storage/provisioning';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';
import { createFiles } from '@tulipfarm/files';
import { createKnowledge, createKnowledgeEmbeddings, createLocalKnowledge } from '../dist/index.js';

test('P3 projects paid P2 results through restricted SQL without provider spend', async t => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const ws = await db.create();
    const table = name => qualified(ws.names.schema, `tf_knowledge_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
    });
    const local = createLocalKnowledge({
      runtime,
      files: createFiles(runtime, {
        putIfAbsent: async () => {},
        read: async () => assert.fail('Unexpected file read'),
      }),
    });
    const save = async (text, previous) => {
      const doc = await local.save(ws.id, ws.userId, {
        commandId: randomUUID(),
        documentId: previous?.documentId ?? randomUUID(),
        expectedRevisionId: previous?.revisionId ?? null,
        title: 'Projection fixture',
        input: { kind: 'note', text },
      });
      for (const work of await local.due(ws.id)) await local.process(work);
      return doc;
    };
    await db.platform.query(
      `UPDATE ${qualified(ws.names.schema, 'tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
    );
    let calls = 0;
    const provider = async () => {
      calls++;
      return {
        dispatch: 'dispatched',
        requestId: `fixture-${calls}`,
        inputTokensUpperBound: 1,
        usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
        result: {
          kind: 'success',
          model: profile.model,
          vectors: [Array.from({ length: 1536 }, (_, i) => (i === calls - 1 ? 1 : 0))],
        },
      };
    };
    const embeddings = createKnowledgeEmbeddings({
      runtime,
      config: { kind: 'enabled', endpoint: 'https://example.services.ai.azure.com/', apiKey: 'fixture', profile },
      capacity: async () => true,
      provider,
    });
    const docs = [];
    const jobs = [];
    for (const text of ['# Ready\nPaid original result.', '# Crash\nSaved before publication.']) {
      const doc = await save(text);
      docs.push(doc);
      const publication = (
        await db.platform.query(
          `SELECT d.lexical_publication_id,s.access_epoch,k.passage FROM ${table('documents')} d
        JOIN ${table('sources')} s ON s.id=d.source_id JOIN ${table('chunks')} k ON k.publication_id=d.lexical_publication_id WHERE d.id=$1`,
          [doc.documentId],
        )
      ).rows[0];
      const query = await embeddings.prepareQuery(ws.id, ws.userId, {
        commandId: randomUUID(),
        query: publication.passage,
      });
      assert.equal((await embeddings.process({ workspaceId: ws.id, jobId: query.jobId })).disposition, 'ready');
      const work = { workspaceId: ws.id, jobId: randomUUID(), generation: 1 };
      jobs.push(work);
      await db.platform.query(
        `INSERT INTO ${table('embedding_jobs')} (id,purpose,owner_membership_id,owner_user_id,profile_id,document_id,revision_id,publication_id,access_epoch,total_chunks)
        VALUES ($1,'ingestion',$2,$3,$4,$5,$6,$7,$8,1)`,
        [
          work.jobId,
          ws.membershipId,
          ws.userId,
          profile.id,
          doc.documentId,
          doc.revisionId,
          publication.lexical_publication_id,
          publication.access_epoch,
        ],
      );
      await db.platform.query(
        `INSERT INTO ${table('embedding_items')} SELECT $1,ordinal,profile_id,input_hash,input_text,tokens FROM ${table('embedding_items')} WHERE job_id=$2`,
        [work.jobId, query.jobId],
      );
    }
    await db.platform.query(`UPDATE ${table('embedding_jobs')} SET state='ready' WHERE id=$1`, [jobs[0].jobId]);
    const paid = (await db.platform.query(`SELECT * FROM ${table('embedding_vectors')} ORDER BY input_hash`)).rows;
    const ledger = (await db.platform.query(`SELECT * FROM ${table('credit_group')}`)).rows;
    const disabled = createKnowledgeEmbeddings({
      runtime,
      config: { kind: 'disabled' },
      provider: async () => assert.fail('Cached projection must not call provider'),
      capacity: async () => assert.fail('Cached projection must not reserve capacity'),
    });
    await t.test('old ready and crash-window jobs publish with provider disabled and unchanged paid rows', async () => {
      assert.deepEqual(await disabled.due(ws.id), []);
      assert.deepEqual(await disabled.due(ws.id), []);
      assert.equal(calls, 2);
      assert.deepEqual(
        (await db.platform.query(`SELECT * FROM ${table('embedding_vectors')} ORDER BY input_hash`)).rows,
        paid,
      );
      assert.deepEqual((await db.platform.query(`SELECT * FROM ${table('credit_group')}`)).rows, ledger);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('documents')} WHERE vector_publication_id IS NOT NULL`,
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await db.platform
            .query(`SELECT count(*)::int AS n FROM ${table('search_vectors')} s JOIN ${table('embedding_items')} i
        ON i.ordinal=s.ordinal AND i.input_hash=s.input_hash JOIN ${table('embedding_jobs')} j ON j.id=i.job_id AND j.publication_id=s.lexical_publication_id
        JOIN ${table('chunks')} k ON k.publication_id=s.lexical_publication_id AND k.ordinal=s.ordinal WHERE k.input_hash<>i.input_hash`)
        ).rows[0].n,
        2,
      );
    });
    await t.test('real HNSW cosine index and iterative scan work with pg_catalog-only search path', async () => {
      await runtime.transaction(ws.id, commonCompatibility, async tx => {
        assert.deepEqual((await tx.client.query('SHOW search_path')).rows, [{ search_path: 'pg_catalog' }]);
        await tx.client.query("SET LOCAL enable_seqscan=off; SET LOCAL hnsw.iterative_scan='strict_order'");
        const query = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
        const sql = `SELECT lexical_publication_id,embedding OPERATOR(extensions.<=>) $1::extensions.vector(1536) AS distance
          FROM ${table('search_vectors')} ORDER BY embedding OPERATOR(extensions.<=>) $1::extensions.vector(1536) LIMIT 2`;
        const plan = (await tx.client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${sql}`, [JSON.stringify(query)])).rows[0][
          'QUERY PLAN'
        ];
        assert.match(JSON.stringify(plan), /tf_knowledge_search_vectors_cosine/);
        assert.deepEqual(
          (await tx.client.query(sql, [JSON.stringify(query)])).rows.map(row => row.distance),
          [0, 1],
        );
        assert.deepEqual((await tx.client.query('SHOW hnsw.iterative_scan')).rows, [
          { 'hnsw.iterative_scan': 'strict_order' },
        ]);
      });
      const version = (await db.databaseAdmin.query("SELECT extversion FROM pg_extension WHERE extname='vector'"))
        .rows[0].extversion;
      t.diagnostic(
        `Qualified PostgreSQL ${(await db.databaseAdmin.query('SHOW server_version')).rows[0].server_version}, pgvector ${version}, HNSW strict_order. Synthetic 1536-dimensional vectors only. Genuine 3072-dimensional comparison absent.`,
      );
    });
    await t.test(
      'runtime cannot mutate immutable results, install extensions, create functions, or read another workspace',
      async () => {
        const other = await db.create();
        const login = await connect(db.login(ws));
        try {
          for (const sql of [
            `UPDATE ${table('search_vectors')} SET ordinal=0`,
            `DELETE FROM ${table('search_vectors')}`,
            `UPDATE ${table('vector_publications')} SET profile='{}'`,
            'CREATE EXTENSION hstore',
            'CREATE FUNCTION extensions.hostile() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
            `SELECT * FROM ${qualified(other.names.schema, 'tf_knowledge_search_vectors')}`,
          ])
            await denied(login, sql);
        } finally {
          await login.end();
        }
        await verifyWorkspaceIsolation(db.platform, ws.id);
        await db.databaseAdmin.query('CREATE FUNCTION extensions.hostile() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
        await db.databaseAdmin.query(`GRANT EXECUTE ON FUNCTION extensions.hostile() TO "${ws.names.runtime}"`);
        await assert.rejects(verifyWorkspaceIsolation(db.platform, ws.id), /ambient privileges/);
        await db.databaseAdmin.query('DROP FUNCTION extensions.hostile()');
      },
    );
    await t.test('same-revision republish clears stale vectors and reuses cached ordinals when disabled', async () => {
      const service = createKnowledge({ runtime });
      const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
      const old = (
        await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
          docs[0].documentId,
        ])
      ).rows[0].vector_publication_id;
      const passage = (
        await db.platform.query(`SELECT input_text FROM ${table('embedding_items')} WHERE job_id=$1`, [jobs[0].jobId])
      ).rows[0].input_text;
      const input = {
        id: randomUUID(),
        documentId: docs[0].documentId,
        revisionId: docs[0].revisionId,
        markdown: passage,
        pages: 0,
        tokens: 8,
        chunks: [{ heading: 'Ready', text: passage, tokens: 8, offset: { kind: 'passage' } }],
      };
      await service.publishLexical(ws.id, actor, input);
      assert.equal(
        (
          await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
            docs[0].documentId,
          ])
        ).rows[0].vector_publication_id,
        null,
      );
      await assert.rejects(
        db.platform.query(`UPDATE ${table('documents')} SET vector_publication_id=$2 WHERE id=$1`, [
          docs[0].documentId,
          old,
        ]),
        { code: '23503' },
      );
      assert.deepEqual(await disabled.due(ws.id), []);
      const current = (
        await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
          docs[0].documentId,
        ])
      ).rows[0].vector_publication_id;
      assert.ok(current);
      assert.notEqual(current, old);
      await service.publishLexical(ws.id, actor, input);
      assert.equal(
        (
          await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
            docs[0].documentId,
          ])
        ).rows[0].vector_publication_id,
        current,
      );
      assert.equal(calls, 2);
    });
    await t.test('partial document results never activate a vector publication', async () => {
      const doc = await save('# One\nFirst partial passage.\n\n# Two\nSecond partial passage.');
      await embeddings.due(ws.id);
      const status = await embeddings.documentStatus(ws.id, ws.userId, doc.documentId);
      const work = { workspaceId: ws.id, jobId: status.jobId, generation: status.generation };
      assert.equal((await embeddings.process(work)).disposition, 'retry');
      assert.equal(
        (
          await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
            doc.documentId,
          ])
        ).rows[0].vector_publication_id,
        null,
      );
      assert.equal((await embeddings.process(work)).disposition, 'ready');
      const publication = (
        await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [doc.documentId])
      ).rows[0].vector_publication_id;
      assert.ok(publication);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('search_vectors')} WHERE vector_publication_id=$1`,
            [publication],
          )
        ).rows[0].n,
        2,
      );
      await assert.rejects(
        db.platform.query(
          `UPDATE ${table('search_vectors')} SET profile_id='wrong-profile' WHERE vector_publication_id=$1`,
          [publication],
        ),
        { code: '23503' },
      );
    });
    await t.test('publication transaction rollback recovers paid cache without another call', async () => {
      const doc = await save('New crash recovery passage.');
      const work = (await embeddings.due(ws.id))[0];
      let rejectPublication = true;
      const crashing = createKnowledgeEmbeddings({
        config: { kind: 'enabled', endpoint: 'https://example.services.ai.azure.com/', apiKey: 'fixture', profile },
        provider,
        capacity: async () => true,
        runtime: {
          transaction: (id, range, operation) =>
            runtime.transaction(id, range, async tx => {
              const result = await operation(tx);
              if (
                rejectPublication &&
                (
                  await tx.client.query(
                    `SELECT 1 FROM ${table('documents')} WHERE id=$1 AND vector_publication_id IS NOT NULL`,
                    [doc.documentId],
                  )
                ).rowCount
              ) {
                rejectPublication = false;
                throw new Error('crash before publication commit');
              }
              return result;
            }),
        },
      });
      await assert.rejects(crashing.process(work), /crash before publication commit/);
      const count = calls;
      assert.equal(
        (
          await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
            doc.documentId,
          ])
        ).rows[0].vector_publication_id,
        null,
      );
      await disabled.due(ws.id);
      assert.ok(
        (
          await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
            doc.documentId,
          ])
        ).rows[0].vector_publication_id,
      );
      assert.equal(calls, count);
    });
    for (const mutation of ['edit', 'revoke'])
      await t.test(
        `${mutation} during provider request settles paid result without publishing stale content`,
        async () => {
          const doc = await save(`Revision mismatch ${mutation}.`);
          for (let sweep = 0; sweep < 4; sweep++) await embeddings.due(ws.id);
          const status = await embeddings.documentStatus(ws.id, ws.userId, doc.documentId);
          const work = { workspaceId: ws.id, jobId: status.jobId, generation: status.generation };
          const changing = createKnowledgeEmbeddings({
            runtime,
            config: { kind: 'enabled', endpoint: 'https://example.services.ai.azure.com/', apiKey: 'fixture', profile },
            capacity: async () => true,
            provider: async () => {
              if (mutation === 'edit') await save('Changed while embedding.', doc);
              else
                await db.platform.query(
                  `UPDATE ${qualified(ws.names.schema, 'tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`,
                  [ws.membershipId],
                );
              return provider();
            },
          });
          assert.equal((await changing.process(work)).disposition, 'stale');
          assert.equal(
            (
              await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
                doc.documentId,
              ])
            ).rows[0].vector_publication_id,
            null,
          );
          assert.equal(
            (await db.platform.query(`SELECT count(*)::int AS n FROM ${table('credit_observations')}`)).rows[0].n,
            calls,
          );
          if (mutation === 'revoke')
            await db.platform.query(
              `UPDATE ${qualified(ws.names.schema, 'tf_memberships')} SET removed_at=NULL WHERE id=$1`,
              [ws.membershipId],
            );
        },
      );
    await t.test('edit clears both pointers and old work cannot reactivate the superseded revision', async () => {
      await save('Replacement revision without embeddings.', docs[0]);
      assert.equal((await disabled.process(jobs[0])).disposition, 'stale');
      await disabled.due(ws.id);
      assert.equal(
        (
          await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
            docs[0].documentId,
          ])
        ).rows[0].vector_publication_id,
        null,
      );
    });
    await t.test('document removal clears both pointers and cannot be republished', async () => {
      await local.remove(ws.id, ws.userId, {
        commandId: randomUUID(),
        documentId: docs[1].documentId,
        expectedRevisionId: docs[1].revisionId,
      });
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT lexical_publication_id,vector_publication_id FROM ${table('documents')} WHERE id=$1`,
            [docs[1].documentId],
          )
        ).rows,
        [{ lexical_publication_id: null, vector_publication_id: null }],
      );
      assert.equal((await disabled.process(jobs[1])).disposition, 'stale');
    });
    await t.test('source removal clears every active publication pointer', async () => {
      const doc = await save('New crash recovery passage.');
      for (let sweep = 0; sweep < 4; sweep++) await disabled.due(ws.id);
      const row = (
        await db.platform.query(`SELECT source_id,vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
          doc.documentId,
        ])
      ).rows[0];
      assert.ok(row.vector_publication_id);
      await createKnowledge({ runtime }).manageSource(
        ws.id,
        { kind: 'human', userId: ws.userId, membershipId: ws.membershipId },
        row.source_id,
        'remove',
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT lexical_publication_id,vector_publication_id FROM ${table('documents')} WHERE id=$1`,
            [doc.documentId],
          )
        ).rows,
        [{ lexical_publication_id: null, vector_publication_id: null }],
      );
    });
  } finally {
    await runtime?.close();
    await db.close();
  }
});
