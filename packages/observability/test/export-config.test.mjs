import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { log, startTelemetry, trace } from '../src/index.ts';

const build = { app: 'worker', version: '2026.10.14.4', commit: 'b'.repeat(40) };

function withEnv(t, env) {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('invalid configuration names the setting and never its value', t => {
  withEnv(t, {
    NODE_ENV: 'production',
    CLOUD_TELEMETRY_ENABLED: 'true',
    CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://otlp.example.com',
    CLOUD_TELEMETRY_OTLP_HEADERS: 'x-api-key=PRIVATEKEY,bad name=PRIVATEKEY',
  });
  const lines = [];
  t.mock.method(process.stderr, 'write', value => {
    lines.push(String(value));
    return true;
  });
  assert.equal(startTelemetry(build), undefined);
  assert.deepEqual(
    lines.map(line => JSON.parse(line)),
    [{ level: 'error', event: 'telemetry_configuration_invalid', setting: 'CLOUD_TELEMETRY_OTLP_HEADERS' }],
  );
});

test('exports enabled signals to their endpoints with the configured headers', async t => {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests.push({ path: request.url, headers: request.headers });
      response.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  withEnv(t, {
    NODE_ENV: 'production',
    CLOUD_TELEMETRY_ENABLED: 'true',
    CLOUD_TELEMETRY_OTLP_ENDPOINT: `${origin}/base/`,
    CLOUD_TELEMETRY_OTLP_TRACES_ENDPOINT: `${origin}/custom/traces`,
    CLOUD_TELEMETRY_METRICS_ENABLED: 'false',
    CLOUD_TELEMETRY_OTLP_AUTHORIZATION: 'Bearer PRIVATETOKEN',
    CLOUD_TELEMETRY_OTLP_HEADERS: 'x-honeycomb-team=PRIVATE%20KEY,DD-API-KEY=PRIVATEDD',
    CLOUD_TELEMETRY_SAMPLE_RATIO: '1',
  });
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (value, ...args) => {
    if (typeof value !== 'string' || !value.startsWith('{')) return write(value, ...args);
    lines.push(value);
    return true;
  });
  const telemetry = startTelemetry(build);
  try {
    trace.getTracer('fixture').startSpan('fixture').end();
    log('info', 'lifecycle', 'service_started');
    await telemetry.flush();
  } finally {
    await telemetry.shutdown();
  }
  assert.deepEqual([...new Set(requests.map(request => request.path))].sort(), ['/base/v1/logs', '/custom/traces']);
  for (const { headers } of requests) {
    assert.equal(headers.authorization, 'Bearer PRIVATETOKEN');
    assert.equal(headers['x-honeycomb-team'], 'PRIVATE KEY');
    assert.equal(headers['dd-api-key'], 'PRIVATEDD');
    assert.equal(headers['content-type'], 'application/x-protobuf');
  }
  const reports = lines.filter(line => line.includes('"event":"telemetry_export"')).map(line => JSON.parse(line));
  assert.deepEqual(reports.map(row => `${row.target}:${row.signal}:${row.outcome}`).sort(), [
    'otlp:logs:sent',
    'otlp:traces:sent',
  ]);
  assert.doesNotMatch(lines.join(''), /PRIVATE/);
});
