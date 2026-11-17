/**
 * Send latency in one workspace while another transaction holds the workspace lock:
 *   TEST_ADMIN_DATABASE_URL=postgresql://postgres:PASSWORD@127.0.0.1:5432/postgres \
 *     HOLD=read BENCH_CONNECTIONS=3 node --test packages/conversations/test/bench/lock-contention.bench.mjs
 * HOLD is the mode the slow transaction takes: `read` or `write`.
 * BUD=<n> also sends n Bud `sync` commands during the burst, as open browser windows do.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { lockAuthorization } from '@tulipfarm/access';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createBudAssistant } from '../../src/bud-assistant.ts';
import { createConversations } from '../../src/index.ts';
import { conversationFixture } from '../fixture.mjs';

const sends = Number(process.env.BENCH_SENDS ?? 200);
const holdSeconds = Number(process.env.BENCH_HOLD_SECONDS ?? 3);
const connections = Number(process.env.BENCH_CONNECTIONS ?? 3);
const budSyncs = Number(process.env.BUD ?? 0);
const hold = process.env.HOLD === 'write' ? 'write' : 'read';
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

test('sends while a slow transaction holds the workspace lock', { timeout: 10 * 60 * 1000 }, async () => {
  const f = await conversationFixture();
  const worker = f.createRuntime();
  const api = createWorkspaceRuntime({
    replicaCount: 1,
    maxPools: 1,
    connectionsPerPool: connections,
    maxConcurrentTransactions: 12,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: f.db.login(f.workspace) }),
  });
  try {
    const w = f.workspace;
    const store = createConversations(api);
    const chats = Array.from({ length: sends }, () => randomUUID());
    for (const chatId of chats) await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });

    const bud = createBudAssistant(api);
    if (budSyncs) await bud.command(w.id, w.userId, { kind: 'bootstrap' });
    let held;
    const locked = new Promise(resolve => (held = resolve));
    const holder = worker.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx, hold);
      held();
      await tx.client.query('SELECT pg_sleep($1)', [holdSeconds]);
    });
    await locked;

    const started = performance.now();
    const syncs = Promise.allSettled(
      Array.from({ length: budSyncs }, () => bud.command(w.id, w.userId, { kind: 'sync' })),
    );
    const results = await Promise.allSettled(
      chats.map(async chatId => {
        const at = performance.now();
        await store.send(w.id, w.userId, chatId, {
          messageId: randomUUID(),
          commandId: randomUUID(),
          parts: [{ kind: 'text', text: 'hello' }],
        });
        return performance.now() - at;
      }),
    );
    const budFailed = (await syncs).filter(result => result.status === 'rejected').length;
    const total = performance.now() - started;
    await holder;

    const ok = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const failed = results.filter(result => result.status === 'rejected');
    ok.sort((a, b) => a - b);
    const reasons = {};
    for (const { reason } of failed) {
      const key = `${reason?.code ?? reason?.name ?? 'error'}: ${String(reason?.message).slice(0, 160)}`;
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    console.log(
      JSON.stringify({
        hold,
        connections,
        holdSeconds,
        sends,
        budSyncs,
        budFailed,
        saved: ok.length,
        failed: failed.length,
        reasons,
        p50Ms: Math.round(percentile(ok, 0.5) ?? 0),
        p95Ms: Math.round(percentile(ok, 0.95) ?? 0),
        maxMs: Math.round(ok.at(-1) ?? 0),
        totalMs: Math.round(total),
      }),
    );
  } finally {
    await api.close();
    await worker.close();
    await f.close();
  }
});
