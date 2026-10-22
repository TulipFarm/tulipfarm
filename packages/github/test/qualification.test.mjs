import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { toolContractDigest } from '@tulipfarm/provider-mcp';
import { qualifyGitHubCatalog } from '../dist/qualification.js';

const token = 'synthetic-catalog-credential';
const read = {
  name: 'search_repositories',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};
const write = { name: 'create_repository', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } };
const review = {
  reviewedBy: 'local-test-reviewer',
  reviewedAt: '2026-10-03T00:00:00Z',
  readBindings: [{ operation: 'repository.search', name: read.name, contractDigest: toolContractDigest(read) }],
  writeBindings: [{ operation: 'repository.create', name: write.name, contractDigest: toolContractDigest(write) }],
};

async function fixture(t, tools = [read, write]) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks));
    calls.push({
      method: message.method,
      readonly: request.headers['x-mcp-readonly'],
      tools: request.headers['x-mcp-tools'],
    });
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (message.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'local-catalog', version: '1' },
          }
        : {
            tools:
              request.headers['x-mcp-readonly'] === 'true' ? tools.filter(tool => tool.name !== write.name) : tools,
          };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {
    calls,
    fetcher: (url, init) => {
      assert.equal(url.toString(), 'https://api.githubcopilot.com/mcp/');
      return fetch(`http://127.0.0.1:${server.address().port}`, init);
    },
  };
}

test('catalog inspection cannot promote or execute tools and explicit review produces exact bindings', async t => {
  const f = await fixture(t);
  const catalog = await qualifyGitHubCatalog({ token, fetcher: f.fetcher });
  assert.equal(catalog.kind, 'untrusted-catalog');
  assert.equal('readBindings' in catalog, false);
  assert.deepEqual(
    catalog.reads.map(tool => tool.name),
    ['search_repositories'],
  );
  assert.deepEqual(
    catalog.writes.map(tool => tool.name),
    ['search_repositories', 'create_repository'],
  );
  const qualified = await qualifyGitHubCatalog({ token, review, fetcher: f.fetcher });
  assert.equal(qualified.kind, 'reviewed-bindings');
  assert.deepEqual(qualified.readBindings, review.readBindings);
  assert.deepEqual(qualified.writeBindings, review.writeBindings);
  assert.deepEqual(
    [...new Set(f.calls.map(call => call.method))],
    ['initialize', 'notifications/initialized', 'tools/list'],
  );
  assert.ok(f.calls.some(call => call.tools === 'create_repository' && call.readonly === undefined));
});

test('qualification rejects drift, untrusted mappings, required tasks, duplicate tools and reflected tokens', async t => {
  for (const tools of [
    [{ ...read, inputSchema: { type: 'object' } }, write],
    [read, { ...write, execution: { taskSupport: 'required' } }],
    [read, read, write],
    [read, { ...write, inputSchema: { type: 'object', description: token } }],
  ]) {
    const f = await fixture(t, tools);
    await assert.rejects(qualifyGitHubCatalog({ token, review, fetcher: f.fetcher }), {
      message: 'GitHub catalog qualification failed',
    });
  }
  const f = await fixture(t, [{ ...read, inputSchema: { type: 'object', description: token } }]);
  await assert.rejects(qualifyGitHubCatalog({ token, fetcher: f.fetcher }), {
    message: 'GitHub catalog qualification failed',
  });
  await assert.rejects(
    qualifyGitHubCatalog({
      token,
      review: { ...review, writeBindings: [{ ...review.writeBindings[0], name: 'arbitrary_tool' }] },
      fetcher: f.fetcher,
    }),
  );
});
