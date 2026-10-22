import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { Pool } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createPersonalMemoryService } from '@tulipfarm/conversations/personal-memory';
import { createRecommendationBudget } from '@tulipfarm/recommendations/budget';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { markWorkspaceReady } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { registerRecommendationDispatch } from '../../api/src/recommendation-dispatch.ts';
import { registerRecommendations } from '../../api/src/recommendations.ts';
import { createRecommendationActivities } from '../src/recommendation-activities.ts';

test(
  'committed changes travel through the real dispatcher and Temporal worker, never GET',
  { timeout: 60000 },
  async () => {
    const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
    assert.ok(address, 'Owned Temporal is required');
    const f = await conversationFixture();
    let native, connection, pool, app;
    const previousQueue = process.env.TEMPORAL_TASK_QUEUE;
    try {
      process.env.TEMPORAL_TASK_QUEUE = `recommendation-fixture-${randomUUID()}`;
      const { id: workspaceId, membershipId, userId } = f.workspace;
      const blockedMember = '00000000-0000-4000-8000-000000000001',
        blockedUser = randomUUID();
      await markWorkspaceReady(f.db.platform, workspaceId);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        randomUUID(),
        randomUUID(),
      ]);
      await f.db.platform.query(
        `INSERT INTO app.users(id,name,email,canonical_email,email_verified)
      VALUES($1,'Fixture blocked','blocked@example.test','blocked@example.test',true)`,
        [blockedUser],
      );
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        blockedMember,
        blockedUser,
      ]);
      pool = new Pool({ connectionString: f.db.connectionString, max: 3 });
      const budget = createRecommendationBudget(pool, {
        workspacePicoUsd: '100',
        platformPicoUsd: '100',
        periodSeconds: 3600,
      });
      native = await NativeConnection.connect({ address });
      connection = await Connection.connect({ address });
      const client = new Client({ connection });
      let calls = 0;
      const activities = createRecommendationActivities({
        runtime: f.runtime,
        budget,
        eligible: async () => true,
        log: () => {},
        model: {
          modelId: 'fixture/model',
          generate: async (_context, _slots, meter) => {
            const settle = await meter('10');
            calls++;
            await settle('3');
            return JSON.stringify([
              {
                id: 'generated-live',
                kind: 'prompt',
                label: 'Plan a short checklist',
                brands: [],
                action: { kind: 'prompt', prompt: 'Help me plan a short checklist.' },
                sources: [`memory:${membershipId}`],
              },
            ]);
          },
        },
      });
      const workflowsPath = fileURLToPath(new URL('../dist/recommendation-workflows.js', import.meta.url));
      const worker = await Worker.create({
        connection: native,
        taskQueue: `${process.env.TEMPORAL_TASK_QUEUE}-recommendations`,
        workflowsPath,
        activities,
      });
      app = Fastify();
      registerRecommendations(app, {
        runtime: f.runtime,
        eligible: async () => true,
        auth: { api: { getSession: async () => ({ user: { id: userId } }) } },
      });
      let blockedStarts = 0;
      registerRecommendationDispatch(app, {
        runtime: f.runtime,
        pool,
        temporal: {
          connection,
          client: {
            workflow: {
              signalWithStart: (workflow, options) => {
                if (options.args[1] === blockedMember) {
                  blockedStarts++;
                  throw new Error('fixture member delivery unavailable');
                }
                return client.workflow.signalWithStart(workflow, options);
              },
            },
          },
        },
      });
      const read = async () => {
        const response = await app.inject(`/workspaces/${workspaceId}/recommendations`);
        assert.equal(response.statusCode, 200);
        return response.json();
      };
      await worker.runUntil(async () => {
        await app.ready();
        for (let i = 0; i < 4; i++) assert.equal((await read()).status, 'unavailable');
        assert.equal(calls, 0);
        assert.equal(
          (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_recommendation_events')}`))
            .rows[0].count,
          0,
        );
        const memory = createPersonalMemoryService(f.runtime);
        await memory.save(workspaceId, userId, {
          content: 'Private fixture preference never stored in workflow history.',
          expectedRevision: 0,
        });
        await memory.save(workspaceId, blockedUser, { content: 'Another private preference.', expectedRevision: 0 });
        assert.equal((await read()).status, 'pending');
        await f.db.platform.query(
          `UPDATE ${f.table('tf_recommendation_refresh')} SET due_at=clock_timestamp()-interval '1 second'`,
        );
        for (let i = 0; ; i++) {
          if ((await read()).status === 'ready') break;
          assert.ok(i < 200, 'queued event is delivered without page-triggered work');
          await delay(50);
        }
        assert.equal(calls, 1);
        assert.ok(blockedStarts > 0, 'one failed member delivery does not starve later members');
        for (let i = 0; i < 10; i++) assert.equal((await read()).items.at(-1).id, 'generated-live');
        assert.equal(calls, 1);
        const handle = client.workflow.getHandle(`recommendations-v1-${workspaceId}-${membershipId}`);
        await handle.result();
        const history = await handle.fetchHistory();
        const encoded = JSON.stringify(history, (_key, value) =>
          value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value,
        );
        assert.doesNotMatch(encoded, /Private fixture preference|Plan a short checklist|Help me plan/);
        await Worker.runReplayHistory({ workflowsPath }, history);
        await memory.delete(workspaceId, userId, { expectedRevision: 1 });
        assert.equal(
          (await read()).items.some(item => item.id === 'generated-live'),
          false,
        );
        assert.equal(calls, 1);
        await app.close();
      });
    } finally {
      if (previousQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
      else process.env.TEMPORAL_TASK_QUEUE = previousQueue;
      await app?.close();
      await connection?.close();
      await native?.close();
      await pool?.end();
      await f.close();
    }
  },
);
