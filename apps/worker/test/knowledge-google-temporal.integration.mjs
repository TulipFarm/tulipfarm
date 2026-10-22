import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleKnowledgeWorker } from '../dist/knowledge-google-composition.js';
import { createKnowledgeEmbeddingWorker } from '../dist/knowledge-embedding-composition.js';
import { startGoogleKnowledgeWorkflow } from '../../api/dist/knowledge-google-dispatch.js';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { googleProviderFixture, connectGoogle } from '../../api/test/knowledge-google-provider-fixture.mjs';

async function eventually(operation, message) {
  const until = Date.now() + 40000;
  while (Date.now() < until) {
    if (await operation()) return;
    await delay(100);
  }
  assert.fail(message);
}

test(
  'real Temporal automatically reconciles due Google sources, renews owner proofs and embeds publications',
  { timeout: 120000 },
  async () => {
    const priorQueue = process.env.TEMPORAL_TASK_QUEUE;
    const queue = `google-corpus-${randomUUID()}`;
    process.env.TEMPORAL_TASK_QUEUE = queue;
    const provider = await googleProviderFixture();
    let f, connection, clientConnection, googleWorker, embeddingWorker, googleRunning, embeddingRunning;
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
      f = await knowledgeFixture({ googleOptions: provider.options, temporal, embeddings: { env, provider: embed } });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
      );
      await connectGoogle(f);
      const sourceId = randomUUID();
      const configured = await f.call('/google/sources', {
        method: 'POST',
        body: { commandId: sourceId, selection: { kind: 'drive-folder', folderId: 'root' }, memberIds: [] },
      });
      assert.equal(configured.status, 200, configured.bytes.toString());
      const workerService = createGoogleWorkspaceService({ runtime: f.runtime, ...provider.options });
      googleWorker = await createGoogleKnowledgeWorker({
        runtime: f.runtime,
        connection,
        env,
        googleService: workerService,
        providerFetch: provider.providerFetch,
      });
      embeddingWorker = await createKnowledgeEmbeddingWorker({
        runtime: f.runtime,
        connection,
        env,
        pool: f.signed.identity,
        google: googleWorker.service,
        provider: embed,
      });
      googleRunning = googleWorker.worker.run();
      embeddingRunning = embeddingWorker.worker.run();
      const source = async () =>
        (
          await f.db.platform.query(
            `SELECT generation,sync_state,next_attempt_at FROM ${f.table('tf_knowledge_google_sources')} WHERE source_id=$1`,
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
      assert.ok(ready.generation >= 3);
      const doc = await document();
      const ledger = (
        await f.db.platform.query(
          `SELECT a.purpose,a.attribution_kind,a.attribution_id,a.state,o.input_tokens FROM ${f.table('tf_knowledge_credit_attempts')} a JOIN ${f.table('tf_knowledge_credit_observations')} o ON o.attempt_id=a.id WHERE a.purpose='ingestion'`,
        )
      ).rows;
      assert.ok(ledger.length > 0, 'automatic Google embeddings must produce settled credit evidence');
      for (const entry of ledger)
        assert.deepEqual(entry, {
          purpose: 'ingestion',
          attribution_kind: 'source',
          attribution_id: sourceId,
          state: 'known',
          input_tokens: '1',
        });
      const firstProof = (
        await f.db.platform.query(`SELECT * FROM ${f.table('tf_knowledge_access_proofs')} WHERE document_id=$1`, [
          doc.id,
        ])
      ).rows[0];
      assert.ok(firstProof);
      const status = await f.call(`/google/documents/${doc.id}`);
      assert.equal(status.json().embedding, 'ready');
      const documents = await f.call(`/google/sources/${sourceId}/documents`);
      assert.equal(documents.status, 200, documents.bytes.toString());
      assert.equal(documents.json().items[0].documentId, doc.id);
      assert.equal(documents.json().items[0].embedding, 'ready');
      const result = await f.call('/search', {
        method: 'POST',
        body: { kind: 'submitted', commandId: randomUUID(), query: 'orchid supplier', filters: { kinds: ['google'] } },
      });
      assert.equal(result.status, 200, result.bytes.toString());
      assert.equal(result.json().mode, 'hybrid');
      assert.equal(result.json().hits[0].citation.documentId, doc.id);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_access_proofs')} SET acl_checked_at=now()-interval '6 minutes',membership_checked_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE document_id=$1`,
        [doc.id],
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_google_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
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
      }, 'periodic due-source dispatch must renew expired owner proofs');
      await eventually(async () => (await source()).sync_state === 'ready', 'periodic reconciliation completes');
      const stale = { workspaceId: f.workspace.id, sourceId, generation: 1 };
      const before = await source();
      await startGoogleKnowledgeWorkflow(temporal, stale);
      const staleHandle = client.workflow.getHandle(`knowledge-google-${f.workspace.id}-${sourceId}-1`);
      await staleHandle.result();
      assert.equal((await source()).generation, before.generation, 'replayed generation cannot mutate current source');
      const history = await client.workflow
        .getHandle(`knowledge-google-${f.workspace.id}-${sourceId}-${ready.generation}`)
        .fetchHistory();
      const activityEvents = history.events.filter(event => event.activityTaskScheduledEventAttributes);
      assert.equal(activityEvents.length, 1);
      for (const event of history.events) {
        const scheduled = event.activityTaskScheduledEventAttributes;
        if (scheduled) assert.equal(scheduled.retryPolicy.maximumAttempts, 1);
        const payloads = event.workflowExecutionStartedEventAttributes?.input ?? scheduled?.input;
        if (payloads)
          for (const payload of payloads.payloads) {
            const value = JSON.parse(Buffer.from(payload.data).toString());
            assert.deepEqual(Object.keys(value).sort(), ['generation', 'sourceId', 'workspaceId']);
            assert.equal(value.sourceId, sourceId);
          }
        for (const payload of event.activityTaskCompletedEventAttributes?.result?.payloads ?? [])
          assert.equal(Buffer.from(payload.metadata.encoding).toString(), 'binary/null');
      }
      const serialized = JSON.stringify(history);
      for (const secret of ['owner-token', provider.state.text, 'Selected folder']) {
        assert.equal(serialized.includes(secret), false);
        assert.equal(serialized.includes(Buffer.from(secret).toString('base64')), false);
      }
    } finally {
      await f?.app.close();
      if (googleWorker) {
        googleWorker.worker.shutdown();
        await googleRunning;
      }
      if (embeddingWorker) {
        embeddingWorker.worker.shutdown();
        await embeddingRunning;
        await embeddingWorker.close();
      }
      await f?.close();
      await connection?.close();
      await clientConnection?.close();
      await provider.close();
      if (priorQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
      else process.env.TEMPORAL_TASK_QUEUE = priorQueue;
    }
  },
);
