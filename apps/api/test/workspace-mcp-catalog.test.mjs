import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRegistryCatalog } from '@tulipfarm/workspace-mcp-transport';
import { workspaceMcpCatalog, registerWorkspaceMcpCatalogRefresh } from '../src/workspace-mcp-catalog.ts';
import Fastify from 'fastify';
import { workspaceMcpCatalogCache } from '../src/workspace-mcp-catalog-cache.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const telemetryRequire = createRequire(import.meta.resolve('@tulipfarm/observability'));
const { metrics, trace } = telemetryRequire('@opentelemetry/api');
const { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } =
  telemetryRequire('@opentelemetry/sdk-metrics');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = telemetryRequire(
  '@opentelemetry/sdk-trace-base',
);

async function cacheDirectory() {
  await mkdir('reports/check', { recursive: true });
  return mkdtemp(resolve('reports/check/mcp-public-catalog-'));
}

test('latest-only public catalog survives restart and failed sync with concurrent atomic publication', async () => {
  const directory = await cacheDirectory();
  const cache = workspaceMcpCatalogCache(directory);
  const entry = {
    id: 'public',
    name: 'public',
    title: 'Public registry server',
    description: 'Public metadata only',
    version: '1',
    endpoint: 'https://public.example.com/mcp',
    status: 'active',
    compatibility: 'unverified',
    authentication: 'unknown',
  };
  try {
    await Promise.all([
      cache.publish({ policyVersion: 'latest-usable-v1', syncedAt: '2026-10-02T02:00:00.000Z', entries: [entry] }),
      cache.publish({ policyVersion: 'latest-usable-v1', syncedAt: '2026-10-02T01:00:00.000Z', entries: [] }),
    ]);
    const restarted = workspaceMcpCatalog(
      createRegistryCatalog({
        fetcher: async () => {
          throw new Error('registry unavailable');
        },
      }),
      workspaceMcpCatalogCache(directory),
    );
    await restarted.load();
    const before = restarted.search('public');
    assert.equal(before.entries.length, 1);
    assert.equal(before.syncedAt, '2026-10-02T02:00:00.000Z');
    assert.equal(before.stale, true);
    await restarted.refresh();
    assert.deepEqual(restarted.search('public'), before);
    await assert.rejects(
      cache.publish({
        policyVersion: 'latest-usable-v1',
        syncedAt: '2026-10-02T03:00:00.000Z',
        entries: [{ ...entry, credential: 'forbidden' }],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('catalog rejects historical cache on restart and replaces it only with a complete latest-only snapshot', async () => {
  const directory = await cacheDirectory();
  const cache = workspaceMcpCatalogCache(directory);
  const syncedAt = '2026-10-14T00:00:00.000Z';
  const entry = {
    id: 'org/public@old:0',
    name: 'org/public',
    title: 'Public',
    description: 'Historical listing',
    version: 'old',
    endpoint: 'https://public.example.com/mcp',
    status: 'active',
    compatibility: 'unverified',
    authentication: 'unknown',
  };
  try {
    const legacy = { syncedAt, entries: [entry] };
    const bytes = Buffer.from(JSON.stringify(legacy));
    await writeFile(
      resolve(directory, `${Date.parse(syncedAt)}-${createHash('sha256').update(bytes).digest('hex')}.json`),
      bytes,
    );
    assert.equal(await cache.read(), null);
    await assert.rejects(cache.publish(legacy));
    let failed = true;
    const catalog = workspaceMcpCatalog(
      createRegistryCatalog({
        now: () => new Date('2026-10-14T01:00:00.000Z'),
        fetcher: async () => {
          if (failed) throw new Error('unavailable');
          return Response.json({
            servers: [
              {
                server: {
                  name: 'org/public',
                  version: 'new',
                  description: 'Latest listing',
                  remotes: [{ type: 'streamable-http', url: entry.endpoint }],
                },
                _meta: {
                  'io.modelcontextprotocol.registry/official': {
                    status: 'active',
                    updatedAt: syncedAt,
                    isLatest: true,
                  },
                },
              },
            ],
            metadata: {},
          });
        },
      }),
      cache,
    );
    await catalog.refresh();
    assert.deepEqual(catalog.search('').entries, []);
    failed = false;
    await catalog.refresh();
    assert.deepEqual(
      catalog.search('').entries.map(value => value.id),
      ['org/public@new:0'],
    );
    assert.equal((await cache.read()).policyVersion, 'latest-usable-v1');
    const restarted = workspaceMcpCatalog(
      createRegistryCatalog({
        fetcher: async () => {
          throw new Error('unavailable');
        },
      }),
      cache,
    );
    await restarted.refresh();
    assert.deepEqual(
      restarted.search('').entries.map(value => value.id),
      ['org/public@new:0'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('catalog HTTP adapter keeps a stale snapshot, reports unknown auth, and rejects mismatched cursors', async () => {
  let failed = false;
  let now = new Date('2026-10-02T00:00:00.000Z');
  const catalog = createRegistryCatalog({
    now: () => now,
    fetcher: async () => {
      if (failed) throw new Error('private-network-diagnostic');
      return Response.json({
        servers: Array.from({ length: 55 }, (_, index) => ({
          server: {
            name: `org.example/server-${index.toString().padStart(2, '0')}`,
            version: '1.0',
            description: 'Example remote tools',
            remotes: [{ type: 'streamable-http', url: `https://server-${index}.example.com/mcp` }],
          },
          _meta: {
            'io.modelcontextprotocol.registry/official': {
              status: 'active',
              updatedAt: now.toISOString(),
              isLatest: true,
            },
          },
        })),
        metadata: {},
      });
    },
  });
  const adapter = workspaceMcpCatalog(catalog);
  assert.equal(adapter.search('').stale, true);
  assert.deepEqual(adapter.search('').entries, []);
  await adapter.refresh();
  const first = adapter.search('example');
  assert.equal(first.source, 'Official MCP Registry');
  assert.equal(first.entries.length, 50);
  assert.equal(first.stale, false);
  assert.equal(first.entries[0].authentication, 'unknown');
  assert.equal(first.entries[0].compatibility, 'unknown');
  assert.ok(first.nextCursor);
  const second = adapter.search('example', first.nextCursor);
  assert.equal(second.entries.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size, 55);
  assert.throws(
    () => adapter.search('changed query', first.nextCursor),
    error => error.code === 'mcp-catalog-changed',
  );
  failed = true;
  now = new Date('2026-10-02T07:00:00.000Z');
  await adapter.refresh();
  const stale = adapter.search('example');
  assert.equal(stale.stale, true);
  assert.equal(stale.syncedAt, first.syncedAt);
  assert.equal(stale.snapshotVersion, first.snapshotVersion);
  assert.deepEqual(stale.entries, first.entries);
  assert.equal(JSON.stringify(stale).includes('private-network-diagnostic'), false);
});

test('API startup runs actual catalog sync and publishes a restorable public snapshot', async () => {
  const directory = await cacheDirectory();
  const app = Fastify();
  let fetched;
  const called = new Promise(resolve => {
    fetched = resolve;
  });
  const catalog = createRegistryCatalog({
    fetcher: async () => {
      fetched();
      return Response.json({
        servers: [
          {
            server: {
              name: 'org.example/startup',
              version: '1',
              description: 'Startup sync',
              remotes: [{ type: 'streamable-http', url: 'https://startup.example.com/mcp' }],
            },
            _meta: {
              'io.modelcontextprotocol.registry/official': {
                status: 'active',
                updatedAt: '2026-10-02T00:00:00.000Z',
                isLatest: true,
              },
            },
          },
        ],
        metadata: {},
      });
    },
  });
  try {
    registerWorkspaceMcpCatalogRefresh(app, workspaceMcpCatalog(catalog, workspaceMcpCatalogCache(directory)));
    await app.ready();
    await called;
    await app.close();
    const restored = await workspaceMcpCatalogCache(directory).read();
    assert.equal(restored.entries[0].name, 'org.example/startup');
    assert.deepEqual(Object.keys(restored).sort(), ['entries', 'policyVersion', 'syncedAt']);
    assert.equal('headers' in restored.entries[0], false);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('catalog chunks keep restored and live caches unchanged until complete, without republishing fresh no-ops', async () => {
  let epoch = Date.parse('2026-10-02T00:00:00.000Z');
  let elapsed = 0;
  let scan = 0;
  const published = [];
  const entry = {
    id: 'cached',
    name: 'org/cached',
    title: 'Cached',
    description: 'Last good',
    version: '1',
    endpoint: 'https://cached.example.com/mcp',
    status: 'active',
    compatibility: 'unverified',
    authentication: 'unknown',
  };
  const cached = { policyVersion: 'latest-usable-v1', syncedAt: '2026-10-01T00:00:00.000Z', entries: [entry] };
  const registry = createRegistryCatalog({
    now: () => new Date(epoch),
    elapsedNow: () => elapsed,
    fetcher: async input => {
      elapsed += 45000;
      const last = new URL(input).searchParams.has('cursor');
      return Response.json({
        servers: [
          {
            server: {
              name: `org/scan-${scan}-${last}`,
              version: '1',
              description: 'Chunk',
              remotes: [{ type: 'streamable-http', url: entry.endpoint }],
            },
            _meta: {
              'io.modelcontextprotocol.registry/official': {
                status: 'active',
                updatedAt: new Date(epoch).toISOString(),
                isLatest: true,
              },
            },
          },
        ],
        metadata: last ? {} : { nextCursor: 'last' },
      });
    },
  });
  const adapter = workspaceMcpCatalog(registry, {
    read: async () => cached,
    publish: async value => {
      published.push(value);
    },
  });
  assert.equal((await adapter.refresh()).refreshInProgress, true);
  assert.equal(adapter.search('').entries[0].id, 'cached');
  assert.equal(adapter.search('').syncedAt, cached.syncedAt);
  assert.equal(adapter.search('').stale, true);
  assert.equal(published.length, 0);
  assert.equal((await adapter.refresh()).refreshInProgress, false);
  assert.equal(published.length, 1);
  const complete = adapter.search('');
  assert.equal(complete.entries.length, 2);
  await adapter.refresh();
  assert.equal(published.length, 1);
  scan++;
  epoch += 7 * 3600000;
  assert.equal((await adapter.refresh()).refreshInProgress, true);
  assert.equal(published.length, 1);
  assert.equal(adapter.search('').snapshotVersion, complete.snapshotVersion);
  assert.equal(adapter.search('').syncedAt, complete.syncedAt);
  assert.equal(adapter.search('').stale, true);
  await adapter.refresh();
  assert.equal(published.length, 2);
});

test('scheduled chunks report real progress and continue promptly without publishing an empty startup cache', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let elapsed = 0;
  let attempts = 0;
  const published = [];
  const logs = [];
  const app = Fastify();
  t.mock.method(app.log, 'info', (...args) => logs.push(args));
  const registry = createRegistryCatalog({
    elapsedNow: () => elapsed,
    fetcher: async () => {
      elapsed += 45000;
      attempts++;
      return Response.json({ servers: [], metadata: attempts < 3 ? { nextCursor: String(attempts) } : {} });
    },
  });
  const adapter = workspaceMcpCatalog(registry, {
    read: async () => null,
    publish: async value => {
      published.push(value);
    },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    registerWorkspaceMcpCatalogRefresh(app, adapter);
    await app.ready();
    await settle();
    assert.equal(attempts, 1);
    assert.equal(adapter.search('').syncedAt, null);
    assert.equal(adapter.search('').stale, true);
    assert.equal(published.length, 0);
    assert.deepEqual(logs[0][0], { catalogStatus: 'in-progress', completedPages: 1 });
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(attempts, 2);
    assert.equal(published.length, 0);
    assert.deepEqual(logs[1][0], { catalogStatus: 'in-progress', completedPages: 2 });
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(attempts, 3);
    assert.equal(published.length, 1);
    assert.ok(adapter.search('').syncedAt);
    await app.close();
    t.mock.timers.tick(900000);
    await settle();
    assert.equal(attempts, 3);
  } finally {
    await app.close();
  }
});

test('scheduled catalog failures retain safe diagnostics in job spans and clear them after recovery', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  const app = Fastify();
  let failed = true;
  const registry = createRegistryCatalog({
    fetcher: async () =>
      failed
        ? new Response('PRIVATE RESPONSE', { status: 503, headers: { 'retry-after': 'PRIVATE HEADER' } })
        : Response.json({ servers: [], metadata: {} }),
  });
  const adapter = workspaceMcpCatalog(registry);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  // InMemorySpanExporter acknowledges exports with setTimeout(0), which only runs when mocked time advances.
  const flushSpans = () => {
    t.mock.timers.tick(0);
    return provider.forceFlush();
  };
  try {
    registerWorkspaceMcpCatalogRefresh(app, adapter);
    await app.ready();
    await settle();
    await flushSpans();
    const failedSpan = exporter.getFinishedSpans().find(span => span.name === 'job.mcp-catalog-refresh');
    assert.equal(failedSpan.attributes['error.code'], 'catalog-http');
    assert.equal(failedSpan.attributes['error.stage'], 'catalog-fetch');
    assert.equal(failedSpan.attributes['catalog.http_status'], 503);
    assert.equal(failedSpan.attributes['catalog.page_bytes'], 0);
    assert.equal(failedSpan.attributes['catalog.received_bytes'], 0);
    assert.equal(failedSpan.attributes['catalog.completed_pages'], 0);
    assert.equal(failedSpan.attributes['catalog.attempts'], 1);
    assert.doesNotMatch(JSON.stringify(failedSpan.attributes), /PRIVATE/);
    failed = false;
    t.mock.timers.tick(900000);
    await settle();
    await flushSpans();
    const recovered = exporter.getFinishedSpans().at(-1);
    assert.equal(recovered.attributes.outcome, 'success');
    assert.equal(recovered.attributes['error.stage'], undefined);
    assert.equal(recovered.attributes['catalog.http_status'], undefined);
    assert.ok(adapter.search('').syncedAt);
  } finally {
    await app.close();
    trace.disable();
    await provider.shutdown();
  }
});

test('shutdown cancels pending chunk continuation', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let elapsed = 0;
  let attempts = 0;
  const app = Fastify();
  const registry = createRegistryCatalog({
    elapsedNow: () => elapsed,
    fetcher: async () => {
      elapsed += 45000;
      attempts++;
      return Response.json({ servers: [], metadata: { nextCursor: String(attempts) } });
    },
  });
  registerWorkspaceMcpCatalogRefresh(app, workspaceMcpCatalog(registry));
  await app.ready();
  await new Promise(resolve => setImmediate(resolve));
  await app.close();
  t.mock.timers.tick(900000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
});

test('scheduled catalog outages retain cached entries and last success, without blocking startup or leaking registrations', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let epoch = Date.parse('2026-10-02T00:00:00.000Z');
  t.mock.method(Date, 'now', () => epoch);
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const exportMetrics = exporter.export.bind(exporter);
  t.mock.method(exporter, 'export', (data, callback) => {
    exportMetrics(data, callback);
    t.mock.timers.tick(0);
  });
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 86400000 });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  const meter = metrics.getMeter('tulipfarm');
  const registered = t.mock.method(meter, 'addBatchObservableCallback');
  const unregistered = t.mock.method(meter, 'removeBatchObservableCallback');
  const app = Fastify();
  let failed = true;
  let attempts = 0;
  const entry = {
    id: 'cached',
    name: 'org.example/cached',
    title: 'Cached server',
    description: 'Cached catalog',
    version: '1',
    endpoint: 'https://cached.example.com/mcp',
    status: 'active',
    compatibility: 'unverified',
    authentication: 'unknown',
  };
  let cached = { syncedAt: '2026-10-01T00:00:00.000Z', entries: [entry] };
  const registry = createRegistryCatalog({
    now: () => new Date(epoch),
    fetcher: async () => {
      attempts++;
      if (failed) throw new Error('PRIVATE REGISTRY OUTAGE');
      return Response.json({
        servers: [
          {
            server: {
              name: entry.name,
              title: entry.title,
              description: entry.description,
              version: entry.version,
              remotes: [{ type: 'streamable-http', url: entry.endpoint }],
            },
            _meta: {
              'io.modelcontextprotocol.registry/official': {
                status: 'active',
                updatedAt: new Date(epoch).toISOString(),
                isLatest: true,
              },
            },
          },
        ],
        metadata: {},
      });
    },
  });
  const catalog = workspaceMcpCatalog(registry, {
    read: async () => structuredClone(cached),
    publish: async snapshot => {
      cached = structuredClone(snapshot);
    },
  });
  const collect = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await reader.forceFlush();
    return exporter
      .getMetrics()
      .at(-1)
      .scopeMetrics.flatMap(scope => scope.metrics);
  };
  const value = (data, name) =>
    data
      .find(metric => metric.descriptor.name === name)
      ?.dataPoints.find(point => point.attributes.background_job === 'mcp-catalog-refresh')?.value;
  try {
    registerWorkspaceMcpCatalogRefresh(app, catalog);
    await app.ready();
    let data = await collect();
    assert.equal(attempts, 1);
    assert.equal(value(data, 'cloud_background_job_last_success'), 0);
    assert.equal(value(data, 'cloud_background_job_last_completion'), epoch / 1000);
    const cachedEntries = catalog.search('').entries;
    assert.equal(cachedEntries.length, 1);
    assert.equal(cachedEntries[0].id, entry.id);
    assert.equal(cachedEntries[0].name, entry.title);
    assert.equal(cached.syncedAt, '2026-10-01T00:00:00.000Z');

    failed = false;
    epoch += 900000;
    t.mock.timers.tick(900000);
    data = await collect();
    assert.equal(attempts, 2);
    assert.equal(value(data, 'cloud_background_job_last_success'), epoch / 1000);
    const fresh = catalog.search('');
    const saved = structuredClone(cached);

    epoch += 900000;
    t.mock.timers.tick(900000);
    data = await collect();
    assert.equal(attempts, 2, 'fresh catalog refresh remains a successful no-op');
    const lastSuccess = value(data, 'cloud_background_job_last_success');
    assert.equal(lastSuccess, epoch / 1000);

    failed = true;
    epoch += 7 * 3600000;
    t.mock.timers.tick(900000);
    data = await collect();
    assert.equal(attempts, 3);
    assert.equal(value(data, 'cloud_background_job_last_success'), lastSuccess);
    assert.equal(value(data, 'cloud_background_job_last_completion'), epoch / 1000);
    assert.equal(value(data, 'cloud_background_job_success_age'), 7 * 3600);
    assert.deepEqual(cached, saved);
    assert.deepEqual(catalog.search('').entries, fresh.entries);
    assert.equal(catalog.search('').stale, true);
    const runs = data.find(metric => metric.descriptor.name === 'cloud_background_job_runs').dataPoints;
    assert.equal(runs.find(point => point.attributes.outcome === 'error').value, 2);
    assert.equal(runs.find(point => point.attributes.outcome === 'success').value, 2);
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE|REGISTRY OUTAGE/);

    await app.close();
    assert.equal(registered.mock.calls.length, 1);
    assert.equal(unregistered.mock.calls.length, 1);
    assert.deepEqual(unregistered.mock.calls[0].arguments, registered.mock.calls[0].arguments);
    t.mock.timers.tick(900000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 3, 'shutdown removes the refresh timer');
  } finally {
    await app.close();
    await provider.shutdown();
    metrics.disable();
    t.mock.restoreAll();
  }
});

test('cold catalog retries the unfinished page after five seconds and publishes only the complete snapshot', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const app = Fastify();
  const cursors = [];
  const published = [];
  const warnings = t.mock.method(app.log, 'warn');
  const registry = createRegistryCatalog({
    fetcher: async input => {
      const cursor = new URL(input).searchParams.get('cursor');
      cursors.push(cursor);
      if (cursors.length === 2) return new Response('PRIVATE', { status: 503 });
      return Response.json({
        servers: [
          {
            server: {
              name: cursor ? 'org/second' : 'org/first',
              version: '1',
              description: 'Latest listing',
              remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
            },
            _meta: {
              'io.modelcontextprotocol.registry/official': {
                status: 'active',
                isLatest: true,
                updatedAt: '2026-10-14T00:00:00Z',
              },
            },
          },
        ],
        metadata: cursor ? {} : { nextCursor: 'second' },
      });
    },
  });
  const catalog = workspaceMcpCatalog(registry, {
    read: async () => null,
    publish: async snapshot => {
      published.push(snapshot);
    },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    registerWorkspaceMcpCatalogRefresh(app, catalog);
    await app.ready();
    await settle();
    assert.deepEqual(cursors, [null, 'second']);
    assert.equal(warnings.mock.calls.length, 1);
    assert.equal(published.length, 0);
    assert.deepEqual(catalog.search('').entries, []);
    t.mock.timers.tick(4999);
    await settle();
    assert.equal(cursors.length, 2);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(cursors, [null, 'second', 'second']);
    assert.equal(published.length, 1);
    assert.equal(published[0].entries.length, 2);
    assert.equal(catalog.search('').entries.length, 2);
  } finally {
    await app.close();
  }
});

test('fast retries require a resumable timeout, network failure or approved HTTP status', async t => {
  const cases = [
    ['catalog-timeout', undefined, true, true],
    ['network-failed', undefined, true, true],
    ...[500, 502, 503, 504].map(status => ['catalog-http', status, true, true]),
    ...[400, 401, 404, 429, 501].map(status => ['catalog-http', status, true, false]),
    ['catalog-invalid-schema', undefined, false, false],
    ['catalog-byte-limit', undefined, false, false],
    ['network-failed', undefined, false, false],
  ];
  for (const [failureCode, httpStatus, refreshInProgress, fast] of cases) {
    await t.test(`${failureCode}/${httpStatus}/${refreshInProgress}`, async t => {
      t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
      const app = Fastify();
      let calls = 0;
      const settle = () => new Promise(resolve => setImmediate(resolve));
      try {
        registerWorkspaceMcpCatalogRefresh(app, {
          load: async () => {},
          refresh: async () => {
            calls++;
            return {
              refreshFailed: true,
              refreshInProgress,
              failureCode,
              failureDiagnostics: { httpStatus, pageBytes: 0, receivedBytes: 0, completedPages: 0, attempts: calls },
            };
          },
        });
        await app.ready();
        await settle();
        t.mock.timers.tick(5000);
        await settle();
        assert.equal(calls, fast ? 2 : 1);
        if (!fast) {
          t.mock.timers.tick(895000);
          await settle();
          assert.equal(calls, 2);
        }
      } finally {
        await app.close();
      }
    });
  }
});

test('one failing scan gets only two fast retries before returning to the normal interval', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const app = Fastify();
  let calls = 0;
  const warnings = t.mock.method(app.log, 'warn');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    registerWorkspaceMcpCatalogRefresh(app, {
      load: async () => {},
      refresh: async () => {
        calls++;
        return { refreshFailed: true, refreshInProgress: true, failureCode: 'network-failed' };
      },
    });
    await app.ready();
    await settle();
    t.mock.timers.tick(4999);
    await settle();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(calls, 2);
    t.mock.timers.tick(14999);
    await settle();
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(calls, 3);
    t.mock.timers.tick(879999);
    await settle();
    assert.equal(calls, 3);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(calls, 4);
    t.mock.timers.tick(20000);
    await settle();
    assert.equal(calls, 4);
    assert.equal(warnings.mock.calls.length, 4);
  } finally {
    await app.close();
  }
});

test('planned progress does not refill fast retries; a completed or discarded scan does', async t => {
  for (const discarded of [false, true])
    await t.test(String(discarded), async t => {
      t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
      const app = Fastify();
      let calls = 0;
      const failure = { refreshFailed: true, refreshInProgress: true, failureCode: 'network-failed' };
      const progress = { refreshFailed: false, refreshInProgress: true, completedPages: 1 };
      const end = {
        refreshFailed: discarded,
        refreshInProgress: false,
        ...(discarded ? { failureCode: 'catalog-invalid-schema' } : {}),
      };
      const results = [failure, progress, failure, progress, failure, end, failure, end];
      const settle = () => new Promise(resolve => setImmediate(resolve));
      try {
        registerWorkspaceMcpCatalogRefresh(app, { load: async () => {}, refresh: async () => results[calls++] });
        await app.ready();
        await settle();
        for (const [delay, expected] of [
          [5000, 2],
          [1000, 3],
          [15000, 4],
          [1000, 5],
          [20000, 5],
          [858000, 6],
          [900000, 7],
          [5000, 8],
        ]) {
          t.mock.timers.tick(delay);
          await settle();
          assert.equal(calls, expected);
        }
      } finally {
        await app.close();
      }
    });
});

test('retry timers outrank interval ticks, do not overlap callbacks and are cancelled on shutdown', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const app = Fastify();
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let calls = 0;
  const failure = { refreshFailed: true, refreshInProgress: true, failureCode: 'network-failed' };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    registerWorkspaceMcpCatalogRefresh(app, {
      load: async () => {},
      refresh: async () => {
        calls++;
        return calls === 1 ? first.promise : second.promise;
      },
    });
    await app.ready();
    await settle();
    t.mock.timers.tick(899000);
    await settle();
    assert.equal(calls, 1);
    first.resolve(failure);
    await settle();
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(calls, 1, 'interval must not preempt the five-second retry');
    t.mock.timers.tick(4000);
    await settle();
    assert.equal(calls, 2);
    t.mock.timers.tick(900000);
    await settle();
    assert.equal(calls, 2, 'a pending request cannot overlap an interval callback');
    second.resolve(failure);
    await settle();
    await app.close();
    t.mock.timers.tick(900000);
    await settle();
    assert.equal(calls, 2);
  } finally {
    first.resolve(failure);
    second.resolve(failure);
    await app.close();
  }
});
