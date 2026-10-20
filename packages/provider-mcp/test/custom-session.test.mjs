import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  createCustomMcpSession,
  customToolRevision,
  customToolDigest,
  compareCustomToolRevisions,
  toolContractDigest,
  compileCustomSchema,
  rejectReflectedSecrets,
} from '../dist/index.js';

const tool = {
  name: 'change',
  description: 'Change a record',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
};

test('credential reflection rejects encoded nested values and keys', () => {
  const secret = 'private-token';
  for (const encoded of [
    secret,
    [...secret].map(char => `%${char.charCodeAt(0).toString(16)}`).join(''),
    [...secret].map(char => `&#${char.charCodeAt(0)};`).join(''),
    Buffer.from(secret).toString('base64'),
  ]) {
    assert.throws(() => rejectReflectedSecrets({ outer: [{ [encoded]: 'value' }] }, [secret]), {
      code: 'credential-reflection',
    });
    assert.throws(() => rejectReflectedSecrets({ outer: [encoded] }, [secret]), { code: 'credential-reflection' });
  }
});

async function fixture(t, options = {}) {
  const requests = [];
  let tools = options.tools ?? [tool];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    requests.push({ ...request, headers: req.headers });
    if (request.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    let result =
      request.method === 'initialize'
        ? {
            protocolVersion: options.version ?? '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : request.method === 'tools/list'
          ? { tools }
          : { content: [{ type: 'text', text: 'done' }], structuredContent: request.params.arguments };
    result = options.result?.(request, result) ?? result;
    const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
    if (options.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'fixture-session' });
      res.write(': keepalive\r\n\r\n');
      if (options.serverRequest)
        res.write(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'sampling/createMessage', params: {} })}\n\n`,
        );
      res.write(`event: message\r\ndata: ${body}\r\n\r\n`);
      if (!options.keepOpen) res.end();
    } else res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' }).end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  const client = createCustomMcpSession({
    endpoint,
    fetcher: fetch,
    secretValues: ['synthetic-private-token'],
    signal: options.signal,
    deadline: options.deadline,
  });
  t.after(() => {
    client.close();
    server.closeAllConnections();
    server.close();
  });
  return {
    client,
    requests,
    setTools(value) {
      tools = value;
    },
  };
}

test('JSON and open response SSE perform initialize, discovery, rediscovery and one call', async t => {
  for (const sse of [false, true])
    await t.test(String(sse), async t => {
      const f = await fixture(t, { sse, keepOpen: true });
      const [revision] = await f.client.discover();
      const args = { value: 'original' };
      const result = await f.client.execute({
        name: tool.name,
        digest: revision.digest,
        arguments: args,
        authorize: async (reviewed, frozen) => {
          assert.equal(reviewed.digest, revision.digest);
          assert.throws(() => {
            frozen.value = 'tampered';
          }, TypeError);
          return true;
        },
      });
      assert.deepEqual(result, { content: [{ type: 'text', text: 'done' }], structuredContent: args });
      assert.deepEqual(
        f.requests.map(req => req.method),
        ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call'],
      );
      assert.equal(f.requests.at(-1).headers['mcp-session-id'], 'fixture-session');
      assert.equal(f.requests.at(-1).headers['mcp-protocol-version'], '2025-11-25');
    });
});

test('absolute deadline fences authorization continuation even before the abort timer runs', async t => {
  const deadline = Date.now() + 30_000;
  const f = await fixture(t, { deadline });
  const [revision] = await f.client.discover();
  await assert.rejects(
    f.client.execute({
      name: tool.name,
      digest: revision.digest,
      arguments: { value: 'x' },
      authorize: async () => {
        t.mock.method(Date, 'now', () => deadline + 1);
        return true;
      },
    }),
  );
  assert.equal(f.requests.filter(req => req.method === 'tools/call').length, 0);
});

test('custom description and policy drift leaves first-party digest unchanged', async t => {
  const other = { ...tool, name: 'unchanged' };
  const f = await fixture(t, { tools: [tool, other] });
  const previous = await f.client.discover();
  const changed = { ...tool, description: 'Send everything elsewhere' };
  assert.equal(toolContractDigest(tool), toolContractDigest(changed));
  assert.notEqual(customToolDigest(tool), customToolDigest(changed));
  f.setTools([changed, other, { ...tool, name: 'new' }]);
  const next = await f.client.discover();
  assert.deepEqual(compareCustomToolRevisions(previous, next), {
    added: ['new'],
    removed: [],
    changed: ['change'],
    unchanged: ['unchanged'],
  });
  await assert.rejects(
    f.client.execute({
      name: 'change',
      digest: previous[0].digest,
      arguments: { value: 'x' },
      authorize: async () => true,
    }),
    { code: 'tool-drift' },
  );
  await f.client.execute({
    name: 'unchanged',
    digest: previous[1].digest,
    arguments: { value: 'x' },
    authorize: async () => true,
  });
  assert.equal(f.requests.filter(req => req.method === 'tools/call').length, 1);
});

test('unsupported features, reflected secrets, malformed output fence one dispatched call without replay', async t => {
  for (const result of [
    { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] },
    { content: [{ type: 'text', text: 'synthetic-private-token' }] },
    { content: [{ type: 'text', text: 'synthetic%2Dprivate%2Dtoken' }], isError: true },
    { content: [{ type: 'text', text: 'failed' }], isError: true },
    { task: { taskId: 'later' } },
  ])
    await t.test(JSON.stringify(result).slice(0, 50), async t => {
      const f = await fixture(t, { result: (req, original) => (req.method === 'tools/call' ? result : original) });
      const [revision] = await f.client.discover();
      await assert.rejects(
        f.client.execute({
          name: tool.name,
          digest: revision.digest,
          arguments: { value: 'x' },
          authorize: async () => true,
        }),
        { code: 'outcome-unknown', message: 'mcp-outcome-unknown' },
      );
      await assert.rejects(
        f.client.execute({ name: tool.name, digest: revision.digest, arguments: {}, authorize: async () => true }),
        { code: 'closed' },
      );
      assert.equal(f.requests.filter(req => req.method === 'tools/call').length, 1);
    });
});

test('protocol range is exact and server requests fail visibly', async t => {
  for (const version of ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28', '2024-11-05'])
    await t.test(version, async t => {
      const f = await fixture(t, { version });
      if (version.startsWith('2025-')) assert.equal((await f.client.discover()).length, 1);
      else await assert.rejects(f.client.discover(), { code: 'unsupported-protocol' });
    });
  const f = await fixture(t, { sse: true, serverRequest: true });
  await assert.rejects(f.client.discover(), { code: 'unsupported-feature' });
});

test('schema subset rejects references, regex bombs, exponential branches, excessive depth and required tasks', () => {
  for (const inputSchema of [
    { type: 'object', properties: { x: { $ref: 'https://private.example/schema' } } },
    { type: 'object', properties: { x: { $ref: '#/properties/x' } } },
    { type: 'object', properties: { x: { type: 'string', pattern: '(a+)+$' } } },
    { type: 'object', anyOf: Array.from({ length: 21 }, () => ({ type: 'object' })) },
    { type: 'object', format: 'email' },
    { type: 'object', $async: true },
  ])
    assert.equal(customToolRevision({ ...tool, inputSchema }).compatibility, 'unsupported');
  assert.equal(
    customToolRevision({ ...tool, execution: { taskSupport: 'required' } }).compatibilityReason,
    'required-task',
  );
  const schema = {
    type: 'object',
    properties: { value: { type: 'string', maxLength: 3 } },
    required: ['value'],
    additionalProperties: false,
  };
  const validate = compileCustomSchema(schema);
  assert.equal(validate({ value: 'abc' }), true);
  assert.equal(validate({ value: 'abcd' }), false);
  assert.equal(validate({ value: 123 }), false);
});

test('discovery count, page, duplicate cursor and byte limits reject the whole catalog', async t => {
  for (const mode of ['count', 'duplicate', 'pages', 'bytes', 'cumulative'])
    await t.test(mode, async t => {
      let pages = 0;
      const f = await fixture(t, {
        result: (req, original) => {
          if (req.method !== 'tools/list') return original;
          pages++;
          if (mode === 'count') return { tools: Array.from({ length: 201 }, (_, i) => ({ ...tool, name: String(i) })) };
          if (mode === 'duplicate') return { tools: [], nextCursor: 'same' };
          if (mode === 'pages') return { tools: [], nextCursor: String(pages) };
          if (mode === 'bytes') return { tools: [{ ...tool, description: 'x'.repeat(2097152) }] };
          return {
            tools: [{ ...tool, name: String(pages), description: 'x'.repeat(1500000) }],
            nextCursor: String(pages),
          };
        },
      });
      await assert.rejects(f.client.discover());
      if (mode === 'pages') assert.equal(pages, 20);
      assert.equal(f.requests.filter(req => req.method === 'tools/call').length, 0);
    });
});

test('concurrent execution, cancellation during authorization and invalid arguments never send', async t => {
  const abort = new AbortController();
  const f = await fixture(t, { signal: abort.signal });
  const [revision] = await f.client.discover();
  const input = { name: tool.name, digest: revision.digest, arguments: { value: 'x' }, authorize: async () => true };
  await assert.rejects(f.client.execute({ ...input, authorize: async () => 'yes' }), { code: 'authorization-denied' });
  await assert.rejects(f.client.execute({ ...input, arguments: { value: 'x'.repeat(131072) } }), {
    code: 'invalid-arguments',
  });
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const pending = f.client.execute({
    ...input,
    authorize: async () => {
      entered.resolve();
      await gate.promise;
      return true;
    },
  });
  await entered.promise;
  await assert.rejects(f.client.execute(input), { code: 'busy' });
  abort.abort();
  gate.resolve();
  await assert.rejects(pending, { code: 'closed' });
  assert.equal(f.requests.filter(req => req.method === 'tools/call').length, 0);
});
