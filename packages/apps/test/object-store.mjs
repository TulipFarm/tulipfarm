import { createServer } from 'node:http';
import { S3Client } from '@aws-sdk/client-s3';

/** An in-memory S3 double that honours If-None-Match, so a key can only be written once. */
export async function startObjectStore() {
  const objects = new Map();
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(new URL(request.url, 'http://store').pathname);
    if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.headers['if-none-match'] === '*' && objects.has(key)) {
        response
          .writeHead(412, { 'content-type': 'application/xml' })
          .end('<Error><Code>PreconditionFailed</Code></Error>');
        return;
      }
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200).end();
      return;
    }
    if (request.method === 'GET' && objects.has(key)) {
      const body = objects.get(key);
      response.writeHead(200, { 'content-length': body.length }).end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
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
    storage: { client, bucket: 'app-sources' },
    /** Object keys under the bucket, without the bucket prefix. */
    keys: () => [...objects.keys()].map(key => key.replace(/^\/app-sources\//, '')).sort(),
    async close() {
      client.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
