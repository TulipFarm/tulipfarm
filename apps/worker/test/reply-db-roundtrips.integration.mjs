import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { creditSummary, holdReplyCredits } from '@tulipfarm/workspace-storage/credits';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { useModelFamilies } from './model-families-fixture.mjs';
import { anthropicText, completionReply, isCompletionRequest, isTitleRequest } from './native-chat-fixture.mjs';
import { meteredRuntime } from './reply-db-meter.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const unitsPerCredit = 1_000_000_000_000n;
const writesCredits = record => record.statements.some(s => /^\s*(INSERT|UPDATE)\b[^]*tf_credit_usage/i.test(s));
const delivers = record => record.statements.some(s => /^\s*INSERT\b[^]*tf_conversation_results/i.test(s));
const publishes = record => record.statements.some(s => /pg_notify/.test(s));

/** A conversation fixture whose Anthropic traffic goes to `respond(request, context)`. */
async function harness(t, respond) {
  const f = await conversationFixture();
  const meter = meteredRuntime(f.runtime);
  const openDuringModel = new Set();
  const counts = { chat: 0, completion: 0, title: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    for (const record of meter.transactions) if (record.open) openDuringModel.add(record);
    const request = JSON.parse(body);
    const kind = isTitleRequest(request) ? 'title' : isCompletionRequest(request) ? 'completion' : 'chat';
    counts[kind]++;
    const reply = (await respond?.(kind, counts[kind])) ?? {
      body:
        kind === 'title'
          ? anthropicText('Greeting')
          : kind === 'completion'
            ? completionReply('anthropic')
            : anthropicText('Hello there.'),
    };
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) =>
    new URL(url).hostname === 'api.anthropic.com'
      ? fetch(`http://127.0.0.1:${server.address().port}/`, options)
      : fetch(url, options),
  );
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-only';
  t.after(useModelFamilies());
  t.after(async () => {
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await f.close();
  });
  const w = f.workspace;
  const activity = createConversationActivities(meter.runtime).processConversationReply;
  return {
    f,
    meter,
    counts,
    openDuringModel,
    summary: () => f.runtime.transaction(w.id, commonCompatibility, creditSummary),
    setAvailable: units => f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=$1`, [units]),
    async send(text = 'hey') {
      const chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const turn = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text }],
      });
      return { workspaceId: w.id, conversationId: chatId, turnId: turn.turnId, generation: 0 };
    },
    run: work => activity(work),
    last: async work => (await f.store.history(w.id, w.userId, work.conversationId)).messages.at(-1),
  };
}

test('a greeting reads once at the start and writes once at the end', { timeout: 60000 }, async t => {
  const h = await harness(t);
  const work = await h.send();
  h.meter.reset();
  assert.equal(await h.run(work), 'completed');
  assert.deepEqual(h.counts, { chat: 1, completion: 1, title: 1 });
  const all = h.meter.transactions;
  // The claim's read-only balance check is the only other ledger access.
  const credit = all.filter(writesCredits);
  assert.equal(credit.length, 2, 'one reservation at the start and one settlement at the end, none per model call');
  const [start, end] = credit;
  assert.ok(!delivers(start));
  assert.ok(delivers(end), 'the reply, its result and the settlement commit together');
  // Between the start read and the end write, only stream notifications reach the database.
  const between = all.slice(all.indexOf(start) + 1, all.indexOf(end));
  assert.deepEqual(
    between.filter(r => !publishes(r)),
    [],
  );
  assert.deepEqual(
    [...h.openDuringModel].filter(r => !publishes(r)),
    [],
    'no transaction stays open while a model call runs',
  );
  assert.ok(all.length <= 9, `greeting used ${all.length} transactions`);
  const summary = await h.summary();
  assert.equal(summary.used, 0.1);
  assert.equal(summary.available, 999.9);
  assert.equal(summary.held, 0);
  assert.equal(
    (
      await h.f.db.platform.query(`SELECT count(*)::int AS n FROM ${h.f.table('tf_credit_usage')} WHERE flow_id=$1`, [
        work.conversationId,
      ])
    ).rows[0].n,
    3,
    'every model call keeps its own usage row',
  );
});

test('concurrent replies in one workspace never overdraw the balance', { timeout: 120000 }, async t => {
  const h = await harness(t, async kind => {
    if (kind === 'chat') await new Promise(resolve => setTimeout(resolve, 150));
  });
  const first = await Promise.all([h.send(), h.send(), h.send()]);
  assert.deepEqual(await Promise.all(first.map(h.run)), ['completed', 'completed', 'completed']);
  assert.equal((await h.summary()).held, 0);
  const hold = BigInt(
    (
      await h.f.db.platform.query(
        `SELECT max(reserved)::text AS n FROM ${h.f.table('tf_credit_usage')} WHERE id LIKE 'chat:%:0'`,
      )
    ).rows[0].n,
  );
  // Room for one whole hold and part of another: the replies compete for one balance.
  const initial = (hold * 3n) / 2n;
  await h.setAvailable(initial.toString());
  const before = await h.summary();
  const work = await Promise.all([h.send(), h.send(), h.send()]);
  const outcomes = await Promise.all(work.map(h.run));
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome === 'completed') continue;
    assert.equal(outcome, 'failed');
    assert.equal((await h.last(work[index])).turn.errorCode, 'credits-exhausted');
  }
  assert.ok(outcomes.includes('completed'));
  const after = await h.summary();
  assert.equal(after.held, 0);
  assert.ok(after.available >= 0);
  const spent = after.used - before.used;
  assert.ok(Math.abs(after.available + spent - Number(initial) / Number(unitsPerCredit)) < 1e-9);
});

test('a failed or cancelled reply releases its hold', { timeout: 60000 }, async t => {
  let cancel;
  const h = await harness(t, async kind => {
    if (kind !== 'chat') return;
    if (cancel) {
      await cancel();
      return;
    }
    return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } };
  });
  const failed = await h.send();
  assert.notEqual(await h.run(failed), 'completed');
  assert.equal((await h.summary()).held, 0);
  const cancelled = await h.send();
  cancel = () =>
    h.f.store.cancel(h.f.workspace.id, h.f.workspace.userId, cancelled.conversationId, cancelled.turnId, {
      commandId: randomUUID(),
      expectedGeneration: 0,
    });
  assert.notEqual(await h.run(cancelled), 'completed');
  const summary = await h.summary();
  assert.equal(summary.held, 0);
  assert.equal(summary.available + summary.used, 1000);
});

test('a reply that outgrows its hold tops it up once, not per call', { timeout: 60000 }, async t => {
  const long = 'Still working. '.repeat(25_000);
  const h = await harness(t, (kind, n) => {
    // Unknown usage is charged at each call's worst case. Two long drafts grow the next requests past the opening hold.
    if (kind === 'chat')
      return { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: n < 3 ? long : 'Done.' }] } };
    if (kind === 'completion' && n <= 2) return { body: completionReply('anthropic', 'continue') };
  });
  const work = await h.send();
  h.meter.reset();
  assert.equal(await h.run(work), 'completed');
  assert.equal(h.counts.chat, 3);
  const credit = h.meter.transactions.filter(writesCredits);
  const calls = h.counts.chat + h.counts.completion + h.counts.title;
  assert.ok(credit.length >= 3, 'the reply topped up its hold');
  assert.equal((await h.last(work)).parts[0].text, 'Done.');
  assert.ok(credit.length < calls, `${credit.length} credit transactions for ${calls} model calls`);
  const summary = await h.summary();
  assert.equal(summary.held, 0);
  assert.ok(summary.used > 0.1);
  assert.equal(summary.available + summary.used, 1000);
});

test('the next attempt settles a crashed attempt hold', { timeout: 60000 }, async t => {
  const h = await harness(t);
  const work = await h.send();
  const crashed = `chat:${work.turnId}:0:999:0`;
  await h.f.runtime.transaction(h.f.workspace.id, commonCompatibility, tx =>
    holdReplyCredits(tx, {
      id: crashed,
      flowId: work.conversationId,
      modelId: 'claude-sonnet-5',
      activity: 'chat',
      pricingRevision: 'crashed-attempt',
      minimum: 1n,
      preferred: 5n * unitsPerCredit,
      planAttemptId: null,
    }),
  );
  assert.equal((await h.summary()).held, 5);
  assert.equal(await h.run(work), 'completed');
  const row = (
    await h.f.db.platform.query(
      `SELECT reserved::text, charged::text FROM ${h.f.table('tf_credit_usage')} WHERE id=$1`,
      [crashed],
    )
  ).rows[0];
  assert.equal(row.charged, row.reserved);
  const summary = await h.summary();
  assert.equal(summary.held, 0);
  assert.equal(summary.used, 5.1);
  assert.equal(summary.available + summary.used, 1000);
});
