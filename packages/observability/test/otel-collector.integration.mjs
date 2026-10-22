// Opt-in: `pnpm --filter @tulipfarm/observability test:integration` (needs Docker).
// Runs an OpenTelemetry Collector and checks that traces, metrics and logs from the real export path
// arrive with the configured headers and only allowlisted attributes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { log, observeCall, startTelemetry, trace } from '../src/index.ts';

const run = promisify(execFile);
const image = process.env.OTEL_COLLECTOR_IMAGE ?? 'otel/opentelemetry-collector-contrib:0.140.0';
const collectorConfig = `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        include_metadata: true
processors:
  attributes/tenant:
    actions:
      - key: received.tenant
        from_context: metadata.x-tenant
        action: insert
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces: { receivers: [otlp], processors: [attributes/tenant], exporters: [debug] }
    metrics: { receivers: [otlp], processors: [attributes/tenant], exporters: [debug] }
    logs: { receivers: [otlp], processors: [attributes/tenant], exporters: [debug] }
`;

async function collectorOutput(name) {
  const { stdout, stderr } = await run('docker', ['logs', name], { maxBuffer: 64 * 1024 * 1024 });
  return stdout + stderr;
}

test('an OpenTelemetry Collector receives sanitized traces, metrics and logs', async t => {
  const name = `tulipfarm-otel-it-${randomUUID().slice(0, 8)}`;
  await run('docker', [
    'run',
    '--detach',
    '--name',
    name,
    '--publish',
    '127.0.0.1::4318',
    '--env',
    `OTELCOL_CONFIG=${collectorConfig}`,
    image,
    '--config=env:OTELCOL_CONFIG',
  ]);
  t.after(() => run('docker', ['rm', '--force', name]));
  const { stdout: published } = await run('docker', ['port', name, '4318/tcp']);
  const port = published.trim().split('\n')[0].split(':').at(-1);
  for (let attempt = 0; !(await collectorOutput(name)).includes('Everything is ready'); attempt++) {
    assert.ok(attempt < 60, await collectorOutput(name));
    await sleep(500);
  }

  const env = {
    NODE_ENV: 'production',
    CLOUD_TELEMETRY_ENABLED: 'true',
    CLOUD_TELEMETRY_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    CLOUD_TELEMETRY_OTLP_AUTHORIZATION: 'Bearer PRIVATE-TOKEN',
    CLOUD_TELEMETRY_OTLP_HEADERS: 'x-tenant=tenant-42,x-api-key=PRIVATE-KEY',
    CLOUD_TELEMETRY_SAMPLE_RATIO: '1',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const telemetry = startTelemetry({ app: 'worker', version: '2026.10.20.1', commit: 'c'.repeat(40) });
  assert.ok(telemetry, 'telemetry starts');
  try {
    await observeCall('dependency', 'integration.call', async () => {
      const span = trace.getActiveSpan();
      span.setAttributes({ tool: 'fixture-tool', 'user.email': 'PRIVATE-EMAIL@example.com' });
      span.addEvent('PRIVATE-EVENT', { prompt: 'PRIVATE-PROMPT' });
      log('info', 'activity', 'call_completed', { operation: 'integration.call', 'user.email': 'PRIVATE-EMAIL' });
    });
    await telemetry.flush();
  } finally {
    await telemetry.shutdown();
  }

  let output = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    output = await collectorOutput(name);
    if (['Span #', 'Metric #', 'LogRecord #'].every(marker => output.includes(marker))) break;
    await sleep(500);
  }
  process.stdout.write(`# collector ${name} output bytes: ${output.length}\n`);
  if (process.env.OTEL_COLLECTOR_EVIDENCE) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.OTEL_COLLECTOR_EVIDENCE, output);
  }

  assert.match(output, /Span #/, 'traces arrive');
  assert.match(output, /Name\s+: integration\.call/);
  assert.match(output, /-> tool: Str\(fixture-tool\)/, 'allowlisted span attribute kept');
  assert.match(output, /-> outcome: Str\(success\)/);
  assert.match(output, /Metric #/, 'metrics arrive');
  assert.match(output, /-> Name: call_count/);
  assert.match(output, /-> Name: cloud_process_heartbeat/);
  assert.match(output, /LogRecord #/, 'logs arrive');
  assert.match(output, /Body: Str\(call_completed\)/);
  assert.match(output, /service\.name: Str\(tulipfarm-worker\)/);
  assert.match(output, /-> received\.tenant: Str\(tenant-42\)/, 'custom header reached the collector');
  assert.doesNotMatch(output, /user\.email|PRIVATE/, 'un-allowlisted attributes, events and secrets never leave');
});
