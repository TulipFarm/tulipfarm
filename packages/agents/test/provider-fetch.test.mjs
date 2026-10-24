import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { providerFetch } from '../src/provider-fetch.ts';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

test('concurrent provider requests reach an HTTP/2-capable server together', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'provider-fetch-'));
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
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  const count = 5;
  let inFlight = 0,
    peak = 0;
  const server = createSecureServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath), allowHTTP1: true },
    (req, res) => {
      peak = Math.max(peak, ++inFlight);
      req.resume();
      req.on('end', () =>
        setTimeout(() => {
          inFlight--;
          res.end('{}');
        }, 300),
      );
    },
  );
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `https://localhost:${server.address().port}/v1/chat/completions`;
  const call = () =>
    providerFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}' }).then(
      response => response.json(),
    );
  // Production reuses a warm connection, which is where HTTP/2 queued the requests.
  await call();
  peak = 0;
  assert.deepEqual(await Promise.all(Array.from({ length: count }, call)), Array(count).fill({}));
  assert.equal(peak, count);
});
