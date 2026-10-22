import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { createFiles } from '@tulipfarm/files';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createKnowledge,
  createKnowledgeEmbeddings,
  createLocalKnowledge,
  createKnowledgeSearch,
} from '../dist/index.js';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests exhaust workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

function setting(name, fallback, maximum) {
  const value = Number(process.env[`KNOWLEDGE_BENCHMARK_${name}`] ?? process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= maximum, `Invalid benchmark ${name}`);
  return value;
}

const dimensions = 1536;
const vector = seed => Array.from({ length: dimensions }, (_, d) => Math.sin(seed * (d + 2) * 0.731));
const config = {
  documents: setting('DOCUMENTS', 100, 100000),
  chunksPerDocument: setting('CHUNKS_PER_DOCUMENT', 15, 4096),
  concurrency: setting('CONCURRENCY', 10, 64),
  queries: setting('QUERIES', 20, 10000),
};

function summarize(samples) {
  const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
  const percentile = p => (sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null);
  const hybrid = samples.filter(sample => sample.mode === 'hybrid').length;
  const hybridWithin2000Ms = samples.filter(sample => sample.mode === 'hybrid' && sample.elapsedMs < 2000).length;
  const fallback = samples.filter(sample => sample.mode === 'keyword-only').length;
  return {
    submissions: samples.length,
    failures: samples.filter(sample => sample.error).length,
    hybrid,
    hybridFraction: samples.length ? hybrid / samples.length : null,
    hybridWithin2000Ms,
    hybridWithin2000MsFraction: samples.length ? hybridWithin2000Ms / samples.length : null,
    fallback,
    fallbackRate: samples.length ? fallback / samples.length : null,
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  };
}

