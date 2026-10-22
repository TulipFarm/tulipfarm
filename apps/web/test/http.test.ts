import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { jsonResponse, readJson, requestSignal, responseError } from '../src/lib/http.ts';

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
    assert.deepEqual(received[1], { method: 'GET', contentType: undefined, body: '' });
    assert.equal(responseError({ error: 'revision-conflict' }, 'fallback'), 'revision-conflict');
    assert.equal(responseError(null, 'fallback'), 'fallback');
    const controller = new AbortController();
    const signal = requestSignal(controller.signal);
    controller.abort(new Error('left page'));
    assert.equal(signal.reason, controller.signal.reason);
    await assert.rejects(jsonResponse(url, { signal }), /left page/);
    assert.equal(received.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});
