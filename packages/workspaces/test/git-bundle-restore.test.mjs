import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { git, readSoulObject } from '../src/soul.ts';

const author = {
  workspaceId: '5f0c2a8e-7b1d-4c3e-9a6f-2d8b4e1c7a90',
  createdBy: 'c3e1b7a2-4d5f-4e8a-b9c0-1f2e3d4c5b6a',
  createdAt: '2026-10-01T09:00:00.000Z',
};
const maxBundleBytes = 16 * 1024 * 1024;

/** An S3 double that fsyncs each object to disk before acknowledging the PUT. */
async function startObjectStore(root) {
  let failNextPut = false;
  const server = createServer(async (request, response) => {
    const path = join(root, decodeURIComponent(new URL(request.url, 'http://store').pathname));
    if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (failNextPut) {
        failNextPut = false;
        response.writeHead(500, { 'content-type': 'application/xml' }).end('<Error><Code>InternalError</Code></Error>');
        return;
      }
      const exists = await readFile(`${path}.json`).then(
        () => true,
        () => false,
      );
      if (request.headers['if-none-match'] === '*' && exists) {
        response
          .writeHead(412, { 'content-type': 'application/xml' })
          .end('<Error><Code>PreconditionFailed</Code></Error>');
        return;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeDurably(path, Buffer.concat(chunks));
      await writeDurably(`${path}.json`, JSON.stringify({ sha256: request.headers['x-amz-meta-sha256'] }));
      response.writeHead(200).end();
      return;
    }
    if (request.method === 'GET') {
      const metadata = await readFile(`${path}.json`, 'utf8').then(JSON.parse, () => null);
      if (!metadata) {
        response.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, { 'content-length': body.length, 'x-amz-meta-sha256': metadata.sha256 }).end(body);
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
  return {
    storage: { client, bucket: 'app-repositories' },
    failNextPut: () => (failNextPut = true),
    async close() {
      client.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function writeDurably(path, body) {
  const file = await open(`${path}.tmp`, 'w');
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(`${path}.tmp`, path);
}

const bundleKey = (appId, sequence) => `apps/${appId}/git/${String(sequence).padStart(8, '0')}.bundle`;

async function createAppRepository(root, storage, appId) {
  const repository = join(root, 'app.git');
  const workTree = join(root, 'work');
  await mkdir(workTree, { recursive: true });
  await git(root, ['init', '--bare', '--initial-branch=main', '--object-format=sha1', repository]);
  const inRepository = args => [`--git-dir=${repository}`, `--work-tree=${workTree}`, ...args];
  let durableTip = null;
  let sequence = 0;
  return {
    repository,
    /** Resolves only after the bundle holding this save is stored. */
    async save(files, message) {
      for (const [name, content] of Object.entries(files)) {
        const path = join(workTree, name);
        if (content === null) {
          await rm(path);
          continue;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
      await git(root, inRepository(['add', '--all']));
      await git(root, inRepository(['commit', '--quiet', '-m', message]), author);
      const tip = (await git(root, inRepository(['rev-parse', 'refs/heads/main']))).stdout.trim();
      const bundlePath = join(root, 'save.bundle');
      const range = durableTip ? `${durableTip}..refs/heads/main` : 'refs/heads/main';
      await git(root, [`--git-dir=${repository}`, 'bundle', 'create', '--quiet', bundlePath, range]);
      const body = await readFile(bundlePath);
      await storage.client.send(
        new PutObjectCommand({
          Bucket: storage.bucket,
          Key: bundleKey(appId, sequence + 1),
          Body: body,
          IfNoneMatch: '*',
          ContentType: 'application/x-git-bundle',
          Metadata: { sha256: createHash('sha256').update(body).digest('hex') },
        }),
      );
      sequence++;
      durableTip = tip;
      return { commit: tip, bundleBytes: body.length };
    },
  };
}

async function restoreAppRepository(root, storage, appId) {
  const repository = join(root, 'restored.git');
  await mkdir(root, { recursive: true });
  await git(root, ['init', '--bare', '--initial-branch=main', '--object-format=sha1', repository]);
  for (let sequence = 1; ; sequence++) {
    let body;
    try {
      body = await readSoulObject(storage, bundleKey(appId, sequence), maxBundleBytes);
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) break;
      throw error;
    }
    const bundlePath = join(root, `restore-${sequence}.bundle`);
    await writeFile(bundlePath, body);
    await git(repository, ['bundle', 'verify', '--quiet', bundlePath]);
    // Each bundle lands as its own pack; a detached auto gc would repack them under the final fsck.
    await git(repository, ['fetch', '--quiet', '--no-auto-gc', bundlePath, 'refs/heads/*:refs/heads/*']);
    await rm(bundlePath);
  }
  await git(repository, ['fsck', '--full', '--strict']);
  return repository;
}

const refs = async repository =>
  (await git(repository, ['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.trim().split('\n');
const commitTrees = async repository =>
  (await git(repository, ['log', '--format=%H %T', 'refs/heads/main'])).stdout.trim().split('\n');

test('an app repository restores from its stored bundles alone, and an unstored save is never acknowledged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-git-drill-'));
  const store = await startObjectStore(join(root, 'objects'));
  const appId = 'drill';
  try {
    const app = await createAppRepository(join(root, 'source'), store.storage, appId);
    await app.save(
      {
        'package.json': '{ "name": "todo" }\n',
        'src/index.html': '<main id="app"></main>\n',
        'src/app.js': 'export const todos = [];\n',
      },
      'Create app',
    );
    await app.save({ 'src/app.js': "export const todos = ['ship'];\n", 'README.md': '# Todo\n' }, 'Add first todo');

    store.failNextPut();
    await assert.rejects(app.save({ 'src/style.css': 'main { margin: 0 }\n' }, 'Add styles'), S3ServiceException);
    const afterFailure = await restoreAppRepository(join(root, 'after-failure'), store.storage, appId);
    assert.deepEqual(await refs(afterFailure), ['refs/heads/main 12893575ad5e53197cfb7abab55c8693c73467a9']);

    await app.save({ 'README.md': null, 'src/index.html': '<main id="app" class="todo"></main>\n' }, 'Drop readme');
    const original = await commitTrees(app.repository);
    await rm(join(root, 'source'), { recursive: true, force: true });

    const restored = await restoreAppRepository(join(root, 'restored'), store.storage, appId);
    assert.deepEqual(await refs(restored), ['refs/heads/main 25e3e0605cce634255b4ebd2565b0e3f30bb5678']);
    assert.deepEqual(await commitTrees(restored), original);
    assert.deepEqual(original, [
      '25e3e0605cce634255b4ebd2565b0e3f30bb5678 6221b15db525bb3a71b525226c80354666790934',
      '25ebe8632f65d214f2a2505e3098c5c5f61a5eea 93a8589503fdfa8430a926042beb505a38e1dec4',
      '12893575ad5e53197cfb7abab55c8693c73467a9 4c94a36719d8284163c7d63af222d9658655eb7c',
      'c0c032872ceb7cc927c2f21b96de324f278c90ca 143ec43317c06491d446e25d7e4642a830dc3eb6',
    ]);
    assert.deepEqual((await git(restored, ['ls-tree', '-r', '--name-only', 'main'])).stdout.trim().split('\n'), [
      'package.json',
      'src/app.js',
      'src/index.html',
      'src/style.css',
    ]);
    assert.equal((await git(restored, ['show', 'main:src/app.js'])).stdout, "export const todos = ['ship'];\n");
    assert.equal((await git(restored, ['show', 'main:src/style.css'])).stdout, 'main { margin: 0 }\n');
    assert.equal((await git(restored, ['show', 'main~1:README.md'])).stdout, '# Todo\n');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function appFiles() {
  const files = {
    'package.json': `${JSON.stringify({ name: 'inventory', private: true, type: 'module' }, null, 2)}\n`,
    'index.html':
      '<!doctype html>\n<html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n',
    'README.md': '# Inventory\n\nTrack stock across locations.\n',
  };
  for (let index = 0; index < 36; index++) {
    const lines = Array.from(
      { length: 40 },
      (_, line) =>
        `  // Renders row ${line} of view ${index} with its own label and formatting.\n  row${line}: '${index}-${line}',`,
    );
    files[`src/views/view-${index}.js`] = `export const view${index} = {\n${lines.join('\n')}\n};\n`;
  }
  files['src/styles.css'] = Array.from({ length: 80 }, (_, line) => `.row-${line} { padding: ${line % 8}px; }`).join(
    '\n',
  );
  return files;
}

const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];

test('save-to-durable-bundle latency for a small app', async t => {
  const root = await mkdtemp(join(tmpdir(), 'app-git-latency-'));
  const store = await startObjectStore(join(root, 'objects'));
  const appId = 'latency';
  try {
    const app = await createAppRepository(join(root, 'source'), store.storage, appId);
    const files = appFiles();
    const durations = [];
    const bundleSizes = [];
    for (let save = 0; save < 50; save++) {
      const changes = save === 0 ? files : {};
      if (save > 0) {
        for (const index of [save % 36, (save * 7) % 36]) {
          const name = `src/views/view-${index}.js`;
          changes[name] = `${files[name]}// revision ${save}\n`;
          files[name] = changes[name];
        }
      }
      const started = performance.now();
      const { bundleBytes } = await app.save(changes, `Save ${save}`);
      durations.push(performance.now() - started);
      bundleSizes.push(bundleBytes);
    }
    const original = await commitTrees(app.repository);
    const originalRefs = await refs(app.repository);
    await rm(join(root, 'source'), { recursive: true, force: true });
    const restored = await restoreAppRepository(join(root, 'restored'), store.storage, appId);
    assert.deepEqual(await refs(restored), originalRefs);
    assert.deepEqual(await commitTrees(restored), original);
    assert.equal(original.length, 50);

    const sorted = durations.toSorted((a, b) => a - b);
    const [p50, p95, max] = [percentile(sorted, 0.5), percentile(sorted, 0.95), sorted.at(-1)];
    t.diagnostic(
      `files=${Object.keys(files).length} saves=50 p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms ` +
        `firstBundle=${bundleSizes[0]}B incrementalBundleMedian=${bundleSizes.slice(1).toSorted((a, b) => a - b)[24]}B`,
    );
    t.diagnostic(
      `machine=${cpus()[0]?.model} cores=${cpus().length} memory=${Math.round(totalmem() / 2 ** 30)}GiB ${arch()} ${release()} node=${process.version}`,
    );
    assert.ok(max < 10000, `a save took ${max.toFixed(0)}ms`);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
