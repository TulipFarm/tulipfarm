import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { savedTaskAgent } from '../../agents/test/task-fixture.mjs';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

test(
  'an agent step starts a sponsor task, waits, and makes its result available to later steps',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const workspace = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
      });
      const calls = [],
        taskId = randomUUID();
      let status = 'pending',
        pauseReason = null,
        readable = true;
      const service = createWorkflows(runtime, {
        agentResultReadable: async () => readable,
        agentTasks: {
          start: async (workspaceId, user, value) => {
            calls.push({ workspaceId, user, value });
            return { id: taskId };
          },
          result: async () => ({ status, pauseReason, ...(status === 'completed' ? { text: 'Draft reply' } : {}) }),
        },
      });
      const { agentId } = await savedTaskAgent(db, workspace, runtime, workspace.userId, workspace.membershipId);
      const id = randomUUID(),
        revision = randomUUID();
      await service.save(workspace.id, workspace.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Draft support reply',
          trigger: { kind: 'manual' },
          steps: [
            {
              id: 'draft',
              kind: 'agent',
              agentId,
              prompt: { kind: 'input', path: ['message'] },
              limits: { toolCalls: 12, activeMilliseconds: 6000, credits: 4 },
            },
            { id: 'result', kind: 'transform', fields: { reply: { kind: 'step', step: 'draft', path: ['result'] } } },
          ],
        },
      });
      await activate(service, workspace.id, workspace.userId, id, revision, true);
      const run = await service.start(workspace.id, workspace.userId, id, {
        requestId: randomUUID(),
        input: { message: 'Please draft a reply' },
      });
      assert.deepEqual(await service.advance({ workspaceId: workspace.id, runId: run.runId }), {
        kind: 'wait',
        seconds: 2,
      });
      assert.deepEqual(calls, [
        {
          workspaceId: workspace.id,
          user: workspace.userId,
          value: {
            requestId: calls[0].value.requestId,
            agentId,
            text: 'Please draft a reply',
            limits: { toolCalls: 12, activeMilliseconds: 6000, credits: 4 },
          },
        },
      ]);
      assert.deepEqual(await service.advance({ workspaceId: workspace.id, runId: run.runId }), {
        kind: 'wait',
        seconds: 2,
      });
      status = 'paused';
      pauseReason = 'limit.credits';
      assert.deepEqual(await service.advance({ workspaceId: workspace.id, runId: run.runId }), {
        kind: 'wait',
        seconds: 2,
      });
      const [paused] = (await service.history(workspace.id, workspace.userId, id)).runs;
      assert.equal(paused.status, 'waiting');
      assert.deepEqual(paused.steps[0].output, { taskId, status: 'paused', pauseReason: 'limit.credits' });
      status = 'waiting-approval';
      pauseReason = null;
      assert.deepEqual(await service.advance({ workspaceId: workspace.id, runId: run.runId }), {
        kind: 'wait',
        seconds: 2,
      });
      assert.deepEqual((await service.history(workspace.id, workspace.userId, id)).runs[0].steps[0].output, {
        taskId,
        status: 'waiting-approval',
        pauseReason: null,
      });
      assert.equal(calls.length, 1, 'resuming agent work retains the original task');
      status = 'completed';
      assert.deepEqual(await service.advance({ workspaceId: workspace.id, runId: run.runId }), { kind: 'continue' });
      assert.deepEqual(await service.advance({ workspaceId: workspace.id, runId: run.runId }), { kind: 'continue' });
      assert.deepEqual(await service.advance({ workspaceId: workspace.id, runId: run.runId }), { kind: 'done' });
      const [history] = (await service.history(workspace.id, workspace.userId, id)).runs;
      assert.deepEqual(
        history.steps.map(step => step.output),
        [{ taskId, result: 'Draft reply' }, { reply: 'Draft reply' }],
      );
      readable = false;
      const [withheld] = (await service.history(workspace.id, workspace.userId, id)).runs;
      assert.deepEqual(
        withheld.steps.map(step => step.output),
        [{ withheld: 'source-access' }, { withheld: 'source-access' }],
        'a reader who cannot open the agent result sources sees neither it nor the step that copied it',
      );
      assert.deepEqual(
        (await service.runDetail(workspace.id, workspace.userId, id, withheld.id)).run.steps,
        withheld.steps,
        'detail and history apply identical output withholding',
      );
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
