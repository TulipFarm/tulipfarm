import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretError } from '@tulipfarm/secrets';

function certificate(t) {
  const directory = mkdtempSync(join(tmpdir(), 'api-calls-tls-'));
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
      '/CN=api.example.test',
      '-addext',
      'subjectAltName=DNS:api.example.test',
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

export async function server(t, handler) {
  const { key, cert } = certificate(t);
  const received = [];
  const instance = createServer({ key, cert }, (req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => {
    instance.closeAllConnections();
    instance.close();
  });
  const port = instance.address().port;
  let address = '8.8.8.8';
  const dependencies = {
    lookup: async hostname => {
      if (hostname === 'missing.example.test') throw new Error('ENOTFOUND');
      return [{ address, family: 4 }];
    },
    request: (url, options, callback) =>
      request(
        url,
        {
          ...options,
          port,
          ca: cert,
          lookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
        },
        callback,
      ),
  };
  const options = (extra = {}) => ({ workspaceId: randomUUID(), dependencies, ...extra });
  return {
    received,
    options,
    resolveTo: value => (address = value),
  };
}

export const routes = (req, res) => {
  const path = new URL(req.url, 'https://api.example.test').pathname;
  if (path === '/json')
    res
      .writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'r1',
        'x-ratelimit-remaining': '9',
        'set-cookie': 'a=b',
        server: 'test',
      })
      .end('{"items":[1,2]}');
  else if (path === '/text') res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not here');
  else if (path === '/latin1')
    res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }).end(Buffer.from([0xe9]));
  else if (path === '/bad-json') res.writeHead(200, { 'content-type': 'application/json' }).end('{oops');
  else if (path === '/sniff') res.writeHead(200).end('{"sniffed":true}');
  else if (path === '/binary')
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' }).end('\x89PNG');
  else if (path === '/large') res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(64 * 1024 + 1));
  else if (path === '/exact') res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(64 * 1024));
  else if (path === '/redirect')
    res.writeHead(302, { location: '/next?key=s3cr3t-value&page=2', 'x-request-id': 'r2' }).end();
  else if (path === '/challenge')
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="api"', 'content-type': 'text/plain' }).end('missing key');
  else if (path === '/echo')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ seen: req.headers.authorization }));
  else if (path === '/report')
    res
      .writeHead(200, {
        'content-type': 'application/vnd.example+json',
        'content-disposition': 'attachment; filename="q3/report.json"',
      })
      .end(JSON.stringify({ rows: 'x'.repeat(70 * 1024) }));
  else if (path === '/huge') res.writeHead(200, { 'content-type': 'text/csv' }).end('x'.repeat(10 * 1024 * 1024 + 1));
  else if (path === '/max') res.writeHead(200, { 'content-type': 'text/csv' }).end('x'.repeat(10 * 1024 * 1024));
  else if (path === '/large-echo')
    res
      .writeHead(200, { 'content-type': 'application/octet-stream' })
      .end(Buffer.concat([Buffer.alloc(70 * 1024), Buffer.from(String(req.headers.authorization))]));
  else if (path === '/gzip') res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }).end('x');
  else if (path === '/hang') return;
  else if (path === '/drop') req.socket.destroy();
  else res.writeHead(204).end();
};

export function secretPort(secrets, uses) {
  return {
    resolve: async (handle, url, expected) => {
      const key = 'reference' in handle ? handle.reference : handle.variable;
      const secret = secrets[key];
      if (!secret) throw new SecretError('not-found');
      if (secret.host && new URL(url).hostname !== secret.host) throw new SecretError('destination-denied');
      const version = secret.version ?? 1,
        policyVersion = secret.policyVersion ?? 1;
      if (expected && (expected.version !== version || expected.policyVersion !== policyVersion))
        throw new SecretError('conflict');
      return {
        secretId: key,
        name: secret.name,
        version,
        policyVersion,
        placement: secret.placement,
        value: secret.value,
      };
    },
    recordUse: async (secretId, url) => uses.push({ secretId, url }),
  };
}
