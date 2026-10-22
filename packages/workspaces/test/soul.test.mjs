import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { createStarterBundle, initializeSoul, verifyStarterBundle } from '../src/soul.ts';

const execute = promisify(execFile);
const seed = {
  workspaceId: 'a9fc9f32-8787-4b81-9962-c834e2a8fe51',
  createdBy: 'a6b75a33-4245-432b-a615-4d5fa9aa646a',
  createdAt: '2026-09-27T12:00:00.000Z',
};

test('starter restores as a real Git repository with workspace attribution and template files', async () => {
  const bundle = await createStarterBundle(seed);
  assert.equal((await createStarterBundle(seed)).commit, bundle.commit);
  assert.equal(await verifyStarterBundle(bundle.body, seed), bundle.commit);
  await assert.rejects(verifyStarterBundle(bundle.body, { ...seed, workspaceId: randomUUID() }), /different workspace/);
  const directory = await mkdtemp(join(tmpdir(), 'soul-test-'));
  try {
    await writeFile(join(directory, 'soul.bundle'), bundle.body);
    await execute('git', ['clone', 'soul.bundle', 'restored'], { cwd: directory });
    const repository = join(directory, 'restored');
    const files = (await execute('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: repository })).stdout
      .trim()
      .split('\n');
    assert.deepEqual(files, [
      'agents/.gitkeep',
      'integrations/.gitkeep',
      'roles/.gitkeep',
      'skills-lock.json',
      'skills/.gitkeep',
      'soul.json',
      'tables/.gitkeep',
      'workflows/.gitkeep',
    ]);
    assert.deepEqual(JSON.parse(await readFile(join(repository, 'soul.json'), 'utf8')), {
      templateVersion: 1,
      ...seed,
    });
    const history = (await execute('git', ['log', '-1', '--format=%aI%n%B'], { cwd: repository })).stdout;
    assert.equal(new Date(history.split('\n')[0]).toISOString(), '2026-09-27T12:00:00.000Z');
    assert.match(history, /Created-by: a6b75a33-4245-432b-a615-4d5fa9aa646a/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('conditional upload survives concurrency and lost acknowledgements without overwriting; corrupt data refuses readiness', async () => {
  let stored;
  let puts = 0;
  let loseAcknowledgement = true;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      if (!stored) {
        response.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response.writeHead(200, { 'content-length': stored.body.length, 'x-amz-meta-sha256': stored.sha256 });
      response.end(stored.body);
      return;
    }
    if (request.method === 'PUT') {
      assert.equal(request.headers['if-none-match'], '*');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (stored) {
        response
          .writeHead(412, { 'content-type': 'application/xml' })
          .end('<Error><Code>PreconditionFailed</Code></Error>');
        return;
      }
      stored = { body: Buffer.concat(chunks), sha256: request.headers['x-amz-meta-sha256'] };
      puts++;
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        request.socket.destroy();
        return;
      }
      response.writeHead(200).end();
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new S3Client({
    region: 'auto',
    endpoint: `http://127.0.0.1:${server.address().port}`,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const storage = { client, bucket: 'soul-test' };
  try {
    await assert.rejects(initializeSoul(storage, seed));
    const results = await Promise.all([initializeSoul(storage, seed), initializeSoul(storage, seed)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(puts, 1);
    assert.equal(results[0].key, `workspaces/${seed.workspaceId}/soul/initial.bundle`);
    stored.sha256 = 'invalid';
    await assert.rejects(initializeSoul(storage, seed), /checksum/);
    stored.sha256 = createHash('sha256').update(stored.body).digest('hex');
    await assert.rejects(initializeSoul(storage, { ...seed, createdBy: randomUUID() }), /different workspace/);
    stored = undefined;
    const concurrent = await Promise.all([initializeSoul(storage, seed), initializeSoul(storage, seed)]);
    assert.deepEqual(concurrent[0], concurrent[1]);
    assert.equal(puts, 2);
  } finally {
    client.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
