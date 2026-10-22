import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authenticationHeaders, normalizeEndpoint, publicAddress } from '../dist/index.js';
import { createPublicHttpsFetch } from '../dist/public-https.js';
import { createCustomMcpSession } from '@tulipfarm/provider-mcp';

test('endpoint normalization rejects ambiguous authority and credential-bearing URLs', () => {
  assert.equal(normalizeEndpoint('https://MCP.example.com:443/a?tenant=one'), 'https://mcp.example.com/a?tenant=one');
  for (const url of [
    'http://mcp.example.com',
    'https://mcp.example.com:8443',
    'https://user:password@mcp.example.com',
    'https://127.0.0.1',
    'https://[2606:4700::1111]',
    'https://2130706433',
    'https://mcp.example.com#',
    'https://mcp.example.com/?access_token=secret',
    'https://mcp.example.com/?api%5Fkey=secret',
    'https://mcp.example.com\\@private.example',
    'https://mcp.example.com.',
    'https://{tenant}.example.com',
    ' https://mcp.example.com',
  ]) {
    assert.throws(() => normalizeEndpoint(url), { code: 'endpoint-denied', message: 'mcp-endpoint-denied' });
  }
});

test('public IPv4 and IPv6 deny special, mapped, translated, metadata and reserved destinations', () => {
  for (const address of [
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001:81b::200e',
  ])
    assert.equal(publicAddress(address), true, address);
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '168.63.129.16',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '100::1',
    '2001:db8::1',
    '2001::1',
    '2001:20::1',
    '2002:0808:0808::1',
    '3fff::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2606:4700::1%lo0',
  ])
    assert.equal(publicAddress(address), false, address);
});

test('secret headers cannot override routing, protocol or browser security headers', () => {
  assert.deepEqual(authenticationHeaders({ kind: 'headers', headers: { 'X-Api-Key': 'secret' } }), {
    'x-api-key': 'secret',
  });
  assert.deepEqual(authenticationHeaders({ kind: 'bearer', token: 'abc.def_123' }), {
    authorization: 'Bearer abc.def_123',
  });
  for (const headers of [
    { Host: 'private' },
    { 'Mcp-Session-Id': 'private' },
    { 'Proxy-Authorization': 'private' },
    { Cookie: 'private' },
    { 'X-Forwarded-Host': 'private' },
    { 'X-Key': 'a\r\nb' },
    { 'X-Key': 'a', 'x-key': 'b' },
    { Connection: 'close' },
    { 'Accept-Encoding': 'gzip' },
  ])
    assert.throws(() => authenticationHeaders({ kind: 'headers', headers }), { code: 'headers-denied' });
});

