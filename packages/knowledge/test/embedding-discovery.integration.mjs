import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createFiles } from '@tulipfarm/files';
import { createKnowledgeEmbeddings, createLocalKnowledge } from '../dist/index.js';

test('embedding discovery preserves pending work and authorization during idle sweeps', async t => {
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
    let statements = [];
    const measured = {
      transaction: (id, range, operation) =>
        runtime.transaction(id, range, tx =>
          operation({
            ...tx,
            client: {
              query: async (...args) => {
                const started = performance.now();
                try {
                  return await tx.client.query(...args);
                } finally {
                  statements.push({ sql: args[0], ms: performance.now() - started });
                }
              },
            },
          }),
        ),
    };
    const unexpected = async () => assert.fail('Discovery must not call an external provider');
    const embeddings = createKnowledgeEmbeddings({
      runtime: measured,
      config: { kind: 'disabled' },
      google: {},
      slack: {},
      github: {},
      atlassian: {},
      provider: unexpected,
      capacity: unexpected,
    });
    const local = createLocalKnowledge({
      runtime,
      files: createFiles(runtime, { putIfAbsent: unexpected, read: unexpected }),
    });
    const save = async (text, previous) => {
      const doc = await local.save(ws.id, ws.userId, {
        commandId: randomUUID(),
        documentId: previous?.documentId ?? randomUUID(),
        expectedRevisionId: previous?.revisionId ?? null,
        title: 'Discovery fixture',
        input: { kind: 'note', text },
      });
      for (const work of await local.due(ws.id)) await local.process(work);
      return doc;
    };
    const sweep = async () => {
      statements = [];
      const started = performance.now();
      assert.deepEqual(await embeddings.due(ws.id), []);
      const ms = performance.now() - started;
      const discovery = statements.filter(({ sql }) => sql.startsWith('SELECT d.id AS document_id'));
      const pending = statements.filter(
        ({ sql }) => sql.startsWith('SELECT 1 FROM') && sql.includes('j.publication_id=d.lexical_publication_id'),
      );
      const authorization = statements.findIndex(
        ({ sql }) => sql.includes('tf_authorization_lock') && sql.includes('FOR UPDATE'),
      );
      assert.ok(authorization >= 0);
      assert.equal(pending.length, 1);
      for (const statement of [...pending, ...discovery]) assert.ok(statements.indexOf(statement) > authorization);
      return { ms, discoveryQueries: discovery.length, discoveryMs: discovery.reduce((sum, item) => sum + item.ms, 0) };
    };
    const jobs = async () =>
      (
        await db.platform.query(
          `SELECT document_id,publication_id FROM ${table('embedding_jobs')} WHERE purpose='ingestion' ORDER BY document_id`,
        )
      ).rows;
    const busy = [];
    const docs = [];
    for (let index = 0; index < 6; index++) {
      docs.push(await save(`Discovery passage ${index}.`));
      busy.push(await sweep());
      assert.equal((await jobs()).length, index + 1);
      assert.equal(busy.at(-1).discoveryQueries, 1);
    }
    const retained = await jobs();
    const idle = [];
    for (let index = 0; index < 12; index++) idle.push(await sweep());
    assert.ok(idle.every(sample => sample.discoveryQueries === 0));
    assert.deepEqual(await jobs(), retained);
    const summary = samples => {
      const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
      return {
        samples: samples.length,
        medianMs: sorted[Math.floor(sorted.length / 2)],
        p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
        discoveryQueries: samples.reduce((sum, sample) => sum + sample.discoveryQueries, 0),
      };
    };
    t.diagnostic(JSON.stringify({ busy: summary(busy), idle: summary(idle) }));

    const revised = await save('A new revision needs its own embedding job.', docs[0]);
    await sweep();
    assert.equal((await jobs()).length, 7);
    assert.equal(
      (
        await db.platform.query(
          `SELECT revision_id FROM ${table('embedding_jobs')} WHERE document_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [revised.documentId],
        )
      ).rows[0].revision_id,
      revised.revisionId,
    );

    const denied = await save('A removed member must not create an embedding job.');
    statements = [];
    assert.equal(
      (await embeddings.resumeDocument(ws.id, ws.userId, docs[1].documentId, randomUUID())).documentId,
      docs[1].documentId,
    );
    assert.ok(statements.every(({ sql }) => !sql.startsWith('SELECT d.id AS document_id')));
    await db.platform.query(
      `UPDATE ${qualified(ws.names.schema, 'tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`,
      [ws.membershipId],
    );
    await sweep();
    assert.equal(
      (await db.platform.query(`SELECT 1 FROM ${table('embedding_jobs')} WHERE document_id=$1`, [denied.documentId]))
        .rowCount,
      0,
    );
    await db.platform.query(`UPDATE ${qualified(ws.names.schema, 'tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
      ws.membershipId,
    ]);
    await sweep();
    assert.equal(
      (await db.platform.query(`SELECT 1 FROM ${table('embedding_jobs')} WHERE document_id=$1`, [denied.documentId]))
        .rowCount,
      1,
    );
  } finally {
    await runtime?.close();
    await db.close();
  }
});
