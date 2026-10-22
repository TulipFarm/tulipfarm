import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { S3Client } from '@aws-sdk/client-s3';
import { createChatObjectAdapter } from '../dist/chat-objects.js';

export async function filesObjectFixture() {
  const objects = new Map(),
    requests = [];
  const faults = {
    write: false,
    corrupt: false,
    oversized: false,
    remove: false,
    afterRead: null,
    writeDelayMs: 0,
    readDelayMs: 0,
  };
  const server = createServer(async (request, response) => {
    assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 /);
    const key = request.url.split('?')[0];
    requests.push({ method: request.method, key });
    if (request.method === 'PUT') {
      assert.equal(request.headers['if-none-match'], '*');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (faults.writeDelayMs) await new Promise(resolve => setTimeout(resolve, faults.writeDelayMs));
      if (response.destroyed) return;
      if (faults.write) return response.writeHead(503).end();
      if (objects.has(key))
        return response
          .writeHead(412, { 'content-type': 'application/xml' })
          .end('<Error><Code>PreconditionFailed</Code></Error>');
      objects.set(key, Buffer.concat(chunks));
      return response.writeHead(200).end();
    }
    if (request.method === 'DELETE') {
      if (faults.remove) return response.writeHead(503).end();
      objects.delete(key);
      return response.writeHead(204).end();
    }
    assert.equal(request.method, 'GET');
    const bytes = objects.get(key);
    if (!bytes) return response.writeHead(404).end();
    if (faults.readDelayMs) await new Promise(resolve => setTimeout(resolve, faults.readDelayMs));
    if (response.destroyed) return;
    const hook = faults.afterRead;
    faults.afterRead = null;
    if (hook) await hook();
    const content = faults.corrupt ? Buffer.alloc(bytes.length, 0) : bytes;
    return response.writeHead(200, { 'content-length': content.length + (faults.oversized ? 1 : 0) }).end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    region: 'auto',
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: 'local-fixture', secretAccessKey: 'local-fixture-secret' },
  });
  const adapter = createChatObjectAdapter(client, 'private-files-fixture');
  return {
    adapter,
    objects,
    requests,
    faults,
    close: async () => {
      adapter.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
