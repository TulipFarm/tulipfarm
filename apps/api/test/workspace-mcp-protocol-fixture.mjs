import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createWorkspaceMcpTransport } from '@tulipfarm/workspace-mcp-transport';

export async function mcpProtocolFixture(t) {
  const requests = [];
  const defaultTools = [
    {
      name: 'write',
      description: 'Write a record',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    { name: 'read', description: 'Read a record', inputSchema: { type: 'object', additionalProperties: false } },
  ];
  let tools = defaultTools;
  let failure = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks));
    requests.push({ ...rpc, headers: req.headers });
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === 'tools/list' && failure) {
      res.writeHead(503).end();
      return;
    }
    assert.ok(['initialize', 'tools/list'].includes(rpc.method), rpc.method);
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result:
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'api-regression', version: '1' },
              }
            : { tools },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const protocol = createWorkspaceMcpTransport({
    fetcher: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}`, init),
  });
  return {
    protocol,
    requests,
    setFailure(value) {
      failure = value;
    },
    setTools(value) {
      tools = value;
    },
    resetTools() {
      tools = defaultTools;
    },
  };
}
