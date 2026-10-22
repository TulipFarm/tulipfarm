import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const objects = new Map();
const requests = [];
const hostname = `private-fixture.${'a'.repeat(32)}.r2.cloudflarestorage.com`;
const server = http.createServer(async (request, response) => {
  const worker = request.headers.authorization.includes('Credential=fixture-worker/');
  assert.ok(worker || request.headers.authorization.includes('Credential=fixture-api/'));
  requests.push([worker ? 'worker' : 'api', request.method]);
  if (worker && request.method !== 'GET') {
    response.writeHead(403, { 'content-type': 'application/xml' }).end('<Error><Code>AccessDenied</Code></Error>');
    return;
  }
  const key = request.url.split('?')[0];
  if (request.method === 'PUT') {
    assert.equal(request.headers['if-none-match'], '*');
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
const original = https.request;
let transportError;
https.request = (options, callback) => {
  try {
    assert.equal(options.host, hostname);
    assert.equal(options.headers.host, hostname);
    assert.match(options.headers.authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(options.path.split('?')[0], '/opaque/key');
    return http.request({ ...options, host: '127.0.0.1', port: server.address().port, agent: false }, callback);
  } catch (error) {
    transportError = error;
    throw error;
  }
};
syncBuiltinESMExports();
const { chatObjectStore } = await import('../../src/chat-objects.ts');
const base = {
  CHAT_R2_ACCOUNT_ID: 'a'.repeat(32),
  CHAT_R2_BUCKET: 'private-fixture',
  CHAT_R2_SECRET_ACCESS_KEY: 'fixture-secret',
};
const api = chatObjectStore({ ...base, CHAT_R2_ACCESS_KEY_ID: 'fixture-api' });
const worker = chatObjectStore({ ...base, CHAT_R2_ACCESS_KEY_ID: 'fixture-worker' });
try {
  await api.putIfAbsent('opaque/key', Buffer.from('private bytes'));
  await api.putIfAbsent('opaque/key', Buffer.from('not replaced'));
  assert.equal(Buffer.from(await api.read('opaque/key', 13)).toString(), 'private bytes');
  assert.equal(Buffer.from(await worker.read('opaque/key', 13)).toString(), 'private bytes');
  await assert.rejects(worker.putIfAbsent('opaque/key', Buffer.from('bad')), /chat-object-write-unavailable/);
  await assert.rejects(worker.remove('opaque/key'));
  await assert.rejects(worker.read('opaque/key', 12), /chat-object-size-mismatch/);
  await api.remove('opaque/key');
  assert.equal(objects.size, 0);
  assert.deepEqual(requests, [
    ['api', 'PUT'],
    ['api', 'PUT'],
    ['api', 'GET'],
    ['worker', 'GET'],
    ['worker', 'PUT'],
    ['worker', 'DELETE'],
    ['worker', 'GET'],
    ['api', 'DELETE'],
  ]);
  console.log('default attachment configuration and signed local API/worker IO verified');
} catch (error) {
  throw transportError ?? error;
} finally {
  api.close();
  worker.close();
  https.request = original;
  syncBuiltinESMExports();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
