import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { Pool } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { markWorkspaceReady } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { registerConversations } from '../../api/src/conversations.ts';
import { registerConversationDispatch } from '../../api/src/conversation-dispatch.ts';
import { createConversationMaintenanceActivities } from '../src/conversation-maintenance-activities.ts';

test(
  'API sweep dispatches real Temporal maintenance and an eligible project member resumes to real Knowledge publication',
  { timeout: 60000 },
  async () => {
    const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
    assert.ok(address, 'Owned Temporal is required');
    const f = await conversationFixture();
    const previousQueue = process.env.TEMPORAL_TASK_QUEUE;
    let native, connection, pool, app;
    try {
      process.env.TEMPORAL_TASK_QUEUE = `conversation-maintenance-fixture-${randomUUID()}`;
      const w = f.workspace,
        projectId = randomUUID(),
        id = randomUUID(),
        memberId = randomUUID(),
        memberUser = randomUUID(),
        outsider = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'admin')`,
        [memberId, memberUser, randomUUID(), outsider],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_projects')} (id,name,creator_membership_id) VALUES ($1,'Launch',$2)`,
        [projectId, w.membershipId],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_project_members')} (project_id,membership_id,role) VALUES ($1,$2,'manager'),($1,$3,'member')`,
        [projectId, w.membershipId, memberId],
      );
      await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID(), projectId });
      const sent = await f.store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Private launch details: ship Tuesday.' }],
      });
      assert.equal(
        await createConversationExecutor(f.runtime, async () => ({
          text: 'Send invitations.',
          sources: [{ kind: 'private-conversation', conversationId: id }],
        })).process({ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversations')} SET activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
        [id],
      );
      await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        w.membershipId,
      ]);
      await markWorkspaceReady(f.db.platform, w.id);
      native = await NativeConnection.connect({ address });
      connection = await Connection.connect({ address });
      const client = new Client({ connection });
      pool = new Pool({ connectionString: f.db.connectionString, max: 3 });
      let modelCalls = 0;
      const activities = createConversationMaintenanceActivities(f.runtime, {
        compactor: {
          policy: async () => ({
            automatic: false,
            triggerPercent: 70,
            targetPercent: 30,
            outputPrompt: null,
            revision: 0,
            families: ['claude-haiku'],
          }),
          measure: async () => ({ tokens: 100, window: 100000 }),
          window: async () => 100000,
          summarize: async input => {
            modelCalls++;
            if (input.purpose === 'memory')
              return { text: '{"content":"","evidence":[]}', familyId: 'claude-haiku', fallbackFrom: null };
            return {
              text:
                input.purpose === 'summary'
                  ? JSON.stringify({ goal: 'Ship Tuesday', openWork: ['Send invitations'] })
                  : '## Goal\nShip Tuesday\n## Open work\nSend invitations',
              familyId: 'claude-haiku',
              fallbackFrom: null,
            };
          },
        },
      });
      const workflowsPath = fileURLToPath(new URL('../dist/conversation-maintenance-workflows.js', import.meta.url));
      const worker = await Worker.create({
        connection: native,
        taskQueue: process.env.TEMPORAL_TASK_QUEUE,
        workflowsPath,
        activities,
      });
      let actingUser = memberUser;
      const handles = [];
      app = Fastify();
      registerConversations(app, {
        service: f.store,
        auth: { api: { getSession: async () => ({ user: { id: actingUser } }) } },
      });
      registerConversationDispatch(app, {
        pool,
        runtime: f.runtime,
        temporal: {
          connection,
          client: {
            workflow: {
              start: async (name, options) => {
                assert.equal(name, 'conversationMaintenance');
                const handle = await client.workflow.start(name, options);
                handles.push(handle);
                return handle;
              },
            },
          },
        },
      });
      const base = `/workspaces/${w.id}/conversations/${id}`;
      const get = async () => {
        const response = await app.inject(`${base}/maintenance`);
        assert.equal(response.statusCode, 200, response.body);
        return response.json().maintenance;
      };
      const waitFor = async state => {
        for (let attempt = 0; ; attempt++) {
          const status = await get();
          if (status?.state === state) return status;
          assert.ok(attempt < 300, `maintenance reaches ${state}`);
          await delay(50);
        }
      };
      await worker.runUntil(async () => {
        await app.ready();
        const blocked = await waitFor('blocked');
        assert.equal(blocked.errorCode, 'access-denied');
        assert.equal(modelCalls, 0, 'removed authority never reaches the model');
        actingUser = outsider;
        assert.equal((await app.inject(`${base}/maintenance`)).statusCode, 404, 'admin does not gain project access');
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: `${base}/maintenance`,
              headers: { origin: 'http://localhost:5173' },
              payload: { commandId: randomUUID() },
            })
          ).statusCode,
          404,
        );
        actingUser = memberUser;
        const commandId = randomUUID();
        const resume = () =>
          app.inject({
            method: 'PUT',
            url: `${base}/maintenance`,
            headers: { origin: 'http://localhost:5173' },
            payload: { commandId },
          });
        assert.equal((await resume()).statusCode, 200);
        assert.equal((await resume()).statusCode, 200, 'same command replays without a second resume');
        const ready = await waitFor('ready');
        assert.equal(modelCalls, 2);
        const row = (
          await f.db.platform.query(
            `SELECT requester_membership_id,document_id FROM ${f.table('tf_conversation_maintenance')} WHERE id=$1`,
            [ready.id],
          )
        ).rows[0];
        assert.equal(row.requester_membership_id, memberId);
        const documents = (
          await f.db.platform.query(
            `SELECT id,lexical_publication_id FROM ${f.table('tf_knowledge_documents')} WHERE id=$1`,
            [row.document_id],
          )
        ).rows;
        assert.equal(documents.length, 1);
        assert.ok(documents[0].lexical_publication_id);
        const recap = await app.inject(`${base}/compactions/${ready.compactionId}`);
        assert.equal(recap.statusCode, 200);
        assert.match(recap.json().handoff.text, /Ship Tuesday/);
        await app.close();
        const results = await Promise.all(handles.map(handle => handle.result()));
        assert.ok(results.includes('blocked'));
        assert.ok(results.includes('ready'));
        const history = await handles.at(-1).fetchHistory();
        const encoded = JSON.stringify(history, (_key, value) =>
          value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value,
        );
        assert.doesNotMatch(encoded, /Private launch details|Ship Tuesday|Send invitations/);
        await Worker.runReplayHistory({ workflowsPath }, history);
        assert.equal(modelCalls, 2, 'workflow replay never repeats model work');
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
