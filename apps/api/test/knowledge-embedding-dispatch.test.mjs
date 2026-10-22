import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  registerKnowledgeEmbeddingDispatch,
  startKnowledgeEmbeddingWorkflow,
} from '../dist/knowledge-embedding-dispatch.js';

test('embedding workflow dispatch carries only IDs and allows SQL-directed reexecution', async () => {
  const work = { workspaceId: randomUUID(), jobId: randomUUID() };
  const starts = [];
  const temporal = {
    connection: { withDeadline: async (_deadline, operation) => operation() },
    client: { workflow: { start: async (name, options) => starts.push({ name, options }) } },
  };
  await startKnowledgeEmbeddingWorkflow(temporal, work);
  assert.equal(starts[0].name, 'knowledgeEmbed');
  assert.equal(starts[0].options.workflowId, `knowledge-embedding-${work.workspaceId}-${work.jobId}`);
  assert.equal(starts[0].options.taskQueue, `${process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-embeddings`);
  assert.deepEqual(starts[0].options.args, [work]);
  assert.equal(starts[0].options.workflowIdConflictPolicy, 'USE_EXISTING');
  assert.equal(starts[0].options.workflowIdReusePolicy, 'ALLOW_DUPLICATE');
  await assert.rejects(startKnowledgeEmbeddingWorkflow(temporal, { ...work, text: 'private' }));
  assert.equal(starts.length, 1);
});

test('embedding sweep discovers persisted work on startup without a user request', async () => {
  const app = Fastify();
  const work = { workspaceId: randomUUID(), jobId: randomUUID() };
  let finish;
  const started = new Promise(resolve => {
    finish = resolve;
  });
  const discovered = [];
  registerKnowledgeEmbeddingDispatch(app, {
    pool: { query: async () => ({ rows: [{ workspace_id: work.workspaceId }] }) },
    service: {
      due: async workspaceId => {
        discovered.push(workspaceId);
        return [work];
      },
    },
    temporal: {
      connection: { withDeadline: async (_deadline, operation) => operation() },
      client: { workflow: { start: async (name, options) => finish({ name, options }) } },
    },
  });
  try {
    await app.ready();
    const execution = await started;
    assert.equal(execution.name, 'knowledgeEmbed');
    assert.deepEqual(execution.options.args, [work]);
    assert.deepEqual(discovered, [work.workspaceId]);
  } finally {
    await app.close();
  }
});
