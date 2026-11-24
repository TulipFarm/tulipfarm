import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { createSlackKnowledgeParts } from '../dist/knowledge-slack-composition.js';
import { createKnowledgeWorker } from '../dist/knowledge-worker.js';
import { startSlackKnowledgeWorkflow } from '../../api/dist/knowledge-slack-dispatch.js';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { slackProviderFixture } from '../../api/test/knowledge-slack-provider-fixture.mjs';

async function eventually(operation, message) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (await operation()) return;
    await delay(100);
  }
  assert.fail(message);
}

test(
  'real Temporal reconciles due Slack sources, renews owner proofs and publishes thread units',
  { timeout: 180000 },
  async () => {
    const priorQueue = process.env.TEMPORAL_TASK_QUEUE;
    const queue = `slack-corpus-${randomUUID()}`;
    process.env.TEMPORAL_TASK_QUEUE = queue;
    const slack = slackProviderFixture();
    let f, connection, clientConnection, slackWorker, slackRunning;
    const env = {
      TEMPORAL_TASK_QUEUE: queue,
    };
    try {
      const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
      connection = await NativeConnection.connect({ address });
      clientConnection = await Connection.connect({ address });
      const client = new Client({ connection: clientConnection });
      const temporal = { connection: clientConnection, client };
      f = await knowledgeFixture({ slackCorpus: slack.provider, temporal });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
      );
      const owner = await slack.link(f, f.signed.owner, f.workspace.membershipId, 'UOWNER');
      const sourceId = randomUUID();
      const configured = await f.call('/slack/sources', {
        method: 'POST',
        body: {
          commandId: sourceId,
          selection: { kind: 'channels', conversationIds: ['CGENERAL'], after: slack.after },
          memberIds: [],
        },
      });
      assert.equal(configured.status, 200, configured.bytes.toString());
      slackWorker = await createKnowledgeWorker({
        connection,
        env,
        parts: {
          slack: createSlackKnowledgeParts({
            runtime: f.runtime,
            slackCorpus: slack.provider(f.runtime),
          }).activities,
        },
      });
      slackRunning = slackWorker.run();
      const source = async () =>
        (
          await f.db.platform.query(
            `SELECT generation,sync_state,next_attempt_at FROM ${f.table('tf_knowledge_slack_sources')} WHERE source_id=$1`,
            [sourceId],
          )
        ).rows[0];
      const document = async () =>
        (await f.db.platform.query(`SELECT * FROM ${f.table('tf_knowledge_documents')} WHERE source_id=$1`, [sourceId]))
          .rows[0];
      await eventually(
        async () => (await source()).sync_state === 'ready' && (await document())?.lexical_publication_id,
        'API background discovery must publish without an HTTP read',
      );
      const ready = await source();
      const doc = await document();
      let result;
      for (let attempt = 0; attempt < 5; attempt++) {
        result = await f.call('/search', {
          method: 'POST',
          body: { kind: 'submitted', commandId: randomUUID(), query: 'orchid supplier', filters: { kinds: ['slack'] } },
        });
        if (result.status === 200 && result.json().hits.length) break;
        await delay(500);
      }
      assert.equal(result.status, 200, result.bytes.toString());
      assert.equal(result.json().hits[0].citation.documentId, doc.id);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_access_proofs')} SET acl_checked_at=now()-interval '6 minutes',membership_checked_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE document_id=$1`,
        [doc.id],
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_slack_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE source_id=$1 AND binding IS NOT NULL`,
        [sourceId],
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
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
      }, 'periodic due-source dispatch must renew expired owner proofs with a new Slack check');
      await eventually(async () => (await source()).sync_state === 'ready', 'periodic reconciliation completes');
      const stale = { workspaceId: f.workspace.id, sourceId, generation: 1 };
      const before = await source();
      await startSlackKnowledgeWorkflow(temporal, stale);
      await client.workflow.getHandle(`knowledge-slack-${f.workspace.id}-${sourceId}-1`).result();
      assert.equal((await source()).generation, before.generation, 'replayed generation cannot mutate current source');
      const history = await client.workflow
        .getHandle(`knowledge-slack-${f.workspace.id}-${sourceId}-${ready.generation}`)
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
      for (const secret of [owner.token, 'Orchid supplier rollout', 'general']) {
        assert.equal(serialized.includes(secret), false);
        assert.equal(serialized.includes(Buffer.from(secret).toString('base64')), false);
      }
    } finally {
      await f?.app.close();
      if (slackWorker) {
        slackWorker.shutdown();
        await slackRunning;
      }
      await f?.close();
      await connection?.close();
      await clientConnection?.close();
      if (priorQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
      else process.env.TEMPORAL_TASK_QUEUE = priorQueue;
    }
  },
);
