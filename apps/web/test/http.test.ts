import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { holdWrites, jsonResponse, readJson, requestSignal, responseError, writesAllowed } from '../src/lib/http.ts';

test('JSON transport sends the exact operation and preserves error parsing policy', async () => {
  const received: { method: string | undefined; contentType: string | undefined; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ method: request.method, contentType: request.headers['content-type'], body });
    response.writeHead(503, { 'Content-Type': 'text/plain' });
    response.end('Unavailable');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const url = `http://127.0.0.1:${address.port}`;
    const response = await jsonResponse(url, {
      method: 'PUT',
      body: { requestId: 'retained', value: false },
      signal: requestSignal(),
    });
    assert.equal(response.status, 503);
    assert.equal(await readJson(response, true), null);
    assert.deepEqual(received, [
      { method: 'PUT', contentType: 'application/json', body: '{"requestId":"retained","value":false}' },
    ]);
    await assert.rejects(readJson(await jsonResponse(url, { signal: requestSignal() })), SyntaxError);
    assert.deepEqual(received.slice(1), [
      { method: 'GET', contentType: undefined, body: '' },
      { method: 'GET', contentType: undefined, body: '' },
    ]);
    assert.equal(responseError({ error: 'revision-conflict' }, 'fallback'), 'revision-conflict');
    assert.equal(responseError(null, 'fallback'), 'fallback');
    const controller = new AbortController();
    const signal = requestSignal(controller.signal);
    controller.abort(new Error('left page'));
    assert.equal(signal.reason, controller.signal.reason);
    await assert.rejects(jsonResponse(url, { signal }), /left page/);
    assert.equal(received.length, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});

async function withServer(
  handle: (
    attempt: number,
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => void,
  run: (url: string, attempts: () => number) => Promise<void>,
) {
  let attempts = 0;
  const server = createServer((request, response) => handle(++attempts, request, response));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    await run(`http://127.0.0.1:${address.port}`, () => attempts);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

test('reads retry once after a gateway failure', async () => {
  await withServer(
    (attempt, _request, response) => {
      response.writeHead(attempt === 1 ? 502 : 200, { 'Content-Type': 'application/json' });
      response.end(attempt === 1 ? '{"error":"bad gateway"}' : '{"ok":true}');
    },
    async (url, attempts) => {
      const response = await jsonResponse(url, { signal: requestSignal() });
      assert.equal(response.status, 200);
      assert.deepEqual(await readJson(response), { ok: true });
      assert.equal(attempts(), 2);
    },
  );
});

test('reads retry once after a dropped connection and stop after the second failure', async () => {
  await withServer(
    (attempt, request, response) => {
      if (attempt === 1) return request.socket.destroy();
      response.writeHead(504);
      response.end();
    },
    async (url, attempts) => {
      const response = await jsonResponse(url, { signal: requestSignal() });
      assert.equal(response.status, 504);
      assert.equal(attempts(), 2);
    },
  );
});

test('writes and non-transient read failures are not retried', async () => {
  await withServer(
    (attempt, _request, response) => {
      response.writeHead(attempt === 1 ? 502 : 500);
      response.end();
    },
    async (url, attempts) => {
      assert.equal((await jsonResponse(url, { method: 'POST', body: {}, signal: requestSignal() })).status, 502);
      assert.equal((await jsonResponse(url, { signal: requestSignal() })).status, 500);
      assert.equal(attempts(), 2);
    },
  );
});

test('leaving the page during the retry delay cancels the read', async () => {
  await withServer(
    (_attempt, _request, response) => {
      response.writeHead(503);
      response.end();
    },
    async (url, attempts) => {
      const controller = new AbortController();
      const read = jsonResponse(url, { signal: requestSignal(controller.signal) });
      setTimeout(() => controller.abort(new Error('left page')), 100);
      await assert.rejects(read, /left page/);
      assert.equal(attempts(), 1);
    },
  );
});

test('writes wait for a held access check and are sent once it confirms; reads never wait', async () => {
  await withServer(
    (_attempt, _request, response) => {
      response.writeHead(204);
      response.end();
    },
    async (url, attempts) => {
      let confirm!: () => void;
      holdWrites(new Promise<void>(resolve => (confirm = resolve)));
      const write = jsonResponse(url, { method: 'POST', body: {}, signal: requestSignal() });
      assert.equal((await jsonResponse(url, { signal: requestSignal() })).status, 204);
      await delay(50);
      assert.equal(attempts(), 1, 'Only the read reached the server');
      confirm();
      assert.equal((await write).status, 204);
      assert.equal(attempts(), 2);
      await writesAllowed();
    },
  );
});

test('a failed access check rejects held writes without sending them, and later writes are not held', async () => {
  await withServer(
    (_attempt, _request, response) => {
      response.writeHead(204);
      response.end();
    },
    async (url, attempts) => {
      let fail!: (error: Error) => void;
      holdWrites(new Promise<void>((_resolve, reject) => (fail = reject)));
      const write = jsonResponse(url, { method: 'DELETE', signal: requestSignal() });
      fail(new Error('Workspace access changed'));
      await assert.rejects(write, /Could not confirm your workspace access/);
      assert.equal(attempts(), 0);
      assert.equal((await jsonResponse(url, { method: 'POST', body: {}, signal: requestSignal() })).status, 204);
      assert.equal(attempts(), 1);
    },
  );
});

test('a write abandoned while held is never sent after the check confirms', async () => {
  await withServer(
    (_attempt, _request, response) => {
      response.writeHead(204);
      response.end();
    },
    async (url, attempts) => {
      let confirm!: () => void;
      holdWrites(new Promise<void>(resolve => (confirm = resolve)));
      const left = new AbortController();
      const write = jsonResponse(url, { method: 'PATCH', body: {}, signal: requestSignal(left.signal) });
      left.abort(new Error('left page'));
      confirm();
      await assert.rejects(write, /left page/);
      assert.equal(attempts(), 0);
    },
  );
});
