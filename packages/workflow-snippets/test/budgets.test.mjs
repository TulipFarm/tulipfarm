import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createSnippetClient } from '../src/client.ts';
import { jobSchema, maxJobBytes } from '../src/protocol.ts';
import { parseSnippet } from '../src/index.ts';

const job = source => ({
  workspaceId: randomUUID(),
  runId: randomUUID(),
  revision: randomUUID(),
  stepId: 'a'.repeat(48),
  language: 'javascript',
  source,
  input: 'x'.repeat(32766),
});
test('serialized source and input budgets cover Unicode, escaping and the complete job envelope', () => {
  const oversized = job(`/*${'界'.repeat(32740)}*/return input`);
  assert.equal(jobSchema.safeParse(oversized).success, false);
  assert.throws(
    () => parseSnippet({ language: oversized.language, source: oversized.source, input: oversized.input }),
    /invalid-input/,
  );
  for (const source of [
    'a'.repeat(32766),
    '界'.repeat(10922),
    '\n'.repeat(5461),
    '\\'.repeat(16383),
    '😀'.repeat(8191),
  ]) {
    const request = jobSchema.parse(job(source));
    assert.ok(Buffer.byteLength(JSON.stringify(request)) <= maxJobBytes);
    assert.equal(parseSnippet({ language: request.language, source, input: request.input }).source, source);
  }
});

test('client returns permanent failures without retries and preserves transient HTTP failures', async () => {
  let status = 413,
    calls = 0;
  const server = createServer((request, response) => {
    calls++;
    request.resume();
    response.writeHead(status);
    response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = createSnippetClient({
      url: `http://127.0.0.1:${server.address().port}`,
      token: 'a'.repeat(64),
      allowLocalHttp: true,
    });
    assert.deepEqual(await client.submit(job('界'.repeat(32740))), { kind: 'failed', error: 'invalid-input' });
    assert.equal(calls, 0);
    for (status of [400, 401, 403, 404, 409, 413, 415, 422])
      assert.deepEqual(await client.submit(job('return input')), { kind: 'failed', error: 'broker-rejected' });
    assert.equal(calls, 8);
    for (status of [408, 429, 500, 503])
      await assert.rejects(client.submit(job('return input')), /snippet-broker-unavailable/);
    assert.equal(calls, 12);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
