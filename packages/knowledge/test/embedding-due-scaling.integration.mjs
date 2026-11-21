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

test('the embedding sweep reads due jobs without visiting published history', async t => {
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
    const observed = {
      transaction: (id, range, operation) =>
        runtime.transaction(id, range, tx =>
          operation({
            ...tx,
            client: {
              query: async (...args) => {
                const label = labels.find(([, marker]) => args[0].includes(marker))?.[0];
                if (label)
                  plans.push({
                    label,
                    ...(await tx.client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${args[0]}`, args[1])).rows[0][
                      'QUERY PLAN'
                    ][0],
                  });
                return tx.client.query(...args);
              },
            },
          }),
        ),
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
    const [due] = plans.filter(plan => plan.label === 'due');
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
    assert.deepEqual(
      plans.map(plan => plan.label),
      ['undiscovered', 'candidate', 'due'],
    );
    const backlog = Object.fromEntries(
      plans.map(plan => [plan.label, { documents: visited(plan, 'documents'), ms: plan['Execution Time'] }]),
    );
    t.diagnostic(JSON.stringify({ published, stuck, backlog }));
    for (const [label, rows] of Object.entries(backlog))
      assert.ok(rows.documents <= 2 * stuck, `The ${label} query visited ${rows.documents} document rows`);
    assert.equal(
      (
        await db.platform.query(`SELECT 1 FROM ${table('embedding_jobs')} WHERE publication_id=$1 AND profile_id=$2`, [
          pending.lexical_publication_id,
          job.profile_id,
        ])
      ).rowCount,
      1,
    );
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
    await embeddings.due(ws.id);
    assert.deepEqual(await pointers(), { [retired.documentId]: false, [legacy.documentId]: false });
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