test(
  'rerunnable synthetic hybrid benchmark with restricted runtime and concurrent ingestion',
  { timeout: 3600000 },
  async t => {
    const db = await fixture();
    let runtime, search, probe;
    let stop = false;
    let ingestion;
    const samples = [];
    const recalls = [];
    const ingestionReceipt = { completed: 0, completedDuringLoad: 0, intervals: [], error: null };
    const providerReceipt = { calls: 0, slowCalls: 0, outageCalls: 0, fixtureDelayMs: 20, slowDelayMs: 2200 };
    const receipt = {
      kind: 'knowledge-hybrid-synthetic-benchmark',
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      config,
      dimensions,
      profile: knowledgeEmbeddingProfile.id,
      limitations: [
        'Synthetic vectors and text, not human relevance or Azure qualification.',
        'Each synthetic document repeats its vector across its chunks. This stresses document diversification, not independent passage geometry.',
        'Cold means uncached query embeddings with a local provider fixture, not cold PostgreSQL or operating-system caches.',
        'The default corpus is below the runtime ANN threshold. A forced HNSW projection probe is reported separately.',
        'Direct in-process search and ingestion, not HTTP, Temporal, OCR, or production.',
      ],
      hardware: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      version: {
        node: process.version,
        git: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      },
      samples,
      recalls,
      provider: providerReceipt,
      ingestion: ingestionReceipt,
    };
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const ws = await db.create(await workspaceTableMigrations());
      const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
      const other = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        other.membershipId,
        other.userId,
      ]);
      await db.platform.query(
        `UPDATE ${table('tf_credit_account')} SET available=1000000000000000,granted=1000000000000000`,
      );
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        maxPools: 1,
        connectionsPerPool: Math.max(4, config.concurrency + 2),
        reservedConnections: 2,
        databaseConnectionBudget: Math.max(40, config.concurrency + 10),
        resolveCredential: async id => {
          assert.equal(id, ws.id);
          return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
        },
      });
      const files = createFiles(runtime, {
        putIfAbsent: async () => {},
        read: async () => {
          throw new Error('No file fixture');
        },
      });
      const local = createLocalKnowledge({ runtime, files });
      const embeddings = createKnowledgeEmbeddings({
        runtime,
        config: {
          kind: 'enabled',
          endpoint: 'https://example.services.ai.azure.com/',
          apiKey: 'fixture-only',
          profile: knowledgeEmbeddingProfile,
        },
        capacity: async () => true,
        provider: async input => {
          providerReceipt.calls++;
          const slow = input.inputs.some(text => text.includes('slowprobe'));
          const outage = input.inputs.some(text => text === 'benchmarkneedle');
          if (slow) providerReceipt.slowCalls++;
          if (outage) providerReceipt.outageCalls++;
          await delay(slow ? providerReceipt.slowDelayMs : providerReceipt.fixtureDelayMs);
          return {
            dispatch: 'dispatched',
            inputTokensUpperBound: input.inputs.length,
            requestId: 'synthetic-benchmark',
            usage: {
              kind: 'known',
              inputTokens: input.inputs.length,
              totalTokens: input.inputs.length,
              exceedsUpperBound: false,
            },
            result: outage
              ? { kind: 'error', code: 'invalid_vectors' }
              : {
                  kind: 'success',
                  model: knowledgeEmbeddingProfile.model,
                  vectors: input.inputs.map(text => vector(Number(text.match(/semanticprobe (\d+)/)?.[1] ?? 1))),
                },
          };
        },
      });
      search = createKnowledgeSearch({ runtime, embeddings });
      async function note(text) {
        const saved = await local.save(ws.id, ws.userId, {
          commandId: randomUUID(),
          documentId: randomUUID(),
          expectedRevisionId: null,
          title: text,
          input: { kind: 'note', text },
        });
        for (const work of await local.due(ws.id)) await local.process(work);
        return saved;
      }
      async function index(documentId) {
        for (let attempt = 0; attempt < 100; attempt++) {
          for (const work of await embeddings.due(ws.id)) await embeddings.process(work);
          if (
            (
              await db.platform.query(`SELECT vector_publication_id FROM ${table('documents')} WHERE id=$1`, [
                documentId,
              ])
            ).rows[0].vector_publication_id
          )
            return;
        }
        assert.fail('Background vector publication did not finish');
      }
      const seed = await note('benchmarkneedle synthetic source');
      await createKnowledge({ runtime }).publishLexical(ws.id, ws.userId, {
        id: randomUUID(),
        documentId: seed.documentId,
        revisionId: seed.revisionId,
        markdown: 'benchmarkneedle synthetic source',
        pages: 0,
        tokens: config.chunksPerDocument,
        chunks: Array.from({ length: config.chunksPerDocument }, () => ({
          heading: '',
          text: 'benchmarkneedle synthetic source',
          tokens: 1,
          offset: { kind: 'passage' },
        })),
      });
      await index(seed.documentId);
      await db.platform.query('SET statement_timeout=0');
      const seedRow = (
        await db.platform.query(
          `SELECT d.*,v.profile_id,k.input_hash FROM ${table('documents')} d
      JOIN ${table('vector_publications')} v ON v.id=d.vector_publication_id
      JOIN ${table('search_vectors')} k ON k.vector_publication_id=v.id AND k.ordinal=0 WHERE d.id=$1`,
          [seed.documentId],
        )
      ).rows[0];
      await db.platform.query(
        `CREATE TEMP TABLE benchmark_sources AS SELECT i,CASE WHEN i=0 THEN $1::uuid ELSE gen_random_uuid() END AS id,
      CASE WHEN i%10=9 THEN $2::uuid ELSE $3::uuid END AS membership_id,
      CASE WHEN i%10=9 THEN $4::text ELSE $5::text END AS user_id FROM generate_series(0,99) i`,
        [seedRow.source_id, other.membershipId, ws.membershipId, other.userId, ws.userId],
      );
      await db.platform
        .query(`INSERT INTO ${table('sources')} (id,provider,account_namespace,selection,owner_membership_id)
      SELECT id,'note',user_id,'synthetic-cohort-'||i,membership_id FROM benchmark_sources WHERE i>0`);
      await db.platform.query(
        `CREATE TEMP TABLE benchmark_documents AS SELECT n.i,gen_random_uuid() AS id,gen_random_uuid() AS revision_id,
      gen_random_uuid() AS publication_id,gen_random_uuid() AS vector_id,repeat(md5('synthetic-benchmark-'||n.i),2) AS input_hash,
      s.id AS source_id,s.membership_id,s.user_id FROM generate_series(1,$1::int-1) n(i) JOIN benchmark_sources s ON s.i=n.i%100`,
        [config.documents],
      );
      const loadStarted = performance.now();
      for (let start = 1; start < config.documents; start += 100) {
        const bounds = [start, start + 100];
        await db.platform.query('BEGIN');
        try {
          await db.platform.query(
            `INSERT INTO ${table('documents')} (id,source_id,native_id) SELECT id,source_id,id::text FROM benchmark_documents WHERE i >= $1 AND i < $2`,
            bounds,
          );
          await db.platform.query(
            `INSERT INTO ${table('revisions')} (id,document_id,source_revision,title,original,original_bytes,parser_profile,sources,fingerprint)
          SELECT b.revision_id,b.id,b.revision_id::text,'Synthetic document '||b.i,r.original||jsonb_build_object('key',b.revision_id::text),r.original_bytes,r.parser_profile,'[]',b.input_hash
          FROM benchmark_documents b CROSS JOIN ${table('revisions')} r WHERE r.id=$3 AND b.i >= $1 AND b.i < $2`,
            [...bounds, seed.revisionId],
          );
          await db.platform.query(
            `INSERT INTO ${table('local_revisions')} (revision_id,owner_membership_id,owner_user_id,filename,media_type,command_fingerprint)
          SELECT revision_id,membership_id,user_id,'synthetic.txt','text/plain',input_hash FROM benchmark_documents WHERE i >= $1 AND i < $2`,
            bounds,
          );
          await db.platform.query(
            `INSERT INTO ${table('publications')} (id,document_id,revision_id,markdown,pages,tokens,chunk_count,fingerprint)
          SELECT publication_id,id,revision_id,'benchmarkneedle synthetic source',0,$3,$3,input_hash FROM benchmark_documents WHERE i >= $1 AND i < $2`,
            [...bounds, config.chunksPerDocument],
          );
          await db.platform.query(
            `INSERT INTO ${table('chunks')} (publication_id,ordinal,heading,passage,tokens,source_offset,input_hash,search_title)
          SELECT b.publication_id,n,'','benchmarkneedle synthetic source',1,'{"kind":"passage"}',b.input_hash,'Synthetic document '||b.i
          FROM benchmark_documents b CROSS JOIN generate_series(0,$3::int-1) n WHERE b.i >= $1 AND b.i < $2`,
            [...bounds, config.chunksPerDocument],
          );
          await db.platform.query(
            `INSERT INTO ${table('embedding_cache')} (profile_id,input_hash,state) SELECT $3,input_hash,'ready' FROM benchmark_documents WHERE i >= $1 AND i < $2`,
            [...bounds, seedRow.profile_id],
          );
          await db.platform.query(
            `INSERT INTO ${table('embedding_vectors')} (profile_id,input_hash,vector,attempt_id)
          SELECT $3,b.input_hash,to_jsonb(ARRAY(SELECT sin((b.i+1)*(d+2)*0.731) FROM generate_series(0,1535) d)),v.attempt_id
          FROM benchmark_documents b CROSS JOIN ${table('embedding_vectors')} v WHERE v.profile_id=$3 AND v.input_hash=$4 AND b.i >= $1 AND b.i < $2`,
            [...bounds, seedRow.profile_id, seedRow.input_hash],
          );
          await db.platform.query(
            `INSERT INTO ${table('vector_publications')} (id,document_id,revision_id,lexical_publication_id,profile,profile_id)
          SELECT b.vector_id,b.id,b.revision_id,b.publication_id,v.profile,v.profile_id FROM benchmark_documents b CROSS JOIN ${table('vector_publications')} v
          WHERE v.id=$3 AND b.i >= $1 AND b.i < $2`,
            [...bounds, seedRow.vector_publication_id],
          );
          await db.platform.query(
            `INSERT INTO ${table('search_vectors')} (vector_publication_id,lexical_publication_id,ordinal,profile_id,input_hash,embedding)
          SELECT b.vector_id,b.publication_id,n,v.profile_id,b.input_hash,v.vector::text::extensions.vector(1536)
          FROM benchmark_documents b JOIN ${table('embedding_vectors')} v ON v.input_hash=b.input_hash AND v.profile_id=$4
          CROSS JOIN generate_series(0,$3::int-1) n WHERE b.i >= $1 AND b.i < $2`,
            [...bounds, config.chunksPerDocument, seedRow.profile_id],
          );
          await db.platform.query(
            `INSERT INTO ${table('embedding_jobs')} (id,purpose,owner_membership_id,owner_user_id,profile_id,
          document_id,revision_id,publication_id,access_epoch,total_chunks,state)
          SELECT gen_random_uuid(),'ingestion',membership_id,user_id,$3,id,revision_id,publication_id,1,$4,'ready'
          FROM benchmark_documents WHERE i >= $1 AND i < $2`,
            [...bounds, seedRow.profile_id, config.chunksPerDocument],
          );
          await db.platform.query(
            `UPDATE ${table('documents')} d SET observed_revision_id=b.revision_id,lexical_publication_id=b.publication_id,vector_publication_id=b.vector_id
          FROM benchmark_documents b WHERE d.id=b.id AND b.i >= $1 AND b.i < $2`,
            bounds,
          );
          await db.platform.query('COMMIT');
        } catch (error) {
          await db.platform.query('ROLLBACK');
          throw error;
        }
      }
      for (const name of [
        'documents',
        'sources',
        'local_revisions',
        'publications',
        'chunks',
        'vector_publications',
        'search_vectors',
      ])
        await db.platform.query(`ANALYZE ${table(name)}`);
      receipt.corpus = {
        documents: config.documents,
        projectedChunks: (await db.platform.query(`SELECT count(*)::int AS n FROM ${table('search_vectors')}`)).rows[0]
          .n,
        bulkLoadMs: performance.now() - loadStarted,
        syntheticDocuments: config.documents - 1,
        realSeedDocuments: 1,
        cohorts: 100,
        privateDocuments: (
          await db.platform.query('SELECT count(*)::int AS n FROM benchmark_documents WHERE membership_id=$1', [
            other.membershipId,
          ])
        ).rows[0].n,
      };
      assert.equal(receipt.corpus.projectedChunks, config.documents * config.chunksPerDocument);
      receipt.version.postgres = (await db.platform.query('SELECT version() AS version')).rows[0].version;
      receipt.version.pgvector = (
        await db.platform.query("SELECT extversion FROM pg_extension WHERE extname='vector'")
      ).rows[0].extversion;
      receipt.databaseSettings = (
        await db.platform.query('SELECT name,setting,unit FROM pg_settings WHERE name=ANY($1)', [
          ['shared_buffers', 'work_mem', 'maintenance_work_mem', 'max_connections', 'effective_cache_size'],
        ])
      ).rows;
      probe = await connect(db.login(ws));
      receipt.runtimeRole = (
        await probe.query(
          'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0];
      assert.deepEqual(receipt.runtimeRole, {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      const sources = (await db.platform.query('SELECT * FROM benchmark_sources ORDER BY i')).rows;
      const owned = new Set([
        seed.documentId,
        ...(
          await db.platform.query('SELECT id FROM benchmark_documents WHERE membership_id=$1', [ws.membershipId])
        ).rows.map(row => row.id),
      ]);
      const privateIds = new Set(
        (
          await db.platform.query('SELECT id FROM benchmark_documents WHERE membership_id=$1', [other.membershipId])
        ).rows.map(row => row.id),
      );
      async function submit(phase, query, filters = {}, userId = ws.userId) {
        const sample = { phase, query, startedAt: new Date().toISOString() };
        samples.push(sample);
        const started = performance.now();
        try {
          const response = await search.search(ws.id, userId, {
            kind: 'submitted',
            commandId: randomUUID(),
            query,
            filters,
          });
          Object.assign(sample, {
            mode: response.mode,
            reason: response.reason,
            hits: response.hits.length,
            unauthorizedHits: response.hits.filter(hit =>
              userId === other.userId
                ? !privateIds.has(hit.citation.documentId)
                : privateIds.has(hit.citation.documentId),
            ).length,
          });
          return response;
        } catch (error) {
          sample.error = { name: error.name, code: error.code ?? null, message: error.message };
          return null;
        } finally {
          sample.elapsedMs = performance.now() - started;
        }
      }
      async function workload(phase, query) {
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(config.concurrency, config.queries) }, async () => {
            while (next < config.queries) {
              const i = next++;
              await submit(phase, query(i));
            }
          }),
        );
      }
      await submit('warmup', 'semanticprobe 100001');
      const queued = await note('background ingestion 0');
      let loadActive = true;
      ingestion = (async () => {
        while (!stop) {
          const startedAt = new Date().toISOString();
          const saved =
            ingestionReceipt.completed === 0
              ? queued
              : await note(`background ingestion ${ingestionReceipt.completed}`);
          await index(saved.documentId);
          owned.add(saved.documentId);
          ingestionReceipt.completed++;
          if (loadActive) ingestionReceipt.completedDuringLoad++;
          ingestionReceipt.intervals.push({ startedAt, finishedAt: new Date().toISOString() });
          await delay(10);
        }
      })().catch(error => {
        ingestionReceipt.error = { name: error.name, message: error.message };
      });
      await workload('cold', i => `semanticprobe ${200001 + i}`);
      await workload('warm', () => 'semanticprobe 100001');
      loadActive = false;
      stop = true;
      await ingestion;
      await submit('slow-provider', 'benchmarkneedle slowprobe');
      await search.close();
      await submit('outage', 'benchmarkneedle');
      const subsets = [
        { name: 'owner-all', membershipId: ws.membershipId, userId: ws.userId, sourceIds: [] },
        {
          name: 'owner-ten-percent',
          membershipId: ws.membershipId,
          userId: ws.userId,
          sourceIds: sources.filter(s => s.i % 10 === 0).map(s => s.id),
        },
        { name: 'owner-one-percent', membershipId: ws.membershipId, userId: ws.userId, sourceIds: [sources[0].id] },
        {
          name: 'other-member-private',
          membershipId: other.membershipId,
          userId: other.userId,
          sourceIds: sources.filter(s => s.i % 10 === 9).map(s => s.id),
        },
      ];
      for (const subset of subsets) {
        const params = [
          subset.membershipId,
          subset.userId,
          subset.sourceIds,
          JSON.stringify(vector(1)),
          knowledgeEmbeddingProfile.id,
        ];
        const eligible = `SELECT d.id,d.vector_publication_id,d.lexical_publication_id FROM ${table('documents')} d
        JOIN ${table('sources')} s ON s.id=d.source_id JOIN ${table('local_revisions')} l ON l.revision_id=d.observed_revision_id
        WHERE s.owner_membership_id=$1 AND l.owner_membership_id=$1 AND l.owner_user_id=$2 AND (cardinality($3::uuid[])=0 OR s.id=ANY($3::uuid[]))
        AND s.state IN ('active','paused') AND d.tombstoned_at IS NULL`;
        const nearest = `WITH eligible AS MATERIALIZED (${eligible}) SELECT v.lexical_publication_id,v.ordinal
        FROM ${table('search_vectors')} v WHERE v.profile_id=$5 AND EXISTS (SELECT 1 FROM eligible e
          WHERE e.vector_publication_id=v.vector_publication_id AND e.lexical_publication_id=v.lexical_publication_id)
        ORDER BY v.embedding OPERATOR(extensions.<=>) $4::extensions.vector(1536) LIMIT 2000`;
        const count = (
          await probe.query(
            `WITH eligible AS (${eligible}) SELECT count(DISTINCT e.id)::int AS documents,
        count(*)::int AS chunks FROM eligible e JOIN ${table('search_vectors')} v ON v.vector_publication_id=e.vector_publication_id`,
            [subset.membershipId, subset.userId, subset.sourceIds],
          )
        ).rows[0];
        if (!count.documents) {
          recalls.push({ subset: subset.name, ...count, skipped: 'No documents at this configured corpus size' });
          continue;
        }
        await probe.query('BEGIN');
        let approximate, exact, plan;
        try {
          await probe.query(
            "SET LOCAL statement_timeout='120s'; SET LOCAL hnsw.iterative_scan='strict_order'; SET LOCAL hnsw.ef_search=200; SET LOCAL hnsw.max_scan_tuples=20000; SET LOCAL enable_seqscan=off; SET LOCAL enable_sort=off",
          );
          plan = (await probe.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${nearest}`, params)).rows;
          approximate = (await probe.query(nearest, params)).rows;
          await probe.query(
            'SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL enable_seqscan=on; SET LOCAL enable_sort=on',
          );
          exact = (
            await probe.query(
              `WITH eligible AS MATERIALIZED (${eligible}), distances AS MATERIALIZED (
          SELECT e.id,min(v.embedding OPERATOR(extensions.<=>) $4::extensions.vector(1536)) AS distance
          FROM eligible e JOIN ${table('search_vectors')} v ON v.vector_publication_id=e.vector_publication_id
          AND v.lexical_publication_id=e.lexical_publication_id WHERE v.profile_id=$5 GROUP BY e.id)
          SELECT id FROM distances ORDER BY distance,id LIMIT 20`,
              params,
            )
          ).rows.map(row => row.id);
        } finally {
          await probe.query('ROLLBACK');
        }
        assert.match(JSON.stringify(plan), /tf_knowledge_search_vectors_cosine/);
        const response = await submit('recall', 'semanticprobe 1', { sourceIds: subset.sourceIds }, subset.userId);
        const actual = response?.hits.map(hit => hit.citation.documentId) ?? [];
        const authorized = subset.userId === other.userId ? privateIds : owned;
        assert.ok(
          actual.every(id => authorized.has(id)),
          'Search leaked another member document',
        );
        const publicationIds = [...new Set(approximate.map(row => row.lexical_publication_id))];
        const approximateIds = (
          await probe.query(`SELECT id FROM ${table('documents')} WHERE lexical_publication_id=ANY($1::uuid[])`, [
            publicationIds,
          ])
        ).rows.map(row => row.id);
        recalls.push({
          subset: subset.name,
          ...count,
          k: exact.length,
          exactIds: exact,
          actualIds: actual,
          recall: actual.filter(id => exact.includes(id)).length / exact.length,
          runtimeStrategy: count.chunks <= 2048 ? 'exact' : 'ann',
          forcedHnswCandidateCoverage: exact.filter(id => approximateIds.includes(id)).length / exact.length,
          forcedHnswReturnedChunks: approximate.length,
          forcedHnswPlan: plan,
        });
      }
      const denied = await submit('private-filter-denied', 'semanticprobe 1', { sourceIds: subsets[3].sourceIds });
      assert.deepEqual(denied?.hits, []);
    } finally {
      stop = true;
      await ingestion;
      await search?.close();
      await probe?.end();
      await runtime?.close();
      await db.close();
      receipt.finishedAt = new Date().toISOString();
      receipt.summary = summarize(samples);
      receipt.phases = Object.fromEntries(
        [...new Set(samples.map(sample => sample.phase))].map(phase => [
          phase,
          summarize(samples.filter(sample => sample.phase === phase)),
        ]),
      );
      const outage = samples.filter(sample => sample.phase === 'outage');
      receipt.outageKeywordAvailability = {
        submissions: outage.length,
        available: outage.filter(sample => sample.mode === 'keyword-only' && sample.hits > 0).length,
      };
      t.diagnostic(JSON.stringify(receipt));
      t.diagnostic(
        JSON.stringify({
          kind: 'knowledge-hybrid-synthetic-summary',
          corpus: receipt.corpus,
          summary: receipt.summary,
          phases: receipt.phases,
          ingestion: ingestionReceipt,
          outage: receipt.outageKeywordAvailability,
          recalls: recalls.map(row => ({
            subset: row.subset,
            recall: row.recall,
            runtimeStrategy: row.runtimeStrategy,
            forcedHnswCandidateCoverage: row.forcedHnswCandidateCoverage,
          })),
        }),
      );
      for (const [phase, metrics] of Object.entries(receipt.phases))
        t.diagnostic(JSON.stringify({ kind: 'benchmark-phase', phase, ...metrics }));
      for (const row of recalls)
        t.diagnostic(
          JSON.stringify({
            kind: 'benchmark-recall',
            subset: row.subset,
            recall: row.recall,
            documents: row.documents,
            chunks: row.chunks,
            runtimeStrategy: row.runtimeStrategy,
            forcedHnswCandidateCoverage: row.forcedHnswCandidateCoverage,
          }),
        );
    }
    assert.equal(
      samples.filter(sample => sample.error).length,
      0,
      'Submission failures are retained in the JSON receipt',
    );
    assert.equal(
      samples.reduce((sum, sample) => sum + (sample.unauthorizedHits ?? 0), 0),
      0,
    );
    assert.ok(samples.some(sample => sample.phase === 'warm' && sample.mode === 'hybrid'));
    assert.equal(ingestionReceipt.error, null);
    assert.ok(ingestionReceipt.completedDuringLoad > 0, 'No vector publication completed during measured load');
    assert.equal(receipt.outageKeywordAvailability.available, 1);
    assert.ok(
      recalls.filter(row => !row.skipped).every(row => row.actualIds.length === row.k),
      'Search returned an incomplete recall page',
    );
  },
);
