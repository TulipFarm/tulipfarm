import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';
import {
  createDefaultKnowledgeGate,
  defaultKnowledgeFlagEnabled,
  recordDefaultKnowledgeIntent,
} from '@tulipfarm/knowledge';
import { createGitHubKnowledgeWorker } from '../dist/knowledge-github-composition.js';
import { createDefaultKnowledgeWorker } from '../dist/knowledge-defaults-composition.js';
import { createKnowledgeEmbeddingWorker } from '../dist/knowledge-embedding-composition.js';
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
  'real Temporal turns a new GitHub authorization into owner-only Knowledge without opening Knowledge; flag off stops queued automatic work',
  { timeout: 240000 },
  async () => {
    const priorQueue = process.env.TEMPORAL_TASK_QUEUE,
      priorFlags = process.env.FEATURE_FLAGS_OFF;
    const queue = `default-knowledge-${randomUUID()}`;
    process.env.TEMPORAL_TASK_QUEUE = queue;
    const gh = githubProviderFixture();
    let f,
      connection,
      clientConnection,
      githubWorker,
      defaultsWorker,
      embeddingWorker,
      githubRunning,
      defaultsRunning,
      embeddingRunning;
    const embeddingCalls = [];
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
      const env = {
        TEMPORAL_TASK_QUEUE: queue,
        KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
        AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
        AZURE_FOUNDRY_API_KEY: 'fixture-only',
      };
      f = await knowledgeFixture({ githubCorpus: gh.provider, temporal, embeddings: { env, provider: embed } });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
      );
      const gate = createDefaultKnowledgeGate({ runtime: f.runtime });
      githubWorker = await createGitHubKnowledgeWorker({
        runtime: f.runtime,
        connection,
        env,
        githubCorpus: gh.provider(f.runtime),
        gate,
      });
      defaultsWorker = await createDefaultKnowledgeWorker({
        runtime: f.runtime,
        connection,
        env,
        engines: { github: githubWorker.service },
      });
      embeddingWorker = await createKnowledgeEmbeddingWorker({
        runtime: f.runtime,
        connection,
        env,
        pool: f.signed.identity,
        gate,
        github: githubWorker.service,
        provider: embed,
      });
      githubRunning = githubWorker.worker.run();
      embeddingRunning = embeddingWorker.worker.run();
      defaultsRunning = defaultsWorker.worker.run();
      const owner = await gh.connect(f, f.signed.owner, 101, 'owner', undefined, {
        enabled: defaultKnowledgeFlagEnabled,
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
        { scope: 'all', repositories: [], kinds: ['code', 'discussions', 'docs', 'issues', 'pulls'] },
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
      const vectors = async () =>
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS n FROM ${f.table('tf_knowledge_documents')} WHERE source_id=$1 AND vector_publication_id IS NULL AND tombstoned_at IS NULL`,
            [source.source_id],
          )
        ).rows[0].n;
      await eventually(async () => (await vectors()) === 0, 'automatic GitHub documents embed');
      const ledger = (
        await f.db.platform.query(
          `SELECT attribution_kind,attribution_id,state FROM ${f.table('tf_knowledge_credit_attempts')} WHERE purpose='ingestion'`,
        )
      ).rows;
      assert.ok(
        ledger.length > 0 && embeddingCalls.length > 0,
        'automatic GitHub embeddings produce settled credit evidence',
      );
      for (const entry of ledger)
        assert.deepEqual(entry, { attribution_kind: 'source', attribution_id: source.source_id, state: 'known' });
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

      // GitHub Knowledge is on for everyone: turning the automatic-knowledge flag off never holds its sources.
      process.env.FEATURE_FLAGS_OFF = 'default-connection-knowledge';
      const sourceRow = async () =>
        (
          await f.db.platform.query(
            `SELECT generation::int AS generation, lease_token FROM ${f.table('tf_knowledge_github_sources')} WHERE source_id=$1`,
            [source.source_id],
          )
        ).rows[0];
      await eventually(async () => (await sourceRow()).lease_token === null, 'in-flight GitHub work settles');
      const running = await sourceRow();
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
        [source.source_id],
      );
      await eventually(
        async () => (await sourceRow()).generation > running.generation,
        'flag off does not hold automatic GitHub work',
      );
      assert.ok(await published('doc:7001:docs/supplier.md'));
      delete process.env.FEATURE_FLAGS_OFF;
    } finally {
      if (priorFlags === undefined) delete process.env.FEATURE_FLAGS_OFF;
      else process.env.FEATURE_FLAGS_OFF = priorFlags;
      await f?.app.close();
      if (githubWorker) {
        githubWorker.worker.shutdown();
        await githubRunning;
      }
      if (defaultsWorker) {
        defaultsWorker.worker.shutdown();
        await defaultsRunning;
      }
      if (embeddingWorker) {
        embeddingWorker.worker.shutdown();
        await embeddingRunning;
      }
      await f?.close();
      await connection?.close();
      await clientConnection?.close();
      if (priorQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
      else process.env.TEMPORAL_TASK_QUEUE = priorQueue;
    }
  },
);
