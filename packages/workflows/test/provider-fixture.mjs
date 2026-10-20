import { createServer } from 'node:http';
import { once } from 'node:events';

export function providerSetupResponse(url) {
  const sheet = /^\/v4\/spreadsheets\/([^/]+)$/.exec(url.pathname);
  if (sheet) return { body: { spreadsheetId: sheet[1], sheets: [{ properties: { title: 'Orders' } }] } };
  const form = /^\/v1\/forms\/([^/]+)$/.exec(url.pathname);
  if (form) return { body: { formId: form[1] } };
  if (url.pathname.endsWith('/responses') && url.searchParams.get('fields') === 'nextPageToken') return { body: {} };
  return null;
}
export async function providerSetupFetch(input) {
  const result = providerSetupResponse(new URL(input));
  if (!result) throw new Error('Unexpected provider request in setup-only fixture');
  return Response.json(result.body);
}

export async function providerServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const call = {
      url: new URL(request.url, 'http://fixture'),
      method: request.method,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(call);
    try {
      const result = await handler(call);
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...result.headers });
      response.end(JSON.stringify(result.body));
    } catch {
      response.writeHead(500);
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    fetch: (input, init) => {
      const original = new URL(input),
        local = new URL(`http://127.0.0.1:${server.address().port}${original.pathname}${original.search}`);
      return fetch(local, { ...init, headers: { ...init.headers, 'x-provider-host': original.host } });
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
