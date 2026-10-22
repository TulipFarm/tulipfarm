import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { createSnippetBroker } from '../src/broker.ts';
import { createSnippetClient, configuredSnippetClient } from '../src/client.ts';

const image = process.env.SNIPPET_TEST_IMAGE;
function job(overrides = {}) {
  return {
    workspaceId: randomUUID(),
    runId: randomUUID(),
    revision: randomUUID(),
    stepId: 'code',
    language: 'javascript',
    source: 'return {value: input.value + 1};',
    input: { value: 4 },
    ...overrides,
  };
}
async function complete(client, request) {
  for (let i = 0; i < 300; i++) {
    const result = await client.submit(request);
    if (result.kind !== 'pending') return result;
    await setTimeout(100);
  }
  throw new Error('broker did not complete');
}

test(
  'authenticated broker executes, enforces limits and replays persisted results after restart',
  { timeout: 120000 },
  async () => {
    assert.ok(image, 'SNIPPET_TEST_IMAGE required');
    const directory = await mkdtemp(join(tmpdir(), 'snippet-broker-')),
      database = join(directory, 'jobs.sqlite');
    const token = randomBytes(32).toString('hex'),
      options = { database, token, image, runtime: 'runc', allowLocalRunc: true, timeoutMs: 10000 };
    let broker;
    try {
      broker = await createSnippetBroker(options);
      await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
      let url = `http://127.0.0.1:${broker.server.address().port}`;
      let client = createSnippetClient({ url, token, allowLocalHttp: true });
      const request = job();
      const post = (body, auth = `Bearer ${token}`) =>
        fetch(`${url}/v1/jobs`, {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/json' },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
      assert.equal((await post(request, '')).status, 401);
      assert.equal((await post(request, `Bearer ${'0'.repeat(64)}`)).status, 401);
      assert.equal((await post({ ...request, unexpected: true })).status, 400);
      assert.equal((await post('{')).status, 400);
      assert.equal((await post(' '.repeat(131073))).status, 413);
      assert.equal((await post({ ...request, input: 'x'.repeat(32769) })).status, 400);
      await assert.rejects(createSnippetBroker(options), /locked/);
      assert.deepEqual(await complete(client, request), { kind: 'completed', output: { value: 5 } });
      assert.equal((await post({ ...request, source: 'return 99;' })).status, 409);
      assert.deepEqual(
        await complete(client, job({ language: 'python', source: 'return {"value": input["value"] * 3}' })),
        { kind: 'completed', output: { value: 12 } },
      );
      assert.deepEqual(await complete(client, job({ source: 'return "x".repeat(40000);' })), {
        kind: 'failed',
        error: 'output-limit',
      });
      const unicode = `/*${'界'.repeat(10900)}*/return input`;
      assert.deepEqual(await complete(client, job({ source: unicode, input: 'x'.repeat(32766) })), {
        kind: 'completed',
        output: 'x'.repeat(32766),
      });
      assert.deepEqual(await complete(client, job({ source: 'return "界".repeat(10922);' })), {
        kind: 'completed',
        output: '界'.repeat(10922),
      });
      assert.deepEqual(await complete(client, job({ source: 'return "界".repeat(10923);' })), {
        kind: 'failed',
        error: 'output-limit',
      });
      assert.deepEqual(await complete(client, job({ language: 'python', source: 'return "界" * 10922' })), {
        kind: 'completed',
        output: '界'.repeat(10922),
      });
      assert.deepEqual(await complete(client, job({ language: 'python', source: 'return "界" * 10923' })), {
        kind: 'failed',
        error: 'output-limit',
      });
      assert.deepEqual(await complete(client, job({ source: 'throw new Error("private-marker");' })), {
        kind: 'failed',
        error: 'execution-failed',
      });
      const workspaceId = randomUUID(),
        slow = job({ workspaceId, source: 'while(true) {}' });
      for (let i = 0; i < 4; i++) assert.equal((await post({ ...slow, runId: randomUUID() })).status, 202);
      assert.equal((await post({ ...slow, runId: randomUUID() })).status, 429);
      assert.equal((await complete(client, job({ source: 'while(true) {}' }))).error, 'deadline');
      await broker.close();
      broker = undefined;
      const store = new DatabaseSync(database);
      assert.equal(
        store
          .prepare('SELECT attempts FROM jobs WHERE id=?')
          .get([request.workspaceId, request.runId, request.revision, request.stepId].join('/')).attempts,
        1,
      );
      assert.equal(
        store
          .prepare('SELECT request FROM jobs WHERE id=?')
          .get([request.workspaceId, request.runId, request.revision, request.stepId].join('/')).request,
        '',
      );
      store.close();
      broker = await createSnippetBroker(options);
      await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${broker.server.address().port}`;
      client = createSnippetClient({ url, token, allowLocalHttp: true });
      assert.deepEqual(
        await client.submit({
          ...request,
          workspaceId: request.workspaceId.toUpperCase(),
          runId: request.runId.toUpperCase(),
          revision: request.revision.toUpperCase(),
        }),
        { kind: 'completed', output: { value: 5 } },
      );
      assert.deepEqual(await complete(client, job()), { kind: 'completed', output: { value: 5 } });
      assert.equal(configuredSnippetClient({}), undefined);
      assert.throws(() => configuredSnippetClient({ SNIPPET_BROKER_URL: url }));
      assert.throws(() => createSnippetClient({ url, token }));
      assert.throws(() => createSnippetClient({ url: 'https://example.com/path', token }));
    } finally {
      await broker?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'SIGKILL reconciles abandoned containers and replays interrupted jobs with a bounded attempt count',
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'snippet-crash-')),
      database = join(directory, 'jobs.sqlite');
    const token = randomBytes(32).toString('hex'),
      request = job({ source: 'await new Promise(resolve => setTimeout(resolve, 3000)); return input.value;' });
    let child;
    async function start() {
      child = fork(new URL('./broker-process.mjs', import.meta.url), {
        env: { ...process.env, TEST_BROKER_DB: database, TEST_BROKER_TOKEN: token },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const [{ port }] = await once(child, 'message');
      return createSnippetClient({ url: `http://127.0.0.1:${port}`, token, allowLocalHttp: true });
    }
    async function stop(signal) {
      const exit = once(child, 'exit');
      child.kill(signal);
      await exit;
      child = undefined;
    }
    try {
      let client = await start();
      await client.submit(request);
      let before = '';
      for (let i = 0; i < 100; i++) {
        before = execFileSync('docker', ['ps', '-q', '--filter', 'label=ai.tulipfarm.snippet-owner'], {
          encoding: 'utf8',
        }).trim();
        if (before) break;
        await setTimeout(50);
      }
      assert.ok(before, 'real disposable container started');
      await stop('SIGKILL');
      client = await start();
      assert.deepEqual(await complete(client, request), { kind: 'completed', output: 4 });
      await stop('SIGTERM');
      const store = new DatabaseSync(database);
      assert.equal(store.prepare('SELECT attempts FROM jobs').get().attempts, 2);
      const owner = store.prepare('SELECT id FROM identity').get().id;
      store.prepare("UPDATE jobs SET state='running', attempts=3, result=NULL, request=?").run(JSON.stringify(request));
      store.close();
      assert.equal(
        execFileSync('docker', ['ps', '-aq', '--filter', `label=ai.tulipfarm.snippet-owner=${owner}`], {
          encoding: 'utf8',
        }).trim(),
        '',
      );
      client = await start();
      assert.deepEqual(await client.submit(request), { kind: 'failed', error: 'interrupted' });
    } finally {
      if (child) await stop('SIGTERM');
      await rm(directory, { recursive: true, force: true });
    }
  },
);
