import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { HttpStepError, httpRequestLimit, requestHttp } from '../src/http.ts';

test('outbound HTTP blocks non-HTTPS, loopback, and link-local targets before a request', async () => {
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://169.254.169.254', 'https://[::1]']) {
    await assert.rejects(
      requestHttp({ method: 'POST', url, headers: {} }),
      error => error instanceof HttpStepError && error.code === 'egress-denied',
    );
  }
});

test('outbound HTTP blocks private IPv4 carried in IPv6 literals and DNS answers', async t => {
  let requests = 0;
  const answers = [
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:0:10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:c0a8:101::1',
    'fe80::1%eth0',
    'ff02::1',
  ];
  t.mock.method(dns, 'lookup', async () => [{ address: answers.shift(), family: 6 }]);
  t.mock.method(https, 'request', () => {
    requests++;
    throw new Error('unexpected request');
  });
  syncBuiltinESMExports();
  const urls = [
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:7f00:1]',
    'https://[::ffff:a9fe:a9fe]',
    'https://[::a00:1]',
    'https://[64:ff9b::7f00:1]',
    'https://[2002:a00:1::]',
    'https://[fec0::1]',
  ];
  for (const url of [...urls, ...answers.map(() => 'https://mapped.test')]) {
    await assert.rejects(
      requestHttp({ method: 'POST', url, headers: {} }),
      error => error instanceof HttpStepError && error.code === 'egress-denied',
      url,
    );
  }
  assert.equal(requests, 0);
});

for (const failure of ['timeout', 'connection', 'dns'])
  test(`outbound HTTP classifies ${failure} failures as step errors`, async t => {
    let requests = 0,
      socket;
    t.mock.method(dns, 'lookup', async () => {
      if (failure === 'dns') throw Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' });
      return [{ address: '8.8.8.8', family: 4 }];
    });
    t.mock.method(https, 'request', () => {
      requests++;
      socket = new Writable({
        final(done) {
          done(failure === 'connection' ? new Error('connection refused') : undefined);
        },
      });
      return socket;
    });
    if (failure === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    syncBuiltinESMExports();
    try {
      const result = assert.rejects(
        requestHttp({ method: 'POST', url: 'https://example.test', headers: {} }),
        error =>
          error instanceof HttpStepError &&
          error.code === (failure === 'timeout' ? 'request-timeout' : 'request-failed'),
      );
      if (failure === 'timeout') {
        await new Promise(setImmediate);
        t.mock.timers.tick(httpRequestLimit.timeoutMilliseconds);
      }
      await result;
      assert.equal(requests, failure === 'dns' ? 0 : 1);
      if (failure === 'timeout') assert.equal(socket.destroyed, true);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
