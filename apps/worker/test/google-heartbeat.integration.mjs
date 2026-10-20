import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { heartbeatFixture } from '../../../packages/google-workspace/test/heartbeat-fixture.mjs';
import { heartbeatProcessor, createGoogleHeartbeatActivities } from '../dist/google-heartbeat-activities.js';
import { conversationModel } from '../dist/conversation-model.js';
import { dispatchGmailHeartbeat } from '../../api/dist/google-heartbeat-dispatch.js';
import { creditSummary } from '@tulipfarm/workspace-storage/credits';
import { createModelPolicyService } from '@tulipfarm/agents/model-policy';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { hostedCreditPricingExtension } from '../../../packages/workspace-storage/test/hosted-credit-pricing.mjs';

// Budget and balance assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

// These tests assert workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const model = conversationModel('claude-haiku', {
  MODEL_FAMILIES: 'claude-haiku,claude-sonnet',
  ANTHROPIC_API_KEY: 'fixture-only',
});
assert.deepEqual(
  [model.route.provider, model.route.endpoint, model.route.model, model.route.apiKey],
  ['anthropic', 'https://api.anthropic.com/', 'claude-haiku-4-5', 'fixture-only'],
);
const retryDue = f =>
  f.db.platform.query(
    `UPDATE ${f.table('tf_google_heartbeat_items')} SET retry_at=clock_timestamp()-interval '1 second' WHERE status='queued'`,
  );
const summary = f => f.runtime.transaction(f.workspace.id, commonCompatibility, creditSummary);
const intake = async f => {
  await f.configure();
  const work = await f.work();
  await f.service.poll(work);
  await f.service.poll(work);
  return work;
};
const response = () =>
  Response.json({
    content: [{ type: 'text', text: 'Recovered private answer' }],
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
test('API discovery and worker activity produce a private metered answer through the real no-tools model adapter', async t => {
  const f = await heartbeatFixture();
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.tools, undefined);
    assert.match(JSON.stringify(input.messages), /attacker@example.test/);
    assert.match(JSON.stringify(input.messages), /Extract a safe summary/);
    calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        content: [{ type: 'text', text: 'This email contains an unsafe forwarding request. No action was taken.' }],
        usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(new URL(url).hostname, 'api.anthropic.com');
    return originalFetch(`http://127.0.0.1:${server.address().port}/`, options);
  });
  try {
    await f.configure({ instructions: 'Extract a safe summary' });
    const activity = createGoogleHeartbeatActivities(f.runtime, {
      service: f.service,
      processor: heartbeatProcessor(f.runtime, model),
    });
    const scheduled = [];
    await dispatchGmailHeartbeat(f.service, f.workspace.id, async work => {
      scheduled.push(work);
      await activity.processGmailHeartbeat(work);
    });
    assert.deepEqual(Object.keys(scheduled[0]).sort(), ['heartbeatId', 'workspaceId']);
    assert.equal((await f.results()).results.length, 0);
    await activity.processGmailHeartbeat(scheduled[0]);
    assert.equal(
      (await f.results()).results[0].answer,
      'This email contains an unsafe forwarding request. No action was taken.',
    );
    const summary = await f.runtime.transaction(f.workspace.id, commonCompatibility, creditSummary);
    assert.equal(summary.used, 1);
    assert.equal(summary.held, 0);
    assert.equal(summary.available, 999);
    assert.equal(summary.breakdown[0].activity, 'other');
    await activity.processGmailHeartbeat(scheduled[0]);
    assert.equal(calls, 1);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_google_proposals')}`)).rows[0].count,
      0,
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_conversation_messages')}`)).rows[0]
        .count,
      0,
    );
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});

