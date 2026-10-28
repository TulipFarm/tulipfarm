import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeEmbeddingWorker } from '../dist/knowledge-embedding-composition.js';

test('empty embedding config does not create a worker or access registry credentials, storage, quota, or provider', async () => {
  const forbidden = () => {
    throw new Error('Disabled embeddings touched a dependency');
  };
  const env = new Proxy(
    {},
    { get: (_target, name) => (name === 'WORKSPACE_AUTHORING_DATABASE_URL' ? forbidden() : undefined) },
  );
  assert.equal(
    await createKnowledgeEmbeddingWorker({
      env,
      runtime: { transaction: forbidden },
      connection: {},
      pool: { query: forbidden, connect: forbidden },
      provider: forbidden,
      createWorker: forbidden,
    }),
    undefined,
  );
});

test('enabled embedding worker uses a separate task queue and caller-owned registry pool', async () => {
  const env = {
    KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
    AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
    AZURE_FOUNDRY_API_KEY: 'fixture-only',
    TEMPORAL_TASK_QUEUE: 'runtime-proof',
    TEMPORAL_NAMESPACE: 'test',
  };
  let options;
  const worker = { run: async () => {} };
  const forbidden = () => {
    throw new Error('Composition must not perform work');
  };
  const composed = await createKnowledgeEmbeddingWorker({
    env,
    runtime: { transaction: forbidden },
    connection: {},
    pool: { query: forbidden, connect: forbidden, end: forbidden },
    provider: forbidden,
    createWorker: async input => {
      options = input;
      return worker;
    },
  });
  assert.equal(composed.worker, worker);
  assert.equal(options.taskQueue, 'runtime-proof-knowledge-embeddings');
  assert.equal(options.namespace, 'test');
  assert.match(options.workflowsPath, /knowledge-embedding-workflows\.js$/);
  assert.deepEqual(Object.keys(options.activities), ['processKnowledgeEmbedding']);
  assert.equal(options.maxConcurrentActivityTaskExecutions, 2);
  await composed.close();
});

test('an embedding service without serve builds no worker', async () => {
  const forbidden = () => {
    throw new Error('Composition must not perform work');
  };
  const composed = await createKnowledgeEmbeddingWorker({
    env: {
      KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
      AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
      AZURE_FOUNDRY_API_KEY: 'fixture-only',
    },
    runtime: { transaction: forbidden },
    connection: {},
    pool: { query: forbidden, connect: forbidden, end: forbidden },
    provider: forbidden,
    createWorker: forbidden,
    serve: false,
  });
  assert.equal(composed.worker, undefined);
  assert.equal(typeof composed.service, 'object');
  await composed.close();
});
