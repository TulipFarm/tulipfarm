import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { objectStorageClient } from '../src/object-storage.ts';
import { chatObjectStore } from '../src/chat-objects.ts';
import { soulStorageConfig } from '../src/soul.ts';

test('object storage client targets AWS S3, R2 or MinIO from neutral settings', async () => {
  const aws = objectStorageClient({ TULIPFARM_OBJECT_STORAGE_REGION: 'us-east-1' });
  assert.equal(await aws.config.region(), 'us-east-1');
  assert.equal(aws.config.forcePathStyle, false);
  aws.destroy();
  const regional = objectStorageClient({
    TULIPFARM_OBJECT_STORAGE_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
    TULIPFARM_OBJECT_STORAGE_REGION: 'us-east-1',
  });
  assert.equal(regional.config.forcePathStyle, false);
  regional.destroy();
  const minio = objectStorageClient({
    TULIPFARM_OBJECT_STORAGE_ENDPOINT: 'http://object-storage:9000',
    TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID: 'fixture',
    TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'fixture-secret',
  });
  assert.equal(await minio.config.region(), 'auto');
  assert.equal(minio.config.forcePathStyle, true);
  assert.equal((await minio.config.credentials()).accessKeyId, 'fixture');
  minio.destroy();
  assert.throws(() => objectStorageClient({}), /REGION is required/);
  assert.throws(
    () =>
      objectStorageClient({
        TULIPFARM_OBJECT_STORAGE_REGION: 'us-east-1',
        TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID: 'x',
      }),
    /both object storage keys/,
  );
});

test('object storage client without keys uses the default credential chain', async () => {
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
  process.env.AWS_ACCESS_KEY_ID = 'from-default-chain';
  process.env.AWS_SECRET_ACCESS_KEY = 'from-default-chain-secret';
  try {
    const client = objectStorageClient({ TULIPFARM_OBJECT_STORAGE_REGION: 'us-east-1' });
    assert.equal((await client.config.credentials()).accessKeyId, 'from-default-chain');
    client.destroy();
  } finally {
    for (const [name, value] of [
      ['AWS_ACCESS_KEY_ID', saved.id],
      ['AWS_SECRET_ACCESS_KEY', saved.secret],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('neutral Soul settings take precedence and need no R2 keys', () => {
  const soul = soulStorageConfig('read', {
    TULIPFARM_OBJECT_STORAGE_SOUL_BUCKET: 'stg-soul',
    TULIPFARM_OBJECT_STORAGE_REGION: 'us-east-1',
    R2_SOUL_BUCKET: 'legacy',
  });
  assert.equal(soul.bucket, 'stg-soul');
  soul.client.destroy();
  assert.throws(() => soulStorageConfig('read', {}), /Soul read credentials are required/);
});

test('neutral Files bucket stores signed create-only chat objects at a custom endpoint', async () => {
  const requests = [];
  const objects = new Map();
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, path: request.url.split('?')[0], auth: request.headers.authorization });
    const key = request.url.split('?')[0];
    if (request.method === 'PUT') {
      assert.equal(request.headers['if-none-match'], '*');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      return response.writeHead(200).end();
    }
    const bytes = objects.get(key);
    if (!bytes) return response.writeHead(404).end();
    return response.writeHead(200, { 'content-length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {
    TULIPFARM_OBJECT_STORAGE_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    TULIPFARM_OBJECT_STORAGE_REGION: 'us-east-1',
    TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID: 'fixture',
    TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'fixture-secret',
    TULIPFARM_OBJECT_STORAGE_FILES_BUCKET: 'stg-files',
    CHAT_R2_BUCKET: 'legacy',
  };
  const store = chatObjectStore(env);
  try {
    await store.putIfAbsent('workspace/object', Buffer.from('bytes'));
    assert.equal(Buffer.from(await store.read('workspace/object', 5)).toString(), 'bytes');
    assert.deepEqual(
      requests.map(({ method, path }) => [method, path]),
      [
        ['PUT', '/stg-files/workspace/object'],
        ['GET', '/stg-files/workspace/object'],
      ],
    );
    for (const { auth } of requests) assert.match(auth, /^AWS4-HMAC-SHA256 Credential=fixture\/\d+\/us-east-1\/s3\//);
    assert.throws(
      () => chatObjectStore({ ...env, TULIPFARM_OBJECT_STORAGE_FILES_BUCKET: 'https://other.invalid' }),
      /Invalid private chat object configuration/,
    );
  } finally {
    store.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
