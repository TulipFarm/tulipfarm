import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

test('HTTP failures end runs, while failed storage writes remain retryable', { timeout: 120000 }, async t => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    let storageUnavailable = false;
    const failing = {
      ...runtime,
      transaction: (workspaceId, compatibility, operation) =>
        runtime.transaction(workspaceId, compatibility, tx =>
          operation({
            ...tx,
            client: new Proxy(tx.client, {
              get(client, key) {
                if (key !== 'query') {
                  const value = client[key];
                  return typeof value === 'function' ? value.bind(client) : value;
                }
                return async (sql, params) => {
                  if (storageUnavailable && sql.includes("SET status='failed',error=$2"))
                    throw new Error('storage unavailable');
                  return client.query(sql, params);
                };
              },
            }),
          }),
        ),
    };
    const service = createWorkflows(failing),
      id = randomUUID(),
      revision = randomUUID();
    await service.save(w.id, w.userId, id, {
      revision,
      expectedRevision: null,
      definition: {
        version: 1,
        name: 'HTTP failure',
        trigger: { kind: 'manual' },
        steps: [{ id: 'request', kind: 'http', method: 'POST', url: 'https://example.test', headers: {} }],
      },
    });
    await activate(service, w.id, w.userId, id, revision, true);
    for (const failure of ['timeout', 'connection', 'dns', 'egress', 'response-too-large', 'storage'])
      await t.test(failure, async t => {
        const { runId } = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: {} });
        const work = { workspaceId: w.id, runId };
        const expected =
          failure === 'timeout'
            ? 'http-request-timeout'
            : failure === 'egress'
              ? 'http-egress-denied'
              : failure === 'response-too-large'
                ? 'http-response-too-large'
                : 'http-request-failed';
        let requests = 0;
        t.mock.method(dns, 'lookup', async () => {
          if (failure === 'dns') throw Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' });
          return [{ address: failure === 'egress' ? '127.0.0.1' : '8.8.8.8', family: 4 }];
        });
        t.mock.method(https, 'request', (_url, _options, callback) => {
          requests++;
          return new Writable({
            final(done) {
              if (failure === 'response-too-large') {
                const response = Readable.from([Buffer.alloc(1_048_577)]);
                callback(response);
                done();
              } else if (failure === 'timeout') {
                done();
              } else done(new Error('connection refused'));
            },
          });
        });
        const timeout = globalThis.setTimeout;
        if (failure === 'timeout')
          t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) =>
            timeout(callback, milliseconds === 10_000 ? 0 : milliseconds, ...args),
          );
        syncBuiltinESMExports();
        try {
          storageUnavailable = failure === 'storage';
          if (storageUnavailable) {
            await assert.rejects(service.activity(work), /^Error: workflow-storage-unavailable$/);
            const run = (await service.history(w.id, w.userId, id)).runs.find(run => run.id === runId);
            assert.equal(run.status, 'waiting');
            assert.equal(run.error, null);
            storageUnavailable = false;
          }
          assert.deepEqual(await service.activity(work), { kind: 'done' });
          const run = (await service.history(w.id, w.userId, id)).runs.find(run => run.id === runId);
          assert.equal(run.status, 'failed');
          assert.equal(run.error, expected);
          const attempts = requests;
          assert.deepEqual(await service.activity(work), { kind: 'done' });
          assert.equal(requests, attempts, 'a failed run never repeats its HTTP request');
          assert.equal(requests, ['dns', 'egress'].includes(failure) ? 0 : failure === 'storage' ? 2 : 1);
        } finally {
          storageUnavailable = false;
          t.mock.restoreAll();
          syncBuiltinESMExports();
        }
      });
  } finally {
    await runtime?.close();
    await db.close();
  }
});
