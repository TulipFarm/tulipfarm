import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { browserSessionId } from '@tulipfarm/browser';
import { creditRates, registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { chatBrowserMeter, taskBrowserMeter } from '../src/browser-usage.ts';
import { createResourceBilling } from '../src/resource-billing.ts';

const pricing = { runPicoUsdPerHour: 60_000_000_000n, databasePicoUsdPerGibMonth: 0n, objectPicoUsdPerGibMonth: 0n };

test(
  'browser time is charged to its run or chat, and a run out of credits opens no new browser',
  { timeout: 120000 },
  async t => {
    await registerExtension(creditAccountExtension, { app: 'worker', env: {} });
    await registerExtension(
      {
        name: 'test-resource-meter',
        register(slots) {
          slots.resourceMeter({ pricing });
        },
      },
      { app: 'worker', env: {} },
    );
    const db = await fixture();
    let runtime;
    t.after(async () => {
      resetExtensions();
      await runtime?.close();
      await db.close();
    });
    await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
    await db.platform.query(
      await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8'),
    );
    const w = await db.create(await workspaceTableMigrations());
    const table = name => `"${w.names.schema}"."${name}"`;
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1,granted=$1`, ['100000000000000']);
    const owner = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      owner.membershipId,
      owner.userId,
    ]);
    const agent = await savedTaskAgent(db, w, runtime, owner.userId, owner.membershipId, [], ['browser.act']);
    const task = await createAgentTasks(runtime).start(w.id, owner.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope: [],
      text: 'Download the latest invoice.',
      limits: { toolCalls: 10, credits: 1, activeMilliseconds: 120000 },
    });
    const { flow_id: flowId } = (
      await db.platform.query(`SELECT flow_id::text FROM ${table('tf_agent_tasks')} WHERE id=$1`, [task.id])
    ).rows[0];

    const runSession = browserSessionId(w.id, { runId: task.id });
    const run = taskBrowserMeter(runtime)({ workspaceId: w.id, taskId: task.id, sessionId: runSession });
    assert.equal(await run.admit(), undefined);
    const now = Date.now();
    const openedAt = new Date(now - 90_000);
    await run.record({
      sessionId: runSession,
      url: 'about:blank',
      title: '',
      controller: 'agent',
      needsPerson: null,
      openedAt: openedAt.toISOString(),
      closesAt: new Date(now + 600_000).toISOString(),
    });
    await run.end();

    const chatId = randomUUID();
    const chatSession = browserSessionId(w.id, { conversationId: chatId });
    const chat = chatBrowserMeter(runtime)({ workspaceId: w.id, conversationId: chatId, sessionId: chatSession });
    // Opened a minute and a half ago and left: charged for the one minute until the host closed it idle.
    await chat.record({
      sessionId: chatSession,
      url: 'about:blank',
      title: '',
      controller: 'agent',
      needsPerson: null,
      openedAt: openedAt.toISOString(),
      closesAt: new Date(now - 30_000).toISOString(),
    });

    const billing = createResourceBilling({ runtime, discover: async after => (after ? [] : [w.id]), env: {} });
    await billing.meterCompute(new AbortController().signal);
    await billing.meterCompute(new AbortController().signal);
    const { rows } = await db.platform.query(
      `SELECT flow_id, model_id, charged::text FROM ${table('tf_credit_usage')} WHERE model_id='compute-browser' ORDER BY charged, flow_id`,
    );
    // A browser costs four run steps: 240,000,000,000 pico-USD an hour, so 4,000,000,000 a minute.
    const minute = 4_000_000_000n * creditRates().compute;
    assert.deepEqual(rows, [
      { flow_id: chatId, model_id: 'compute-browser', charged: (minute * 1n).toString() },
      { flow_id: flowId, model_id: 'compute-browser', charged: (minute * 2n).toString() },
    ]);

    // The run's own charges reach its one-credit allowance: no new browser opens.
    await db.platform.query(
      `INSERT INTO ${table('tf_credit_usage')} (id,flow_id,model_id,activity,reserved,charged,pricing_revision) VALUES ($1,$2,'model','agent',$3,$3,'test')`,
      [randomUUID(), flowId, '1000000000000'],
    );
    assert.equal(await run.admit(), 'allowance-used');
    assert.equal(await chat.admit(), undefined);
    await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=0`);
    assert.equal(await chat.admit(), 'out-of-credits');
  },
);
