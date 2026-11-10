import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { createSnippetBroker } from '../src/broker.ts';
import { createSkillClient, configuredSkillClient } from '../src/client.ts';
import { maxSkillJobBytes } from '../src/skill-protocol.ts';

const image = process.env.SNIPPET_TEST_IMAGE;
function job({ source = 'process.stdout.write(process.argv.slice(2).join(" "));', ...overrides } = {}) {
  return {
    kind: 'skill',
    version: 1,
    workspaceId: randomUUID(),
    invocationId: randomUUID(),
    packageDigest: 'a'.repeat(64),
    language: 'node',
    entrypoint: 'script.js',
    args: ['hello'],
    input: null,
    files: [
      {
        path: 'script.js',
        content: Buffer.from(source).toString('base64'),
        digest: createHash('sha256').update(source).digest('hex'),
      },
    ],
    ...overrides,
  };
}
const completed = stdout => ({ kind: 'completed', exitCode: 0, stdout, stderr: '', files: [] });
async function complete(client, request) {
  for (let i = 0; i < 300; i++) {
    const result = await client.submit(request);
    if (result.kind !== 'pending') return result;
    await setTimeout(100);
  }
  throw new Error('broker did not complete');
}

test(
  'authenticated broker runs skill jobs, enforces limits and replays persisted results after restart',
  { timeout: 240000 },
  async () => {
    assert.ok(image, 'SNIPPET_TEST_IMAGE required');
    const directory = await mkdtemp(join(tmpdir(), 'snippet-broker-')),
      database = join(directory, 'jobs.sqlite');
    const token = randomBytes(32).toString('hex'),
      options = {
        database,
        token,
        image,
        runtime: 'runc',
        allowLocalRunc: true,
        timeoutMs: 20000,
        enableSkillJobs: true,
      };
    let broker;
    try {
      broker = await createSnippetBroker(options);
      await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
      let url = `http://127.0.0.1:${broker.server.address().port}`;
      let client = createSkillClient({ url, token, allowLocalHttp: true });
      const request = job();
      const post = (body, auth = `Bearer ${token}`, path = '/v1/skill-jobs') =>
        fetch(`${url}${path}`, {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/json' },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
      assert.equal((await post(request, '')).status, 401);
      assert.equal((await post(request, `Bearer ${'0'.repeat(64)}`)).status, 401);
      assert.equal((await post(request, undefined, '/v1/jobs')).status, 404);
      assert.equal((await post({ ...request, unexpected: true })).status, 400);
      assert.equal((await post('{')).status, 400);
      assert.equal((await post(' '.repeat(maxSkillJobBytes + 1))).status, 413);
      await assert.rejects(createSnippetBroker(options), /locked/);
      assert.deepEqual(await complete(client, request), completed('hello'));
      assert.equal((await post({ ...request, args: ['changed'] })).status, 409);
      assert.deepEqual(await complete(client, job({ source: 'process.exit(3);' })), { ...completed(''), exitCode: 3 });
      const workspaceId = randomUUID(),
        slow = job({ workspaceId, source: 'setTimeout(() => {}, 60000);' });
      for (let i = 0; i < 4; i++) assert.equal((await post({ ...slow, invocationId: randomUUID() })).status, 202);
      assert.equal((await post({ ...slow, invocationId: randomUUID() })).status, 429);
      assert.deepEqual(await complete(client, job({ source: 'setTimeout(() => {}, 60000);' })), {
        kind: 'failed',
        error: 'deadline',
      });
      await broker.close();
      broker = undefined;
      const store = new DatabaseSync(database),
        id = [request.workspaceId, 'skill', request.invocationId].join('/');
      assert.equal(store.prepare('SELECT attempts FROM jobs WHERE id=?').get(id).attempts, 1);
      assert.equal(store.prepare('SELECT request FROM jobs WHERE id=?').get(id).request, '');
      store.close();
      broker = await createSnippetBroker(options);
      await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${broker.server.address().port}`;
      client = createSkillClient({ url, token, allowLocalHttp: true });
      assert.deepEqual(await client.submit(request), completed('hello'));
      assert.deepEqual(await complete(client, job()), completed('hello'));
      assert.equal(configuredSkillClient({}), undefined);
      assert.throws(() => configuredSkillClient({ SKILL_SCRIPTS_ENABLED: 'true', SNIPPET_BROKER_URL: url }));
      assert.throws(() => createSkillClient({ url, token }));
      assert.throws(() => createSkillClient({ url: 'https://example.com/path', token }));
    } finally {
      await broker?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('SIGKILL reconciles abandoned containers and reports the interrupted skill job', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snippet-crash-')),
    database = join(directory, 'jobs.sqlite');
  const token = randomBytes(32).toString('hex'),
    request = job({ source: 'setTimeout(() => process.stdout.write("late"), 3000);' });
  let child;
  async function start() {
    child = fork(new URL('./broker-process.mjs', import.meta.url), {
      env: { ...process.env, TEST_BROKER_DB: database, TEST_BROKER_TOKEN: token },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const [{ port }] = await once(child, 'message');
    return createSkillClient({ url: `http://127.0.0.1:${port}`, token, allowLocalHttp: true });
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
    assert.deepEqual(await client.submit(request), { kind: 'failed', error: 'interrupted' });
    await stop('SIGTERM');
    const store = new DatabaseSync(database);
    assert.equal(store.prepare('SELECT attempts FROM jobs').get().attempts, 1);
    const owner = store.prepare('SELECT id FROM identity').get().id;
    store.close();
    assert.equal(
      execFileSync('docker', ['ps', '-aq', '--filter', `label=ai.tulipfarm.snippet-owner=${owner}`], {
        encoding: 'utf8',
      }).trim(),
      '',
    );
  } finally {
    if (child) await stop('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  }
});
