import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createMcpSession, jsonCopy, schemaDigest, toolContractDigest } from '../dist/index.js';

const tool = {
  name: 'reviewed_write',
  inputSchema: {
    type: 'object',
    properties: { fields: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } },
    required: ['fields'],
    additionalProperties: false,
  },
};
const binding = { operation: 'write', name: tool.name, contractDigest: toolContractDigest(tool) };

async function fixture(t, respond = () => undefined) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    requests.push({ token: req.headers.authorization, ...request });
    if (request.method.startsWith('notifications/')) {
      res.writeHead(202).end();
      return;
    }
    if (respond(request, res) === null) return;
    const result =
      request.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : request.method === 'tools/list'
          ? { tools: [tool] }
          : { content: [{ type: 'text', text: 'accepted' }], structuredContent: request.params.arguments };
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  function session(overrides = {}) {
    const options = {
      endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
      clientName: 'fixture-client',
      token: 'synthetic',
      timeoutMs: 1000,
      bindings: [binding],
      fetcher: fetch,
      error: code => Object.assign(new Error(`fixture-${code}`), { code }),
      knownError: () => null,
      authorize: async () => true,
      result: result => result.structuredContent,
      ...overrides,
    };
    const client = createMcpSession(options);
    t.after(() => client.close());
    return { client, options };
  }
  return { requests, session };
}

test('simultaneous sessions isolate credentials, contracts, frozen arguments and authorization', async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const supplied = { ...binding };
  const first = f.session({
    token: 'first',
    bindings: [supplied],
    authorize: async (operation, args) => {
      assert.equal(operation, 'write');
      assert.deepEqual(args, { fields: { text: 'original' } });
      assert.throws(() => {
        args.fields.text = 'changed';
      }, TypeError);
      entered.resolve();
      await gate.promise;
      return true;
    },
  });
  first.options.token = 'changed';
  first.options.authorize = async () => false;
  supplied.name = 'unreviewed';
  const second = f.session({ token: 'second' }).client;
  await Promise.all([first.client.discover(), second.discover()]);
  const args = { fields: { text: 'original' } };
  const pending = first.client.execute('write', args);
  args.fields.text = 'changed';
  await entered.promise;
  assert.deepEqual(await second.execute('write', { fields: { text: 'independent' } }), {
    fields: { text: 'independent' },
  });
  gate.resolve();
  assert.deepEqual(await pending, { fields: { text: 'original' } });
  assert.deepEqual(
    f.requests.filter(r => r.method === 'tools/call').map(r => [r.token, r.params]),
    [
      ['Bearer second', { name: 'reviewed_write', arguments: { fields: { text: 'independent' } } }],
      ['Bearer first', { name: 'reviewed_write', arguments: { fields: { text: 'original' } } }],
    ],
  );
});

test('result policy failure fences the session after one effect', async t => {
  const f = await fixture(t);
  const { client } = f.session({
    result: () => {
      throw new Error('private diagnostic');
    },
  });
  await client.discover();
  await assert.rejects(client.execute('write', { fields: {} }), {
    code: 'outcome-unknown',
    message: 'fixture-outcome-unknown',
  });
  await assert.rejects(client.execute('write', { fields: {} }), { code: 'blocked' });
  assert.equal(f.requests.filter(r => r.method === 'tools/call').length, 1);
});

test('argument preparation precedes the size bound and cannot dispatch an oversized value', async t => {
  const f = await fixture(t);
  const { client } = f.session({
    prepareArguments: args => {
      args.fields = { text: 'x'.repeat(131073) };
    },
  });
  await client.discover();
  await assert.rejects(client.execute('write', { fields: {} }), { code: 'invalid-arguments' });
  assert.equal(f.requests.filter(r => r.method === 'tools/call').length, 0);
  assert.deepEqual(await client.discover(), [{ ...tool, contractDigest: binding.contractDigest }]);
});

test('canonical JSON snapshots reject cycles, non-JSON objects and excessive depth', () => {
  const cycle = {};
  cycle.self = cycle;
  let deep = {};
  for (let i = 0; i < 64; i++) deep = { child: deep };
  for (const value of [cycle, deep, new Date(), NaN, Infinity, undefined, { missing: undefined }]) {
    assert.throws(() => jsonCopy(value), /invalid-json/);
  }
  const shared = { b: 1, a: 2 };
  const copied = jsonCopy({ second: shared, first: shared });
  shared.a = 3;
  assert.equal(JSON.stringify(copied), '{"first":{"a":2,"b":1},"second":{"a":2,"b":1}}');
  assert.equal(schemaDigest({ b: 1, a: 2 }), 'd3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772');
});
