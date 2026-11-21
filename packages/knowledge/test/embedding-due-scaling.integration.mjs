import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createFiles } from '@tulipfarm/files';
import { createKnowledgeEmbeddings, createLocalKnowledge } from '../dist/index.js';

const published = 20000;
const stuck = 200;

// The sweep's queries that must stay proportional to pending work, found by a fragment of their SQL.
const labels = [
  ['due', 'ORDER BY j.dispatch_after,j.id LIMIT 100'],
  ['candidate', 'ORDER BY p.created_at,p.id LIMIT 1'],
  ['undiscovered', 'AND ($2::uuid IS NULL OR d.id=$2)'],
];

function nodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test('the embedding sweep reads due jobs without visiting published history or holding the lock', async t => {
  const db = await fixture();
  let runtime;
  try {
    const ws = await db.create();
    const table = name => qualified(ws.names.schema, `tf_knowledge_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
    });
    const unexpected = async () => assert.fail('The sweep must not call an external provider');
    const local = createLocalKnowledge({
      runtime,
      files: createFiles(runtime, { putIfAbsent: unexpected, read: unexpected }),
    });
    const seed = await local.save(ws.id, ws.userId, {
      commandId: randomUUID(),
      documentId: randomUUID(),
      expectedRevisionId: null,
      title: 'Scaling',
      input: { kind: 'note', text: 'Embedding sweep scaling.' },
    });
    for (const work of await local.due(ws.id)) await local.process(work);
    let plans = [];
    const forgets = [];
    let failForget = false;
    const observed = {
      transaction: (id, range, operation) =>
        runtime.transaction(id, range, tx => {
          let locked = false;
          return operation({
            ...tx,
            client: {
              query: async (...args) => {
                if (args[0].includes('pg_advisory_xact_lock')) locked = true;
                if (args[0].includes('IS DISTINCT FROM $1 LIMIT $2')) {
                  if (failForget) {
                    failForget = false;
                    throw new Error('statement timeout');
                  }
                  const started = performance.now();
                  const result = await tx.client.query(...args);
                  forgets.push({ rows: result.rowCount, ms: performance.now() - started });
                  return result;
                }
                const label = labels.find(([, marker]) => args[0].includes(marker))?.[0];
                if (label)
                  plans.push({
                    label,
                    locked,
                    ...(await tx.client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${args[0]}`, args[1])).rows[0][
                      'QUERY PLAN'
                    ][0],
                  });
                return tx.client.query(...args);
              },
            },
          });
        }),
    };
    const embeddings = createKnowledgeEmbeddings({
      runtime: observed,
      config: { kind: 'disabled' },
      provider: unexpected,
      capacity: unexpected,
    });
    assert.deepEqual(await embeddings.due(ws.id), []);
    const [job] = (
      await db.platform.query(`SELECT * FROM ${table('embedding_jobs')} WHERE document_id=$1`, [seed.documentId])
    ).rows;
    assert.ok(job);

    // Copy the seeded document into a large, fully embedded knowledge base with one superseded job per document.
    await db.platform.query(`CREATE TEMP TABLE scaled AS
      SELECT i,gen_random_uuid() AS id,gen_random_uuid() AS old_revision,gen_random_uuid() AS old_publication,
        gen_random_uuid() AS revision,gen_random_uuid() AS publication,gen_random_uuid() AS vectors
      FROM generate_series(1,${published}) i`);
    await db.platform.query(
      `INSERT INTO ${table('documents')} (id,source_id,native_id)
      SELECT s.id,d.source_id,s.id::text FROM scaled s CROSS JOIN ${table('documents')} d WHERE d.id=$1`,
      [seed.documentId],
    );
    for (const [revision, publication] of [
      ['old_revision', 'old_publication'],
      ['revision', 'publication'],
    ]) {
      await db.platform.query(
        `INSERT INTO ${table('revisions')} (id,document_id,source_revision,title,original,original_bytes,parser_profile,sources,fingerprint)
        SELECT s.${revision},s.id,s.${revision}::text,r.title,r.original,r.original_bytes,r.parser_profile,r.sources,r.fingerprint
        FROM scaled s CROSS JOIN ${table('revisions')} r WHERE r.id=$1`,
        [seed.revisionId],
      );
      await db.platform.query(
        `INSERT INTO ${table('local_revisions')} (revision_id,owner_membership_id,owner_user_id,filename,media_type,command_fingerprint)
        SELECT s.${revision},l.owner_membership_id,l.owner_user_id,l.filename,l.media_type,l.command_fingerprint
        FROM scaled s CROSS JOIN ${table('local_revisions')} l WHERE l.revision_id=$1`,
        [seed.revisionId],
      );
      await db.platform.query(
        `INSERT INTO ${table('publications')} (id,document_id,revision_id,markdown,pages,tokens,chunk_count,fingerprint)
        SELECT s.${publication},s.id,s.${revision},p.markdown,p.pages,p.tokens,p.chunk_count,p.fingerprint
        FROM scaled s CROSS JOIN ${table('publications')} p WHERE p.id=$1`,
        [job.publication_id],
      );
      await db.platform.query(
        `INSERT INTO ${table('embedding_jobs')} (id,purpose,owner_membership_id,owner_user_id,profile_id,document_id,revision_id,publication_id,access_epoch,total_chunks,state)
        SELECT gen_random_uuid(),'ingestion',j.owner_membership_id,j.owner_user_id,j.profile_id,s.id,s.${revision},s.${publication},j.access_epoch,j.total_chunks,'ready'
        FROM scaled s CROSS JOIN ${table('embedding_jobs')} j WHERE j.id=$1`,
        [job.id],
      );
    }
    await db.platform.query(
      `INSERT INTO ${table('vector_publications')} (id,document_id,revision_id,lexical_publication_id,profile,profile_id)
      SELECT s.vectors,s.id,s.revision,s.publication,p.profile,p.id
      FROM scaled s CROSS JOIN ${table('embedding_profiles')} p WHERE p.id=$1`,
      [job.profile_id],
    );
    await db.platform.query(
      `UPDATE ${table('documents')} d SET observed_revision_id=s.revision,lexical_publication_id=s.publication,vector_publication_id=s.vectors
      FROM scaled s WHERE d.id=s.id`,
    );
    for (const name of ['documents', 'revisions', 'publications', 'vector_publications', 'embedding_jobs'])
      await db.platform.query(`ANALYZE ${table(name)}`);

    const visited = (plan, relation) =>
      nodes(plan.Plan)
        .filter(node => node['Relation Name'] === `tf_knowledge_${relation}`)
        .reduce(
          (sum, node) => sum + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'],
          0,
        );
    plans = [];
    assert.deepEqual(await embeddings.due(ws.id), []);
    // Nothing is due, so the scan runs without the authorization lock and the locked transaction has nothing to check.
    assert.deepEqual(
      plans.map(({ label, locked }) => ({ label, locked })),
      [
        { label: 'due', locked: false },
        { label: 'undiscovered', locked: true },
      ],
    );
    const [due] = plans;
    const jobs = visited(due, 'embedding_jobs'),
      documents = visited(due, 'documents');
    t.diagnostic(JSON.stringify({ published, jobs, documents, ms: due['Execution Time'] }));
    assert.ok(jobs < 100, `The due-job query visited ${jobs} job rows`);
    assert.ok(documents < 100, `The due-job query visited ${documents} document rows`);

    // A second installed profile and a backlog of documents whose embedding failed must not pull the rest of the
    // knowledge base back into the sweep.
    await db.platform.query(
      `INSERT INTO ${table('embedding_profiles')} (id,profile) SELECT 'retired-profile',profile FROM ${table('embedding_profiles')}`,
    );
    await db.platform.query(
      `UPDATE ${table('embedding_jobs')} j SET state='failed'
      FROM scaled s WHERE s.i<=${stuck} AND j.publication_id=s.publication`,
    );
    await db.platform.query(`UPDATE ${table('documents')} d SET vector_publication_id=NULL FROM scaled s
      WHERE d.id=s.id AND s.i<=${stuck}`);
    // One document still needs discovery, so the discovery queries run as well.
    const [pending] = (
      await db.platform.query(
        `UPDATE ${table('documents')} d SET vector_publication_id=NULL FROM scaled s WHERE d.id=s.id AND s.i=${published}
        RETURNING d.id,d.lexical_publication_id`,
      )
    ).rows;
    await db.platform.query(`DELETE FROM ${table('embedding_jobs')} WHERE publication_id=$1`, [
      pending.lexical_publication_id,
    ]);
    for (const name of ['documents', 'embedding_jobs']) await db.platform.query(`ANALYZE ${table(name)}`);

    plans = [];
    assert.deepEqual(await embeddings.due(ws.id), []);
    // The due scan runs before the lock; under the lock only the candidates it found and the job discovery just
    // created are checked again.
    assert.deepEqual(
      plans.map(({ label, locked }) => ({ label, locked })),
      [
        { label: 'due', locked: false },
        { label: 'undiscovered', locked: true },
        { label: 'candidate', locked: true },
        { label: 'due', locked: true },
      ],
    );
    const backlog = plans.map(plan => ({
      label: plan.label,
      locked: plan.locked,
      documents: visited(plan, 'documents'),
      jobs: visited(plan, 'embedding_jobs'),
      ms: plan['Execution Time'],
    }));
    t.diagnostic(JSON.stringify({ published, stuck, backlog }));
    for (const rows of backlog)
      assert.ok(rows.documents <= 2 * stuck, `The ${rows.label} query visited ${rows.documents} document rows`);
    const recheck = backlog.at(-1);
    assert.ok(recheck.documents <= 2, `The locked due check visited ${recheck.documents} document rows`);
    assert.ok(recheck.jobs <= 2, `The locked due check visited ${recheck.jobs} job rows`);
    assert.equal(
      (
        await db.platform.query(`SELECT 1 FROM ${table('embedding_jobs')} WHERE publication_id=$1 AND profile_id=$2`, [
          pending.lexical_publication_id,
          job.profile_id,
        ])
      ).rowCount,
      1,
    );

    // Another profile was active and embedded the whole knowledge base; rolling back makes the current profile active
    // again. The clear of the other profile's pointers is too large for one batch: it persists the activation even
    // when a batch fails, and finishes over several sweeps in batches that each stay well under a second.
    await db.platform.query(
      `UPDATE ${table('embedding_active_profile')} SET profile_id='retired-profile',forgetting=false`,
    );
    await db.platform.query(
      `WITH v AS (
        INSERT INTO ${table('vector_publications')} (id,document_id,revision_id,lexical_publication_id,profile,profile_id)
        SELECT gen_random_uuid(),d.id,d.observed_revision_id,d.lexical_publication_id,p.profile,p.id
        FROM ${table('documents')} d CROSS JOIN ${table('embedding_profiles')} p
        WHERE d.vector_publication_id IS NOT NULL AND p.id='retired-profile' RETURNING id,document_id)
      UPDATE ${table('documents')} d SET vector_publication_id=v.id FROM v WHERE d.id=v.document_id`,
    );
    for (const name of ['documents', 'vector_publications']) await db.platform.query(`ANALYZE ${table(name)}`);
    const retiredPointers = async () =>
      Number(
        (
          await db.platform.query(
            `SELECT count(*) FROM ${table('documents')} d JOIN ${table('vector_publications')} v
            ON v.id=d.vector_publication_id WHERE v.profile_id='retired-profile'`,
          )
        ).rows[0].count,
      );
    const marker = async () =>
      (await db.platform.query(`SELECT profile_id,forgetting FROM ${table('embedding_active_profile')}`)).rows[0];
    const retiredBefore = await retiredPointers();
    assert.ok(retiredBefore > 4 * 2000, `${retiredBefore} documents point at the retired profile`);

    failForget = true;
    await assert.rejects(embeddings.due(ws.id), /statement timeout/);
    assert.deepEqual(await marker(), { profile_id: job.profile_id, forgetting: true });
    assert.equal(await retiredPointers(), retiredBefore);
    let sweeps = 0;
    while ((await marker()).forgetting) {
      assert.ok(++sweeps < 50, 'The clear did not finish');
      await embeddings.due(ws.id);
    }
    t.diagnostic(JSON.stringify({ retiredBefore, sweeps, batches: forgets }));
    assert.equal(await retiredPointers(), 0);
    assert.ok(sweeps > retiredBefore / 2000, `The clear finished in ${sweeps} sweeps`);
    for (const batch of forgets) {
      assert.ok(batch.rows <= 2000, `A batch cleared ${batch.rows} documents`);
      assert.ok(batch.ms < 500, `A batch took ${batch.ms} ms`);
    }
  } finally {
    await runtime?.close();
    await db.close();
  }
});

