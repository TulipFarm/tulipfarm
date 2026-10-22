import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';
import { createAtlassianKnowledgeWorker } from '../dist/knowledge-atlassian-composition.js';
import { createKnowledgeEmbeddingWorker } from '../dist/knowledge-embedding-composition.js';
import { startAtlassianKnowledgeWorkflow } from '../../api/dist/knowledge-atlassian-dispatch.js';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { atlassianProviderFixture } from '../../api/test/knowledge-atlassian-provider-fixture.mjs';

async function eventually(operation, message) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (await operation()) return;
    await delay(100);
  }
  assert.fail(message);
}

test(
  'real Temporal reconciles due Atlassian sources, renews owner proofs and embeds pages',
  { timeout: 180000 },
  async () => {
    const priorQueue = process.env.TEMPORAL_TASK_QUEUE;
    const queue = `atlassian-corpus-${randomUUID()}`;
    process.env.TEMPORAL_TASK_QUEUE = queue;
    const atlassian = atlassianProviderFixture();
    let f, connection, clientConnection, atlassianWorker, embeddingWorker, atlassianRunning, embeddingRunning;
    const embeddingCalls = [];
    const env = {
      TEMPORAL_TASK_QUEUE: queue,
      KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
      AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
      AZURE_FOUNDRY_API_KEY: 'fixture-only',
    };
    const embed = async input => {
      embeddingCalls.push(input);
      return {
        dispatch: 'dispatched',
        requestId: randomUUID(),
        inputTokensUpperBound: 1,
        usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
        result: {
          kind: 'success',
          model: profile.model,
          vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
        },
      };
    };
    try {
      const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
      connection = await NativeConnection.connect({ address });
      clientConnection = await Connection.connect({ address });
      const client = new Client({ connection: clientConnection });
      const temporal = { connection: clientConnection, client };
      f = await knowledgeFixture({
        atlassianCorpus: atlassian.provider,
        temporal,
        embeddings: { env, provider: embed },
      });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
      );
      const owner = await atlassian.link(f, f.workspace.membershipId, 'owner-aaid');
      const sourceId = randomUUID();
      const configured = await f.call('/atlassian/sources', {
        method: 'POST',
        body: {
          commandId: sourceId,
          selection: {
            product: 'confluence',
            cloudId: atlassian.cloudId,
            targets: [{ kind: 'page', id: '101', descendants: false }],
          },
          memberIds: [],
        },
      });
      assert.equal(configured.status, 200, configured.bytes.toString());
      atlassianWorker = await createAtlassianKnowledgeWorker({
        runtime: f.runtime,
        connection,
        env,
        atlassianCorpus: atlassian.provider(f.runtime),
      });
      embeddingWorker = await createKnowledgeEmbeddingWorker({
        runtime: f.runtime,
        connection,
        env,
        pool: f.signed.identity,
        atlassian: atlassianWorker.service,
        provider: embed,
      });
      atlassianRunning = atlassianWorker.worker.run();
      embeddingRunning = embeddingWorker.worker.run();
      const source = async () =>
        (
          await f.db.platform.query(
            `SELECT generation,sync_state,next_attempt_at FROM ${f.table('tf_knowledge_atlassian_sources')} WHERE source_id=$1`,
            [sourceId],
          )
        ).rows[0];
      const document = async () =>
        (await f.db.platform.query(`SELECT * FROM ${f.table('tf_knowledge_documents')} WHERE source_id=$1`, [sourceId]))
          .rows[0];
      await eventually(
        async () => (await source()).sync_state === 'ready' && (await document())?.vector_publication_id,
        'API background discovery must publish and embed without an HTTP read',
      );
      assert.ok(embeddingCalls.length > 0);
      const ready = await source();
      const doc = await document();
      const ledger = (
        await f.db.platform.query(
          `SELECT a.purpose,a.attribution_kind,a.attribution_id,a.state FROM ${f.table('tf_knowledge_credit_attempts')} a WHERE a.purpose='ingestion'`,
        )
      ).rows;
      assert.ok(ledger.length > 0);
      for (const entry of ledger)
        assert.deepEqual(entry, {
          purpose: 'ingestion',
          attribution_kind: 'source',
          attribution_id: sourceId,
          state: 'known',
        });
      let result;
      for (let attempt = 0; attempt < 5; attempt++) {
        result = await f.call('/search', {
          method: 'POST',
          body: {
            kind: 'submitted',
            commandId: randomUUID(),
            query: 'orchid supplier',
            filters: { kinds: ['confluence'] },
          },
        });
        if (result.status === 200 && result.json().mode === 'hybrid') break;
        await delay(500);
      }
      assert.equal(result.status, 200, result.bytes.toString());
      assert.equal(result.json().mode, 'hybrid', JSON.stringify(result.json()));
      assert.equal(result.json().hits[0].citation.documentId, doc.id);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_access_proofs')} SET acl_checked_at=now()-interval '6 minutes',membership_checked_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE document_id=$1`,
        [doc.id],
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_atlassian_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE source_id=$1 AND binding IS NOT NULL`,
        [sourceId],
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_atlassian_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
        [sourceId],
      );
      await eventually(async () => {
        const proof = (
          await f.db.platform.query(
            `SELECT expires_at FROM ${f.table('tf_knowledge_access_proofs')} WHERE document_id=$1`,
            [doc.id],
          )
        ).rows[0];
        return (await source()).generation > ready.generation && proof?.expires_at > new Date();
      }, 'periodic due-source dispatch must renew expired owner proofs with a new Atlassian check');
      await eventually(async () => (await source()).sync_state === 'ready', 'periodic reconciliation completes');
      const stale = { workspaceId: f.workspace.id, sourceId, generation: 1 };
      const before = await source();
      await startAtlassianKnowledgeWorkflow(temporal, stale);
      await client.workflow.getHandle(`knowledge-atlassian-${f.workspace.id}-${sourceId}-1`).result();
      assert.equal((await source()).generation, before.generation, 'replayed generation cannot mutate current source');
      const history = await client.workflow
        .getHandle(`knowledge-atlassian-${f.workspace.id}-${sourceId}-${ready.generation}`)
        .fetchHistory();
      assert.equal(history.events.filter(event => event.activityTaskScheduledEventAttributes).length, 1);
      for (const event of history.events) {
        const scheduled = event.activityTaskScheduledEventAttributes;
        if (scheduled) assert.equal(scheduled.retryPolicy.maximumAttempts, 1);
        const payloads = event.workflowExecutionStartedEventAttributes?.input ?? scheduled?.input;
        if (payloads)
          for (const payload of payloads.payloads)
            assert.deepEqual(Object.keys(JSON.parse(Buffer.from(payload.data).toString())).sort(), [
              'generation',
              'sourceId',
              'workspaceId',
            ]);
        for (const payload of event.activityTaskCompletedEventAttributes?.result?.payloads ?? [])
          assert.equal(Buffer.from(payload.metadata.encoding).toString(), 'binary/null');
      }
      const serialized = JSON.stringify(history);
      for (const secret of [owner.token, 'Orchid supplier rollout', 'Supplier handbook']) {
        assert.equal(serialized.includes(secret), false);
        assert.equal(serialized.includes(Buffer.from(secret).toString('base64')), false);
      }
    } finally {
      await f?.app.close();
      if (atlassianWorker) {
        atlassianWorker.worker.shutdown();
        await atlassianRunning;
      }
      if (embeddingWorker) {
        embeddingWorker.worker.shutdown();
        await embeddingRunning;
        await embeddingWorker.close();
      }
      await f?.close();
      await connection?.close();
      await clientConnection?.close();
      if (priorQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
      else process.env.TEMPORAL_TASK_QUEUE = priorQueue;
    }
  },
);