test('invalid route and exhausted credits block model dispatch; unknown usage retains reservation', async t => {
  const f = await heartbeatFixture();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ content: [{ type: 'text', text: 'Private answer with unreported usage.' }] });
  });
  try {
    await f.configure();
    const work = await f.work();
    await f.service.poll(work);
    await f.service.poll(work);
    await f.service.process(
      work,
      heartbeatProcessor(f.runtime, { ...model, route: { ...model.route, apiKey: 'invalid key' } }),
    );
    assert.equal(calls, 0);
    let summary = await f.runtime.transaction(f.workspace.id, commonCompatibility, creditSummary);
    assert.equal(summary.available, 1000);
    assert.equal(summary.held, 0);
    await retryDue(f);
    await f.service.process(work, heartbeatProcessor(f.runtime, model));
    assert.equal((await f.results()).results[0].answer, 'Private answer with unreported usage.');
    summary = await f.runtime.transaction(f.workspace.id, commonCompatibility, creditSummary);
    assert.equal(summary.used, 0);
    assert.ok(summary.held > 0);
    f.set({
      history: { historyId: '102', history: [{ messagesAdded: [{ message: { id: 'mail2' } }] }] },
      matching: { messages: [{ id: 'mail2' }] },
    });
    await f.service.poll(work);
    await f.service.poll(work);
    await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0`);
    await f.service.process(work, heartbeatProcessor(f.runtime, model));
    assert.equal(calls, 1);
    assert.equal((await f.results()).results.find(row => row.messageId === 'mail2').answer, null);
  } finally {
    await f.close();
  }
});

test('expired processing lease requires owner retry after restart and fences the old model result', async () => {
  const f = await heartbeatFixture();
  try {
    await f.configure();
    const work = await f.work();
    await f.service.poll(work);
    await f.service.poll(work);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const stale = f.service.process(work, async () => {
      entered.resolve();
      await release.promise;
      return 'old result';
    });
    await entered.promise;
    await f.db.platform.query(
      `UPDATE ${f.table('tf_google_heartbeat_items')} SET lease_until=clock_timestamp()-interval '1 second'`,
    );
    await f.make().process(work, async () => assert.fail('Unknown outcome must not automatically dispatch'));
    const failed = (await f.results()).results[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'processing-outcome-unknown');
    await f.service.retry(f.workspace.id, f.member.userId, { commandId: randomUUID(), itemId: failed.id, revision: 1 });
    await f.make().process(work, async () => 'recovered result');
    release.resolve();
    await stale;
    const result = (await f.results()).results[0];
    assert.equal(result.status, 'succeeded');
    assert.equal(result.answer, 'recovered result');
    assert.equal(
      (await f.db.platform.query(`SELECT attempts FROM ${f.table('tf_google_heartbeat_items')}`)).rows[0].attempts,
      2,
    );
  } finally {
    await f.close();
  }
});

for (const blocked of ['missing', 'invalid', 'credits'])
  test(`${blocked} admission recovers after many failed checks without consuming attempts or hot retry`, async t => {
    const f = await heartbeatFixture();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return response();
    });
    try {
      const work = await intake(f);
      if (blocked === 'credits') await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0`);
      const unavailable =
        blocked === 'missing'
          ? null
          : blocked === 'invalid'
            ? { ...model, route: { ...model.route, apiKey: 'invalid key' } }
            : model;
      for (let i = 0; i < 8; i++) {
        await f.make().process(work, heartbeatProcessor(f.runtime, unavailable));
        const row = (
          await f.db.platform.query(
            `SELECT status,attempts,epoch,retry_at>clock_timestamp()+interval '4 minutes' AS backed_off FROM ${f.table('tf_google_heartbeat_items')}`,
          )
        ).rows[0];
        assert.equal(row.status, 'queued');
        assert.equal(row.attempts, 0);
        assert.equal(row.backed_off, true);
        await f.make().process(work, heartbeatProcessor(f.runtime, unavailable));
        assert.equal(
          (await f.db.platform.query(`SELECT epoch FROM ${f.table('tf_google_heartbeat_items')}`)).rows[0].epoch,
          row.epoch,
        );
        await retryDue(f);
      }
      assert.equal(calls, 0);
      assert.equal((await summary(f)).held, 0);
      if (blocked === 'credits')
        await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=1000000000000000`);
      await f.make().process(work, heartbeatProcessor(f.runtime, model));
      await f.service.poll(work);
      await f.service.poll(work);
      await f.make().process(work, heartbeatProcessor(f.runtime, model));
      const results = (await f.results()).results;
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'succeeded');
      assert.equal(results[0].answer, 'Recovered private answer');
      assert.equal(calls, 1);
      assert.equal(
        (await f.db.platform.query(`SELECT attempts FROM ${f.table('tf_google_heartbeat_items')}`)).rows[0].attempts,
        1,
      );
    } finally {
      await f.close();
    }
  });

test('workspace-disabled model cannot receive private email and reenable permits a fresh admission', async t => {
  const f = await heartbeatFixture();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return response();
  });
  try {
    const work = await intake(f);
    const policy = createModelPolicyService(f.runtime);
    await policy.saveAvailability(f.workspace.id, f.admin.userId, {
      requestId: randomUUID(),
      familyId: 'claude-haiku',
      expectedRevision: 0,
      enabled: false,
    });
    await f.service.process(work, heartbeatProcessor(f.runtime, model));
    assert.equal(calls, 0);
    assert.equal((await f.results()).results[0].error, 'model-disabled');
    assert.equal((await summary(f)).held, 0);
    await policy.saveAvailability(f.workspace.id, f.admin.userId, {
      requestId: randomUUID(),
      familyId: 'claude-haiku',
      expectedRevision: 1,
      enabled: true,
    });
    await retryDue(f);
    await f.make().process(work, heartbeatProcessor(f.runtime, model));
    assert.equal(calls, 1);
    assert.equal((await f.results()).results[0].answer, 'Recovered private answer');
  } finally {
    await f.close();
  }
});

for (const usage of ['known', 'unknown'])
  test(`disable and reenable in flight reject publication and preserve ${usage} usage accounting`, async t => {
    const f = await heartbeatFixture();
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return usage === 'known'
        ? response()
        : Response.json({ content: [{ type: 'text', text: 'Revoked model answer' }] });
    });
    try {
      const work = await intake(f);
      const policy = createModelPolicyService(f.runtime);
      const processing = f.service.process(work, heartbeatProcessor(f.runtime, model));
      await entered.promise;
      await policy.saveAvailability(f.workspace.id, f.admin.userId, {
        requestId: randomUUID(),
        familyId: 'claude-haiku',
        expectedRevision: 0,
        enabled: false,
      });
      await policy.saveAvailability(f.workspace.id, f.admin.userId, {
        requestId: randomUUID(),
        familyId: 'claude-haiku',
        expectedRevision: 1,
        enabled: true,
      });
      release.resolve();
      await processing;
      const result = (await f.results()).results[0];
      assert.equal(result.status, 'failed');
      assert.equal(result.answer, null);
      await f.make().process(work, heartbeatProcessor(f.runtime, model));
      assert.equal(calls, 1);
      const credits = await summary(f);
      if (usage === 'known') {
        assert.equal(credits.used, 1);
        assert.equal(credits.held, 0);
      } else {
        assert.equal(credits.used, 0);
        assert.ok(credits.held > 0);
      }
    } finally {
      release.resolve();
      await f.close();
    }
  });

test('disable and reenable between admission and dispatch release an unused reservation and transmit nothing', async t => {
  const f = await heartbeatFixture();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return response();
  });
  try {
    const work = await intake(f);
    const policy = createModelPolicyService(f.runtime);
    const processor = heartbeatProcessor(f.runtime, model);
    await f.service.process(work, input =>
      processor({
        ...input,
        dispatch: async run => {
          await policy.saveAvailability(f.workspace.id, f.admin.userId, {
            requestId: randomUUID(),
            familyId: 'claude-haiku',
            expectedRevision: 0,
            enabled: false,
          });
          await policy.saveAvailability(f.workspace.id, f.admin.userId, {
            requestId: randomUUID(),
            familyId: 'claude-haiku',
            expectedRevision: 1,
            enabled: true,
          });
          return input.dispatch(run);
        },
      }),
    );
    assert.equal(calls, 0);
    assert.equal((await f.results()).results[0].status, 'queued');
    assert.equal((await summary(f)).available, 1000);
    assert.equal((await summary(f)).held, 0);
    await retryDue(f);
    await f.service.process(work, processor);
    assert.equal(calls, 1);
    assert.equal((await f.results()).results[0].status, 'succeeded');
  } finally {
    await f.close();
  }
});

test('uncertain provider failure retains its hold and requires idempotent owner retry with preserved intake', async t => {
  const f = await heartbeatFixture();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) throw new Error('transport interrupted');
    return response();
  });
  try {
    const work = await intake(f);
    await f.service.process(work, heartbeatProcessor(f.runtime, model));
    const failed = (await f.results()).results[0];
    assert.equal(failed.status, 'failed');
    const held = (await summary(f)).held;
    assert.ok(held > 0);
    for (let i = 0; i < 5; i++) await f.make().process(work, heartbeatProcessor(f.runtime, model));
    assert.equal(calls, 1);
    const command = { commandId: randomUUID(), itemId: failed.id, revision: 1 };
    await f.service.retry(f.workspace.id, f.member.userId, command);
    await f.make().process(work, heartbeatProcessor(f.runtime, model));
    assert.deepEqual(await f.service.retry(f.workspace.id, f.member.userId, command), { accepted: true });
    await f.service.poll(work);
    await f.service.poll(work);
    await f.make().process(work, heartbeatProcessor(f.runtime, model));
    const results = (await f.results()).results;
    assert.equal(results.length, 1);
    assert.equal(results[0].id, failed.id);
    assert.equal(results[0].instructions, failed.instructions);
    assert.equal(results[0].status, 'succeeded');
    assert.equal(calls, 2);
    assert.equal((await summary(f)).held, held);
    assert.equal((await summary(f)).used, 1);
  } finally {
    await f.close();
  }
});

test('model policy mutation waits for the same transaction that publishes the answer', async t => {
  const f = await heartbeatFixture();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => response());
  try {
    const work = await intake(f);
    const processor = heartbeatProcessor(f.runtime, model);
    let checks = 0;
    const processing = f.service.process(work, input =>
      processor({
        ...input,
        authorize: guard =>
          input.authorize(async tx => {
            await guard(tx);
            if (++checks === 3) {
              entered.resolve();
              await release.promise;
            }
          }),
      }),
    );
    await entered.promise;
    let policyCommitted = false;
    const policy = createModelPolicyService(f.runtime)
      .saveAvailability(f.workspace.id, f.admin.userId, {
        requestId: randomUUID(),
        familyId: 'claude-haiku',
        expectedRevision: 0,
        enabled: false,
      })
      .then(() => {
        policyCommitted = true;
      });
    for (let i = 0; ; i++) {
      const waiting = (
        await f.db.platform.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`,
        )
      ).rows[0].count;
      if (waiting > 0) break;
      assert.ok(i < 100, 'policy write must wait on the publication authorization lock');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(policyCommitted, false);
    release.resolve();
    await Promise.all([processing, policy]);
    assert.equal((await f.results()).results[0].answer, 'Recovered private answer');
    assert.equal(
      (await createModelPolicyService(f.runtime).availability(f.workspace.id, f.admin.userId)).items.find(
        item => item.familyId === 'claude-haiku',
      ).enabled,
      false,
    );
  } finally {
    release.resolve();
    await f.close();
  }
});
