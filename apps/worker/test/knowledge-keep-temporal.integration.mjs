import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { KnowledgeKeepUnavailable, keepKnowledgeMaxTimeouts } from '@tulipfarm/knowledge';
import { startKnowledgeKeepWorkflow } from '../../api/dist/knowledge-keep-dispatch.js';
import { createKnowledgeKeepActivities } from '../dist/knowledge-keep-activities.js';
import { createKnowledgeWorker } from '../dist/knowledge-worker.js';

async function withWorker(feed, run) {
  const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const oldQueue = process.env.TEMPORAL_TASK_QUEUE;
  const queue = `keep-proof-${randomUUID()}`;
  process.env.TEMPORAL_TASK_QUEUE = queue;
  let connection, clientConnection, worker, running;
  try {
    connection = await NativeConnection.connect({ address });
    clientConnection = await Connection.connect({ address });
    const client = new Client({ connection: clientConnection });
    worker = await createKnowledgeWorker({
      connection,
      env: { TEMPORAL_TASK_QUEUE: queue },
      parts: { keep: createKnowledgeKeepActivities(feed) },
    });
    running = worker.run();
    await run({ client, clientConnection, taskQueue: `${queue}-knowledge` });
  } finally {
    if (worker) {
      worker.shutdown();
      await running;
    }
    await connection?.close();
    await clientConnection?.close();
    if (oldQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
    else process.env.TEMPORAL_TASK_QUEUE = oldQueue;
  }
}

function fakeFeed(workspaceId, ids, fail) {
  const due = new Set(ids);
  const attempts = new Map();
  const failures = [];
  const pages = [];
  const syncs = [];
  const timeouts = new Map();
  return {
    syncs,
    due,
    attempts,
    failures,
    pages,
    feed: {
      due: async (workspace, after, limit) => {
        assert.equal(workspace, workspaceId);
        pages.push(after);
        return [...due]
          .filter(id => after === null || id > after)
          .slice(0, limit)
          .map(document_id => ({ document_id, action: 'deliver' }));
      },
      sync: async (workspace, document) => {
        attempts.set(document, (attempts.get(document) ?? 0) + 1);
        syncs.push(document);
        fail(document, attempts.get(document));
        due.delete(document);
        return { status: 'delivered', publicationId: randomUUID() };
      },
      recordFailure: async (workspace, document, error, kind) => {
        failures.push({ document, error, kind });
        // Like the feed: a timeout counts as Keep being busy until it repeats on the same document.
        if (kind !== 'busy') return kind;
        const count = (timeouts.get(document) ?? 0) + 1;
        timeouts.set(document, count);
        return count < keepKnowledgeMaxTimeouts ? 'keep' : 'document';
      },
    },
  };
}

test(
  'Keep sync continues past failing documents, recording each once, and pages through the rest',
  { timeout: 120000 },
  async () => {
    const workspaceId = randomUUID();
    const [slow, broken, ...rest] = Array.from({ length: 103 }, () => randomUUID()).toSorted();
    const fake = fakeFeed(workspaceId, [slow, broken, ...rest], document => {
      if (document === slow) throw new KnowledgeKeepUnavailable('invalid_response');
      if (document === broken) throw new Error('unexpected state');
    });
    await withWorker(fake.feed, async ({ client, clientConnection }) => {
      await startKnowledgeKeepWorkflow({ connection: clientConnection, client }, workspaceId);
      await client.workflow.getHandle(`knowledge-keep-${workspaceId}`).result();
    });
    assert.equal(fake.attempts.get(slow), 1, 'a document failure backs off in the feed instead of retrying at once');
    assert.equal(fake.attempts.get(broken), 1);
    assert.deepEqual(fake.failures, [
      { document: slow, error: 'Keep unavailable: invalid_response', kind: 'document' },
      { document: broken, error: 'unexpected state', kind: 'permanent' },
    ]);
    assert.deepEqual([...fake.due], [slow, broken], 'every later document was still delivered');
    assert.deepEqual(fake.pages, [null, rest[97]]);
  },
);

test('Keep sync waits out an unreachable Keep and resumes with the same document', { timeout: 120000 }, async () => {
  const workspaceId = randomUUID();
  const [first, second] = [randomUUID(), randomUUID()].toSorted();
  const fake = fakeFeed(workspaceId, [first, second], (document, attempt) => {
    if (document === first && attempt <= 2) throw new KnowledgeKeepUnavailable('unreachable');
  });
  await withWorker(fake.feed, async ({ client, taskQueue }) => {
    const handle = await client.workflow.start('knowledgeKeepSync', {
      taskQueue,
      workflowId: `knowledge-keep-${workspaceId}`,
      args: [{ workspaceId, outageWait: 200 }],
    });
    await handle.result();
  });
  assert.equal(fake.attempts.get(first), 3);
  assert.equal(fake.attempts.get(second), 1, 'later documents wait for Keep rather than failing too');
  assert.deepEqual(
    fake.failures.map(failure => [failure.document, failure.kind]),
    [
      [first, 'keep'],
      [first, 'keep'],
    ],
  );
  assert.deepEqual([...fake.due], []);
  assert.deepEqual(fake.pages, [null, null, null]);
});

test(
  'Keep sync waits when Keep times out and retries the same document, moving on after repeated timeouts',
  { timeout: 120000 },
  async () => {
    const workspaceId = randomUUID();
    const [stuck, busy, last] = [randomUUID(), randomUUID(), randomUUID()].toSorted();
    const fake = fakeFeed(workspaceId, [stuck, busy, last], (document, attempt) => {
      if (document === stuck || (document === busy && attempt === 1)) throw new KnowledgeKeepUnavailable('timeout');
    });
    await withWorker(fake.feed, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start('knowledgeKeepSync', {
        taskQueue,
        workflowId: `knowledge-keep-${workspaceId}`,
        args: [{ workspaceId, outageWait: 200 }],
      });
      await handle.result();
    });
    assert.deepEqual(
      fake.syncs,
      [...Array(keepKnowledgeMaxTimeouts).fill(stuck), busy, busy, last],
      'no later document is sent while Keep is busy',
    );
    assert.ok(
      fake.failures.every(failure => failure.kind === 'busy' && failure.error === 'Keep unavailable: timeout'),
      'a timeout is reported as Keep being busy',
    );
    assert.deepEqual([...fake.due], [stuck], 'the document that kept timing out is left to back off');
    assert.deepEqual(fake.pages, [...Array(keepKnowledgeMaxTimeouts).fill(null), stuck]);
  },
);
