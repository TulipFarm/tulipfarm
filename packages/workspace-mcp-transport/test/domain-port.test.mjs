import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  createWorkspaceMcpTransport,
  customToolDigest,
  CUSTOM_MCP_PROTOCOL_VERSIONS,
  customToolRevision,
} from '../dist/index.js';

const endpoint = 'https://mcp.example.test/tools';
const tool = {
  name: 'write',
  description: 'Write a record',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};
const claim = () => ({ deadline: Date.now() + 30_000, authorize: async () => {} });

test('custom digest uses the domain version and exact reviewed fields', () => {
  assert.deepEqual([...CUSTOM_MCP_PROTOCOL_VERSIONS].sort(), ['2025-03-26', '2025-06-18', '2025-11-25']);
  assert.equal(
    customToolRevision({
      ...tool,
      inputSchema: { ...tool.inputSchema, $schema: 'http://json-schema.org/draft-07/schema#' },
    }).compatibility,
    'compatible',
  );
  assert.equal(
    customToolRevision({
      ...tool,
      inputSchema: { ...tool.inputSchema, $schema: 'https://json-schema.org/draft/2020-12/schema' },
    }).compatibility,
    'unsupported',
  );
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
      return `{${Object.keys(value)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(',')}}`;
    return JSON.stringify(value);
  }
  assert.equal(
    customToolDigest(tool),
    createHash('sha256')
      .update(canonical(['workspace-mcp-tool-v1', tool]))
      .digest('hex'),
  );
});

async function fixture(t) {
  const requests = [];
  let tools = [tool];
  let result = { content: [{ type: 'text', text: 'written' }], structuredContent: { id: '123' } };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks));
    requests.push({ ...rpc, headers: req.headers });
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    json(res, {
      jsonrpc: '2.0',
      id: rpc.id,
      result:
        rpc.method === 'initialize'
          ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
          : rpc.method === 'tools/list'
            ? { tools }
            : result,
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = createWorkspaceMcpTransport({
    fetcher: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}`, init),
  });
  return {
    port,
    requests,
    setTools(value) {
      tools = value;
    },
    setResult(value) {
      result = value;
    },
  };
}
function json(res, value) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

test('domain port discovers contracts and preserves exact request ID, argument snapshot and credential isolation', async t => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  const first = { ...claim(), endpoint, signal, credential: { kind: 'bearer', token: 'first-token' } };
  const second = {
    ...claim(),
    endpoint,
    signal,
    credential: { kind: 'headers', headers: { 'X-Api-Key': 'second-secret' } },
  };
  const discovered = await f.port.discover(first);
  assert.deepEqual(discovered, { tools: [tool] });
  const args = { text: 'original' };
  const pending = f.port.call({ ...first, tool, arguments: args, requestId: 'durable-action-1' });
  args.text = 'mutated';
  const [a, b] = await Promise.all([
    pending,
    f.port.call({ ...second, tool, arguments: { text: 'second' }, requestId: 'durable-action-2' }),
  ]);
  assert.deepEqual(a, { content: [{ type: 'text', text: 'written' }], structuredContent: { id: '123' } });
  assert.deepEqual(b, a);
  const calls = f.requests.filter(req => req.method === 'tools/call');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.find(req => req.id === 'durable-action-1').params.arguments, { text: 'original' });
  assert.equal(calls.find(req => req.id === 'durable-action-1').headers.authorization, 'Bearer first-token');
  assert.equal(calls.find(req => req.id === 'durable-action-1').headers['x-api-key'], undefined);
  assert.equal(calls.find(req => req.id === 'durable-action-2').headers.authorization, undefined);
  assert.equal(calls.find(req => req.id === 'durable-action-2').headers['x-api-key'], 'second-secret');
});

test('domain port rejects drift, expired or mismatched OAuth and aborted work without sending a call', async t => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  const input = {
    ...claim(),
    endpoint,
    signal,
    credential: { kind: 'none' },
    tool,
    arguments: { text: 'x' },
    requestId: 'action-1',
  };
  f.setTools([{ ...tool, description: 'drifted' }]);
  await assert.rejects(f.port.call(input), { message: 'mcp-tool-drift' });
  const oauth = {
    kind: 'oauth',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: '2000-01-01T00:00:00Z',
    issuer: 'https://auth.example.test',
    resource: endpoint,
    clientId: 'client',
    scopes: [],
    accountId: null,
  };
  await assert.rejects(f.port.call({ ...input, credential: oauth }), { message: 'mcp-credential-unavailable' });
  await assert.rejects(
    f.port.call({
      ...input,
      credential: { ...oauth, expiresAt: '2099-01-01T00:00:00Z', resource: 'https://other.example.test/' },
    }),
    { message: 'mcp-credential-unavailable' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.port.call({ ...input, signal: controller.signal }), { code: 'closed' });
  assert.equal(f.requests.filter(req => req.method === 'tools/call').length, 0);
});

test('domain port rejects reflection of unused refresh credentials after one send', async t => {
  const f = await fixture(t);
  f.setResult({ content: [{ type: 'text', text: 'refresh-secret-is-private' }] });
  const input = {
    ...claim(),
    endpoint,
    signal: new AbortController().signal,
    credential: {
      kind: 'oauth',
      accessToken: 'access-token',
      refreshToken: 'refresh-secret-is-private',
      expiresAt: '2099-01-01T00:00:00Z',
      issuer: 'https://auth.example.test',
      resource: endpoint,
      clientId: 'client',
      scopes: [],
      accountId: null,
    },
    tool,
    arguments: { text: 'x' },
    requestId: 'action-1',
  };
  await assert.rejects(f.port.call(input), { code: 'outcome-unknown', message: 'mcp-outcome-unknown' });
  const calls = f.requests.filter(req => req.method === 'tools/call');
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(f.requests).includes('refresh-secret-is-private'), false);
});

test('domain port rechecks claim after discovery and refuses revocation or elapsed wall time before timers run', async t => {
  const f = await fixture(t);
  for (const revoked of [false, true]) {
    const deadline = Date.now() + 30_000;
    try {
      await assert.rejects(
        f.port.call({
          endpoint,
          signal: new AbortController().signal,
          credential: { kind: 'none' },
          tool,
          arguments: { text: 'x' },
          requestId: `paused-${revoked}`,
          deadline,
          authorize: async () => {
            if (revoked) throw new Error('claim revoked');
            t.mock.method(Date, 'now', () => deadline + 1);
          },
        }),
      );
    } finally {
      t.mock.restoreAll();
    }
  }
  assert.equal(f.requests.filter(req => req.method === 'tools/call').length, 0);
});
