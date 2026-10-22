import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { chatObjectStore, createChatObjectAdapter } from '../src/chat-objects.ts';

test('default private object configuration is full or disabled without Soul fallback', () => {
  assert.equal(
    chatObjectStore({ R2_ACCESS_KEY_ID: 'soul', R2_SECRET_ACCESS_KEY: 'soul', R2_SOUL_BUCKET: 'soul' }),
    null,
  );
  const config = {
    CHAT_R2_ACCOUNT_ID: 'a'.repeat(32),
    CHAT_R2_BUCKET: 'private-fixture',
    CHAT_R2_ACCESS_KEY_ID: 'fixture',
    CHAT_R2_SECRET_ACCESS_KEY: 'fixture-secret',
  };
  for (const name of Object.keys(config)) {
    const partial = { ...config };
    delete partial[name];
    assert.throws(() => chatObjectStore(partial), /Invalid private chat object configuration/);
  }
  for (const changes of [
    { CHAT_R2_ACCOUNT_ID: 'localhost:9000' },
    { CHAT_R2_BUCKET: 'https://other.invalid' },
    { CHAT_R2_SECRET_ACCESS_KEY: '' },
  ]) {
    assert.throws(() => chatObjectStore({ ...config, ...changes }), /Invalid private chat object configuration/);
  }
  const store = chatObjectStore(config);
  assert.equal(typeof store.read, 'function');
  store.close();
});

test('default adapter sends signed API and read-only worker requests through a subprocess-only local transport', async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/chat-object-default.mjs', import.meta.url))],
    {
      timeout: 30000,
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(result.stdout.trim(), 'default attachment configuration and signed local API/worker IO verified');
});

test('private attachment adapter uses signed create-only byte IO with bounded integrity reads', async () => {
  const objects = new Map();
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      auth: request.headers.authorization,
      conditional: request.headers['if-none-match'],
    });
    const key = request.url.split('?')[0];
    if (request.method === 'PUT') {
      if (objects.has(key)) {
        response
          .writeHead(412, { 'content-type': 'application/xml' })
          .end('<Error><Code>PreconditionFailed</Code></Error>');
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200).end();
    } else if (request.method === 'GET') {
      const bytes = objects.get(key);
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-length': bytes.length }).end(bytes);
    } else {
      objects.delete(key);
      response.writeHead(204).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    region: 'auto',
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: 'local-fixture', secretAccessKey: 'local-fixture-secret' },
  });
  const store = createChatObjectAdapter(client, 'private-fixture');
  try {
    await store.putIfAbsent('opaque/key', Buffer.from('first'));
    await store.putIfAbsent('opaque/key', Buffer.from('other'));
    assert.equal(Buffer.from(await store.read('opaque/key', 5)).toString(), 'first');
    await assert.rejects(store.read('opaque/key', 4), /size-mismatch/);
    await store.remove('opaque/key');
    assert.equal(objects.size, 0);
    assert.deepEqual(
      requests.map(item => item.method),
      ['PUT', 'PUT', 'GET', 'GET', 'DELETE'],
    );
    assert.equal(
      requests.filter(item => item.method === 'PUT').every(item => item.conditional === '*'),
      true,
    );
    assert.equal(
      requests.every(item => item.auth.startsWith('AWS4-HMAC-SHA256 ')),
      true,
    );
    assert.equal(chatObjectStore({}), null);
    assert.throws(
      () => chatObjectStore({ CHAT_R2_BUCKET: 'private-fixture' }),
      /Invalid private chat object configuration/,
    );
  } finally {
    store.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
