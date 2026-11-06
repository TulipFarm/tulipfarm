import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createChatExecution } from '../src/chat-execution.ts';

const profile = { id: 'small', resources: { kind: 'limited', cpuMillis: 1000, memoryMiB: 512, diskBytes: 1048576 } };
const configuration = {
  mode: 'extension',
  policyRevision: 'a'.repeat(64),
  policy: {
    version: 1,
    baseRevision: 'b'.repeat(64),
    defaultProfile: 'small',
    profiles: [profile],
    network: 'public-only',
    idleTimeoutSeconds: 300,
    limits: { jobTimeoutSeconds: 30, stopGraceSeconds: 1 },
  },
};
const chunk = (sequence, stream, text) => ({
  kind: 'chunk',
  sequence,
  stream,
  data: Buffer.from(text).toString('base64'),
});

function fakeBackend({ events, finish }) {
  const calls = [];
  let polls = 0;
  return {
    calls,
    backend: {
      prepare: async input => (calls.push(['prepare', input]), { state: 'preparing' }),
      inspect: async () => ({ state: 'ready' }),
      startJob: async input => (calls.push(['startJob', input]), { state: 'running' }),
      inspectJob: async () => (++polls < 2 ? { state: 'running' } : finish),
      async *readOutput(input) {
        calls.push(['readOutput', input.after]);
        yield* events.filter(event => event.sequence > input.after).slice(0, 2);
      },
      destroy: async input => (calls.push(['destroy', input]), { state: 'stopped' }),
    },
  };
}

test('A chat snippet runs in a fresh allocation, collects every output page, and destroys the allocation', async () => {
  const { backend, calls } = fakeBackend({
    events: [
      chunk(1, 'stdout', '1250'),
      chunk(2, 'stderr', 'warn'),
      chunk(3, 'stdout', '2500\n'),
      { kind: 'end', sequence: 4 },
    ],
    finish: { state: 'completed', exitCode: 0 },
  });
  const conversationId = randomUUID();
  const result = await createChatExecution(
    backend,
    configuration,
  )({
    conversationId,
    language: 'python',
    code: 'print(sum(range(1, 5001)))',
  });
  assert.deepEqual(result, { state: 'completed', exitCode: 0, stdout: '12502500\n', stderr: 'warn', truncated: false });
  const [, prepared] = calls.find(([name]) => name === 'prepare');
  assert.equal(prepared.areaId, conversationId);
  assert.deepEqual(prepared.profile, profile);
  const [, started] = calls.find(([name]) => name === 'startJob');
  assert.deepEqual(started.command, { program: 'python3', args: ['-c', 'print(sum(range(1, 5001)))'] });
  assert.deepEqual(
    calls.filter(([name]) => name === 'readOutput').map(([, after]) => after),
    [0, 2],
  );
  assert.equal(calls.at(-1)[0], 'destroy');
  assert.equal(calls.at(-1)[1].allocationId, prepared.allocationId);
});

test('A failed job still destroys its allocation', async () => {
  const { backend, calls } = fakeBackend({ events: [], finish: { state: 'completed', exitCode: 0 } });
  backend.startJob = async () => {
    throw new Error('backend-down');
  };
  await assert.rejects(
    createChatExecution(backend, configuration)({ conversationId: randomUUID(), language: 'bash', code: 'true' }),
    /backend-down/,
  );
  assert.equal(calls.at(-1)[0], 'destroy');
});