test('documents pointing at vectors of another profile are embedded again for the current one', async () => {
  const db = await fixture();
  let runtime;
  try {
    const ws = await db.create();
    const table = name => qualified(ws.names.schema, `tf_knowledge_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
    });
    const unexpected = async () => assert.fail('The sweep must not call an external provider');
    const local = createLocalKnowledge({
      runtime,
      files: createFiles(runtime, { putIfAbsent: unexpected, read: unexpected }),
    });
    const save = title =>
      local.save(ws.id, ws.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title,
        input: { kind: 'note', text: `${title} text.` },
      });
    const retired = await save('Retired profile');
    const legacy = await save('Before profiles');
    for (const work of await local.due(ws.id)) await local.process(work);
    assert.equal((await db.platform.query(`SELECT 1 FROM ${table('embedding_profiles')}`)).rowCount, 0);

    // Each document points at vectors the current profile can't search: one from an earlier profile, one from
    // before profiles were recorded. Activating the current profile clears both.
    await db.platform.query(
      `INSERT INTO ${table('embedding_profiles')} (id,profile) VALUES ('retired-profile','{"retired":true}')`,
    );
    await db.platform.query(
      `ALTER TABLE ${table('vector_publications')} DROP CONSTRAINT tf_knowledge_vector_publications_profile_required`,
    );
    for (const [document, profile] of [
      [retired, 'retired-profile'],
      [legacy, null],
    ])
      await db.platform.query(
        `WITH v AS (
          INSERT INTO ${table('vector_publications')} (id,document_id,revision_id,lexical_publication_id,profile,profile_id)
          SELECT gen_random_uuid(),d.id,d.observed_revision_id,d.lexical_publication_id,'{"retired":true}',$2
          FROM ${table('documents')} d WHERE d.id=$1 RETURNING id,document_id)
        UPDATE ${table('documents')} d SET vector_publication_id=v.id FROM v WHERE d.id=v.document_id`,
        [document.documentId, profile],
      );
    const pointers = async () =>
      Object.fromEntries(
        (await db.platform.query(`SELECT id,vector_publication_id FROM ${table('documents')}`)).rows.map(row => [
          row.id,
          row.vector_publication_id !== null,
        ]),
      );
    assert.deepEqual(await pointers(), { [retired.documentId]: true, [legacy.documentId]: true });

    const embeddings = createKnowledgeEmbeddings({
      runtime,
      config: { kind: 'disabled' },
      provider: unexpected,
      capacity: unexpected,
    });
    await embeddings.due(ws.id);
    assert.deepEqual(await pointers(), { [retired.documentId]: false, [legacy.documentId]: false });
    await embeddings.due(ws.id);
    await embeddings.due(ws.id);
    const jobs = await db.platform.query(
      `SELECT j.document_id FROM ${table('embedding_jobs')} j JOIN ${table('documents')} d
      ON d.lexical_publication_id=j.publication_id WHERE j.profile_id<>'retired-profile' ORDER BY j.document_id`,
    );
    assert.deepEqual(jobs.rows.map(row => row.document_id).sort(), [retired.documentId, legacy.documentId].sort());
  } finally {
    await runtime?.close();
    await db.close();
  }
});