test('real TLS preserves hostname verification and socket-pinned DNS, bounds responses and rejects redirects', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-tls-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyPath = join(directory, 'key.pem'),
    certPath = join(directory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=mcp.example.test',
      '-addext',
      'subjectAltName=DNS:mcp.example.test',
    ],
    { stdio: 'ignore' },
  );
  const key = readFileSync(keyPath),
    cert = readFileSync(certPath);
  for (const family of [4, 6])
    await t.test(`IPv${family}`, async t => {
      const received = [];
      const server = createServer({ key, cert }, async (req, res) => {
        received.push({
          host: req.headers.host,
          authorization: req.headers.authorization,
          servername: req.socket.servername,
        });
        if (req.url === '/mcp') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const rpc = JSON.parse(Buffer.concat(chunks));
          if (rpc.method === 'notifications/initialized') {
            res.writeHead(202).end();
            return;
          }
          const result =
            rpc.method === 'initialize'
              ? {
                  protocolVersion: '2025-11-25',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'tls-fixture', version: '1' },
                }
              : rpc.method === 'tools/list'
                ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
                : { content: [{ type: 'text', text: 'TLS protocol result' }] };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
        } else if (req.url === '/redirect') res.writeHead(302, { location: 'https://private.example/secret' }).end();
        else if (req.url === '/large') res.writeHead(200).end('x'.repeat(2097153));
        else if (req.url === '/gzip') res.writeHead(200, { 'content-encoding': 'gzip' }).end('bad');
        else if (req.url === '/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {bad}\n\n');
        } else if (req.url === '/broken') {
          res.writeHead(200);
          res.write('partial');
          setImmediate(() => res.destroy());
        } else res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
      server.listen(0, family === 4 ? '127.0.0.1' : '::1');
      await once(server, 'listening');
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      let resolutions = 0;
      const pinned = family === 4 ? '8.8.8.8' : '2606:4700:4700::1111';
      const fetcher = createPublicHttpsFetch({
        lookup: async () => {
          resolutions++;
          return [{ address: pinned, family }];
        },
        request: (url, options, callback) => {
          options.lookup(url.hostname, {}, (error, addresses) => {
            assert.equal(error, null);
            assert.deepEqual(addresses, [{ address: pinned, family }]);
          });
          return request(
            url,
            {
              ...options,
              port: server.address().port,
              ca: cert,
              lookup: (_hostname, _options, callback) =>
                callback(null, [{ address: family === 4 ? '127.0.0.1' : '::1', family }]),
            },
            callback,
          );
        },
      });
      const response = await fetcher('https://mcp.example.test/ok', {
        headers: { authorization: 'Bearer synthetic-secret' },
      });
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(resolutions, 1);
      assert.deepEqual(received[0], {
        host: `mcp.example.test:${server.address().port}`,
        authorization: 'Bearer synthetic-secret',
        servername: 'mcp.example.test',
      });
      await assert.rejects(fetcher('https://mcp.example.test/redirect'), { code: 'redirect-denied' });
      const large = await fetcher('https://mcp.example.test/large');
      await assert.rejects(large.text(), { code: 'response-limit' });
      await assert.rejects(fetcher('https://mcp.example.test/gzip'), { code: 'network-failed' });
      await assert.rejects(fetcher('https://wrong.example.test/ok'), { code: 'network-failed' });
      assert.equal(received.length, 4);
      for (let attempt = 0; attempt < 10; attempt++) {
        const stream = await fetcher('https://mcp.example.test/stream');
        const reader = stream.body.getReader();
        assert.equal((await reader.read()).done, false);
        await reader.cancel();
        assert.equal((await reader.read()).done, true);
      }
      const interrupted = await fetcher('https://mcp.example.test/broken');
      await assert.rejects(interrupted.text(), { code: 'network-failed' });
      for (let i = 0; i < 10; i++) {
        const controller = new AbortController();
        const stream = await fetcher('https://mcp.example.test/stream', { signal: controller.signal });
        const reader = stream.body.getReader();
        assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {bad}\n\n');
        await reader.cancel();
        controller.abort();
      }
      const controller = new AbortController();
      const stream = await fetcher('https://mcp.example.test/stream', { signal: controller.signal });
      const reader = stream.body.getReader();
      await reader.read();
      const pending = reader.read();
      controller.abort();
      await assert.rejects(pending, { code: 'network-failed' });
      await reader.cancel().catch(() => undefined);
      const client = createCustomMcpSession({ endpoint: 'https://mcp.example.test/mcp', fetcher });
      const [revision] = await client.discover();
      assert.deepEqual(
        await client.execute({ name: 'read', digest: revision.digest, arguments: {}, authorize: async () => true }),
        { content: [{ type: 'text', text: 'TLS protocol result' }] },
      );
      client.close();
      const malformed = createCustomMcpSession({ endpoint: 'https://mcp.example.test/stream', fetcher });
      await assert.rejects(malformed.discover(), { code: 'discovery-failed' });
      malformed.close();
      await new Promise(resolve => setImmediate(resolve));
    });
});

test('mixed DNS results fail before any socket and aborted DNS cannot connect later', async () => {
  let sockets = 0;
  const fetcher = createPublicHttpsFetch({
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '::1', family: 6 },
    ],
    request: () => {
      sockets++;
      throw new Error('must not connect');
    },
  });
  await assert.rejects(fetcher('https://mcp.example.test'), { code: 'address-denied' });
  const gate = Promise.withResolvers();
  const controller = new AbortController();
  const delayed = createPublicHttpsFetch({
    lookup: () => gate.promise,
    request: () => {
      sockets++;
      throw new Error('must not connect');
    },
  });
  const pending = delayed('https://mcp.example.test', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'network-failed' });
  gate.resolve([{ address: '8.8.8.8', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets, 0);
});

test('abort after DNS resolves fences the request continuation', async () => {
  const controller = new AbortController();
  let sockets = 0;
  const fetcher = createPublicHttpsFetch({
    lookup: async () => {
      controller.abort();
      return [{ address: '8.8.8.8', family: 4 }];
    },
    request: () => {
      sockets++;
      throw new Error('must not connect');
    },
  });
  await assert.rejects(fetcher('https://mcp.example.test', { signal: controller.signal }), { code: 'network-failed' });
  assert.equal(sockets, 0);
});
