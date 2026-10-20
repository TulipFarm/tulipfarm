import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Client, Connection } from '@temporalio/client';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '@tulipfarm/workflows';
import { businessWorkflowId } from '@tulipfarm/workflows/contracts';
import { createConversations } from '@tulipfarm/conversations';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createChatTools } from '@tulipfarm/agents/tools';
import { createAuthoringDrafts } from '@tulipfarm/agents/drafts';
import { workflowWake } from '../src/workflow-dispatch.ts';

const { Worker, NativeConnection } = createRequire(new URL('../../worker/package.json', import.meta.url))(
  '@temporalio/worker',
);
const address = process.env.TASK_TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';

test('disabling a workflow from a chat card ends its waiting run on real Temporal', { timeout: 120000 }, async () => {
  const db = await fixture();
  let runtime, app, native, connection, worker, running;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const service = createWorkflows(runtime),
      id = randomUUID(),
      revision = randomUUID();
    const definition = {
      version: 1,
      name: 'Long pause',
      trigger: { kind: 'manual' },
      steps: [{ id: 'pause', kind: 'delay', seconds: 300 * 86400 }],
    };
    const saved = await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
    await service.activate(w.id, w.userId, id, {
      commandId: randomUUID(),
      expectedGeneration: saved.generation,
      revision,
      enabled: true,
    });

    native = await NativeConnection.connect({ address });
    connection = await Connection.connect({ address });
    const client = new Client({ connection }),
      taskQueue = `workflow-chat-wake-${randomUUID()}`;
    worker = await Worker.create({
      connection: native,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../../../packages/workflows/src/temporal.ts', import.meta.url)),
      activities: { advanceWorkflow: service.advance },
    });
    running = worker.run();

    const { runId } = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: {} });
    const work = { workspaceId: w.id, runId };
    const handle = await client.workflow.start('businessWorkflowV1', {
      workflowId: businessWorkflowId(work),
      taskQueue,
      args: [work],
    });
    for (let attempt = 0; ; attempt++) {
      if ((await handle.fetchHistory()).events.some(event => event.timerStartedEventAttributes)) break;
      if (attempt >= 200) assert.fail('run reached its 300-day timer');
      await delay(50);
    }

    app = Fastify({ logger: false });
    const drafts = createAuthoringDrafts(runtime, undefined, workflowWake(app, { connection, client }));
    const chats = createConversations(runtime),
      chatId = randomUUID();
    await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const { turnId } = await chats.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Turn off the long pause workflow.' }],
    });
    const call = { tool: 'workflows.draft', workflowId: id, activate: false };
    let proposal;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      proposal = await executeTool(call.tool, false, context => createChatTools(context.runtime).invoke(context, call));
      return { text: 'Review the workflow card.', sources: [] };
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId, generation: 0 }),
      'completed',
    );
    assert.equal(proposal.status, 'review-required');

    const outcome = await drafts.decide(w.id, w.userId, chatId, proposal.draftId, {
      commandId: randomUUID(),
      digest: proposal.digest,
      decision: 'save',
    });
    assert.equal(outcome.activation, 'disabled');
    assert.notEqual(
      await Promise.race([handle.result(), delay(10000, 'timeout', { ref: false })]),
      'timeout',
      'the waiting run ended promptly after the chat approval',
    );
    const [run] = await service.history(w.id, w.userId, id).then(page => page.runs);
    assert.deepEqual([run.id, run.status, run.error], [runId, 'blocked', 'workflow-disabled']);
    assert.ok(
      (await handle.fetchHistory()).events.some(event => event.timerCanceledEventAttributes),
      'the wake interrupted the timer',
    );
  } finally {
    await app?.close();
    if (worker) {
      worker.shutdown();
      await running;
    }
    await native?.close();
    await connection?.close();
    await runtime?.close();
    await db.close();
  }
});
