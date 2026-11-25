import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { recordDefaultKnowledgeIntent } from '@tulipfarm/knowledge';
import { createGitHubKnowledgeParts } from '../dist/knowledge-github-composition.js';
import { createDefaultKnowledgeParts } from '../dist/knowledge-defaults-composition.js';
import { createKnowledgeWorker } from '../dist/knowledge-worker.js';
import { startDefaultKnowledgeWorkflow } from '../../api/dist/knowledge-defaults-dispatch.js';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { githubProviderFixture } from '../../api/test/knowledge-github-provider-fixture.mjs';

async function eventually(operation, message) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (await operation()) return;
    await delay(100);
  }
  assert.fail(message);
}

test(
  'real Temporal turns a new GitHub authorization into owner-only Knowledge without opening Knowledge',
  { timeout: 240000 },
  async () => {
    const priorQueue = process.env.TEMPORAL_TASK_QUEUE;
    const queue = `default-knowledge-${randomUUID()}`;
    process.env.TEMPORAL_TASK_QUEUE = queue;
    const gh = githubProviderFixture();
    let f, connection, clientConnection, knowledgeWorker, knowledgeRunning;
    try {
      const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
      connection = await NativeConnection.connect({ address });
      clientConnection = await Connection.connect({ address });
      const client = new Client({ connection: clientConnection });
      const temporal = { connection: clientConnection, client };
      const env = {
        TEMPORAL_TASK_QUEUE: queue,
      };
      f = await knowledgeFixture({ githubCorpus: gh.provider, temporal });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
      );
      const github = createGitHubKnowledgeParts({
        runtime: f.runtime,
        githubCorpus: gh.provider(f.runtime),
      });
      const defaults = createDefaultKnowledgeParts({ runtime: f.runtime, engines: { github: github.service } });
      knowledgeWorker = await createKnowledgeWorker({
        connection,
        env,
        parts: { github: github.activities, defaults: defaults.activities },
      });
      knowledgeRunning = knowledgeWorker.run();
      const owner = await gh.connect(f, f.signed.owner, 101, 'owner', undefined, {
        record: recordDefaultKnowledgeIntent,
      });
      const intent = async () =>
        (
          await f.db.platform.query(
            `SELECT id,generation::int AS generation,sync_state,state FROM ${f.table('tf_knowledge_default_intents')}`,
          )
        ).rows;
      assert.equal((await intent()).length, 1, 'integration success records intent without awaiting discovery');
      const intentId = (await intent())[0].id;
      const created = async () =>
        (
          await f.db.platform.query(
            `SELECT s.source_id,s.selection,ks.state FROM ${f.table('tf_knowledge_default_sources')} s JOIN ${f.table('tf_knowledge_sources')} ks ON ks.id=s.source_id WHERE s.intent_id=$1 AND s.state='created'`,
            [intentId],
          )
        ).rows;
      await eventually(
        async () => (await intent())[0].sync_state === 'ready' && (await created()).length === 1,
        'background dispatch discovers and configures the automatic source',
      );
      const [source] = await created();
      assert.deepEqual(
        source.selection,
        { scope: 'all', repositories: [], kinds: ['code', 'commits', 'discussions', 'docs', 'issues', 'pulls'] },
        'every repository the account can read, every kind, full history',
      );
      const published = async path =>
        (
          await f.db.platform.query(
            `SELECT d.lexical_publication_id FROM ${f.table('tf_knowledge_documents')} d JOIN ${f.table('tf_knowledge_github_items')} i ON i.document_id=d.id WHERE d.source_id=$1 AND i.native_id=$2`,
            [source.source_id, path],
          )
        ).rows[0]?.lexical_publication_id;
      await eventually(
        async () => (await published('doc:7001:docs/supplier.md')) && (await published('code:7001:src/app.ts')),
        'docs and code at default-branch head publish without opening Knowledge',
      );
      const members = (
        await f.db.platform.query(
          `SELECT m.membership_id,s.owner_membership_id FROM ${f.table('tf_knowledge_github_members')} m JOIN ${f.table('tf_knowledge_sources')} s ON s.id=m.source_id WHERE m.source_id=$1`,
          [source.source_id],
        )
      ).rows;
      assert.deepEqual(
        members.map(row => row.membership_id),
        [members[0].owner_membership_id],
        'automatic sources default to the connecting member only',
      );

      const before = (await intent())[0];
      await startDefaultKnowledgeWorkflow(temporal, { workspaceId: f.workspace.id, intentId, generation: 1 });
      await client.workflow.getHandle(`knowledge-defaults-${f.workspace.id}-${intentId}-1`).result();
      assert.equal(
        (await intent())[0].generation,
        before.generation,
        'replayed generation cannot mutate the current intent',
      );
      assert.equal((await created()).length, 1, 'replay creates no duplicate source');
      const history = await client.workflow
        .getHandle(`knowledge-defaults-${f.workspace.id}-${intentId}-1`)
        .fetchHistory();
      for (const event of history.events) {
        const payloads =
          event.workflowExecutionStartedEventAttributes?.input ?? event.activityTaskScheduledEventAttributes?.input;
        if (payloads)
          for (const payload of payloads.payloads)
            assert.deepEqual(Object.keys(JSON.parse(Buffer.from(payload.data).toString())).sort(), [
              'generation',
              'intentId',
              'workspaceId',
            ]);
      }
      assert.equal(JSON.stringify(history).includes(owner.token), false);
    } finally {
      await f?.app.close();
      if (knowledgeWorker) {
        knowledgeWorker.shutdown();
        await knowledgeRunning;
      }
      await f?.close();
      await connection?.close();
      await clientConnection?.close();
      if (priorQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
      else process.env.TEMPORAL_TASK_QUEUE = priorQueue;
    }
  },
);
