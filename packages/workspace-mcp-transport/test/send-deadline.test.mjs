import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { createWorkspaceMcpTransport } from '../dist/index.js';

for (const expiredRequest of [1, 5])
  test(`production transport fences request ${expiredRequest} when DNS resumes beyond claim deadline`, async t => {
    const deadline = Date.now() + 30_000;
    const tool = { name: 'write', description: '', inputSchema: { type: 'object' } };
    const requests = [];
    let resolutions = 0,
      authorizations = 0;
    t.mock.method(dns, 'lookup', async () => {
      if (++resolutions === expiredRequest) t.mock.method(Date, 'now', () => deadline + 1);
      return [{ address: '8.8.8.8', family: 4 }];
    });
    t.mock.method(
      https,
      'request',
      (_url, _options, callback) =>
        new Writable({
          write(body, _encoding, done) {
            const rpc = JSON.parse(body);
            requests.push(rpc.method);
            const notification = rpc.method === 'notifications/initialized';
            const result =
              rpc.method === 'initialize'
                ? {
                    protocolVersion: '2025-11-25',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'deadline-fixture', version: '1' },
                  }
                : { tools: [tool] };
            const response = Readable.from(
              notification ? [] : [Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))],
            );
            response.statusCode = notification ? 204 : 200;
            response.headers = { 'content-type': 'application/json' };
            callback(response);
            done();
          },
        }),
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        createWorkspaceMcpTransport().call({
          endpoint: 'https://mcp.example.test/tools',
          credential: { kind: 'none' },
          signal: new AbortController().signal,
          deadline,
          authorize: async () => {
            authorizations++;
          },
          requestId: 'expired-dns',
          tool,
          arguments: {},
        }),
      );
      assert.equal(resolutions, expiredRequest);
      assert.deepEqual(
        requests,
        expiredRequest === 1 ? [] : ['initialize', 'notifications/initialized', 'tools/list', 'tools/list'],
      );
      assert.equal(authorizations, expiredRequest === 1 ? 0 : 1);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
