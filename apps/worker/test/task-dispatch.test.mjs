import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createTaskRecovery } from '../src/task-dispatch.ts';

test('worker recovery pages pending tasks, skips waits, and isolates a broken task', async () => {
  const workspaceId = randomUUID(),
    ids = Array.from({ length: 100 }, () => randomUUID()).sort();
  const wakes = [],
    failures = [],
    pages = [];
  const recovery = createTaskRecovery({
    discover: async after => {
      assert.equal(after, null);
      return [workspaceId];
    },
    runtime: {
      transaction: async (workspace, _range, operation) => {
        assert.equal(workspace, workspaceId);
        return operation({
          schema: 'fixture',
          client: {
            query: async (sql, args) => {
              if (sql.includes('ORDER BY id LIMIT 100')) {
                pages.push(args[0]);
                return { rows: args[0] ? [] : ids.map(id => ({ id })) };
              }
              if (sql.includes('SELECT id,generation,status')) {
                if (args[0] === ids[2]) throw new Error('PRIVATE_DATABASE_CANARY');
                return {
                  rows: [
                    {
                      id: args[0],
                      generation: 0,
                      status: args[0] === ids[1] ? 'waiting-clarification' : args[0] === ids[3] ? 'paused' : 'pending',
                    },
                  ],
                };
              }
              if (sql.includes('SELECT c.attempt_id,c.observation') && args[0] === ids[3]) {
                return {
                  rows: [
                    {
                      attempt_id: randomUUID(),
                      observation: { actualModel: null, requestId: null, usage: { kind: 'unknown' } },
                    },
                  ],
                };
              }
              return { rows: [] };
            },
          },
        });
      },
    },
    wake: async (...args) => wakes.push(args),
    failure: (...args) => failures.push(args),
  });
  assert.deepEqual(await recovery.discoverAgentTaskWorkspaces(null), [workspaceId]);
  const after = await recovery.recoverAgentTaskPage(workspaceId);
  assert.equal(after, ids.at(-1));
  assert.equal(await recovery.recoverAgentTaskPage(workspaceId, after), null);
  assert.deepEqual(pages, [null, ids.at(-1)]);
  assert.equal(wakes.length, 98);
  assert.ok(
    wakes.some(([, taskId]) => taskId === ids[3]),
    'Paused tasks with late accounting still dispatch',
  );
  assert.deepEqual(failures, [[workspaceId, ids[2]]]);
});

test('worker recovery redacts registry and workspace failures before Temporal storage', async () => {
  const recovery = createTaskRecovery({
    runtime: {
      transaction: async () => {
        throw new Error('PRIVATE_DATABASE_CANARY');
      },
    },
    discover: async () => {
      throw new Error('PRIVATE_REGISTRY_CANARY');
    },
    wake: async () => assert.fail('No work after a failed read'),
    failure: () => {},
  });
  await assert.rejects(
    recovery.discoverAgentTaskWorkspaces(null),
    error =>
      error.message === 'task-discovery-unavailable' && !JSON.stringify(error).includes('PRIVATE_REGISTRY_CANARY'),
  );
  await assert.rejects(
    recovery.recoverAgentTaskPage(randomUUID()),
    error =>
      error.message === 'task-recovery-unavailable' && !JSON.stringify(error).includes('PRIVATE_DATABASE_CANARY'),
  );
});
