import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  captureAnalytics,
  creditGate,
  creditPricing,
  creditUnitsForProviderCost,
  defineExtension,
  emitHook,
  extensionMigrations,
  flagProvider,
  flushExtensions,
  loadedExtensions,
  recordUsage,
  registerExtension,
  reportError,
  resetExtensions,
  shutdownExtensions,
  unlimitedCredits,
  providerCostPricing,
} from '../src/index.ts';

const context = { app: 'api', env: {} };
const tx = {
  schema: 'workspace',
  client: {
    query: async () => {
      throw new Error('the default gate must not query');
    },
  },
};
const usage = {
  workspaceId: 'w',
  flowId: 'f',
  modelId: 'm',
  agentId: null,
  activity: 'chat',
  inputTokens: 1,
  outputTokens: 2,
  at: new Date(0),
};

beforeEach(() => resetExtensions());

test('every slot is a no-op by default', async () => {
  assert.deepEqual(loadedExtensions(), []);
  assert.equal(creditGate(), unlimitedCredits);
  assert.equal(await creditGate().available(tx, { lock: true }), null);
  await creditGate().debit(tx, 1n, { id: 'r', activity: 'chat' });
  await creditGate().debit(tx, -1n, { id: 'r', activity: 'chat' });
  assert.equal(flagProvider(), undefined);
  assert.deepEqual(extensionMigrations(), []);
  captureAnalytics({ event: 'e', distinctId: 'd' });
  reportError(new Error('x'));
  await recordUsage(usage);
  await emitHook('user.signed-up', { userId: 'u', email: 'a@example.com', name: 'A' });
  await flushExtensions();
  await shutdownExtensions();
});

test('registered slots receive calls, and failures stay inside the extension', async () => {
  const seen = [];
  const reporter = {
    captureException: (error, distinctId) => seen.push(['error', error.message, distinctId]),
    shutdown: async () => {
      seen.push(['shutdown']);
    },
  };
  await registerExtension(
    defineExtension({
      name: 'one',
      register(slots, ctx) {
        seen.push(['context', ctx.app]);
        slots.errorReporter(reporter);
        slots.analytics({
          capture: event => seen.push(['event', event.event]),
          flush: async () => {
            seen.push(['flush']);
          },
        });
        slots.analytics({
          capture: () => {
            throw new Error('analytics down');
          },
        });
        slots.usageSink({
          record: async item => {
            seen.push(['usage', item.flowId]);
          },
        });
        slots.usageSink({
          record: async () => {
            throw new Error('sink down');
          },
        });
        slots.hooks({
          'user.signed-up': payload => {
            seen.push(['hook', payload.userId]);
          },
        });
        slots.hooks({
          'user.signed-up': () => {
            throw new Error('hook down');
          },
          'task.completed': () => {
            seen.push(['wrong hook']);
          },
        });
      },
    }),
    context,
  );
  captureAnalytics({ event: 'signup', distinctId: 'u' });
  reportError(new Error('boom'), 'u');
  await recordUsage(usage);
  await emitHook('user.signed-up', { userId: 'u', email: 'a@example.com', name: 'A' });
  await flushExtensions();
  await shutdownExtensions();
  await shutdownExtensions();
  assert.deepEqual(seen, [
    ['context', 'api'],
    ['event', 'signup'],
    ['error', 'boom', 'u'],
    ['usage', 'f'],
    ['error', 'sink down', undefined],
    ['hook', 'u'],
    ['error', 'hook down', undefined],
    ['flush'],
    ['shutdown'],
  ]);
  assert.deepEqual(loadedExtensions(), ['one']);
});

test('credit gate and flag provider are single slots', async () => {
  const gate = { ...unlimitedCredits, available: async () => 0n };
  const provider = { isEnabled: async () => true };
  await registerExtension(
    {
      name: 'billing',
      register(slots) {
        slots.creditGate(gate);
        slots.flagProvider(provider);
      },
    },
    context,
  );
  assert.equal(creditGate(), gate);
  assert.equal(flagProvider(), provider);
  await assert.rejects(
    registerExtension(
      {
        name: 'other',
        register(slots) {
          slots.creditGate(unlimitedCredits);
        },
      },
      context,
    ),
    /Extension "other" cannot set the credit gate: "billing" already set it/,
  );
  await assert.rejects(
    registerExtension(
      {
        name: 'twice',
        register(slots) {
          slots.flagProvider(provider);
          slots.flagProvider(provider);
        },
      },
      context,
    ),
    /"twice" cannot set the flag provider: "billing" already set it/,
  );
  assert.deepEqual(loadedExtensions(), ['billing']);
  resetExtensions();
  await assert.rejects(
    registerExtension(
      {
        name: 'twice',
        register(slots) {
          slots.flagProvider(provider);
          slots.flagProvider(provider);
        },
      },
      context,
    ),
    /"twice" cannot set the flag provider: "twice" already set it/,
  );
});

test('credit pricing defaults to provider cost and is a single slot', async () => {
  assert.equal(creditPricing(), providerCostPricing);
  assert.equal(creditUnitsForProviderCost(0n), 0n);
  // $0.01 of provider cost is one credit (10^12 units); fractions are kept.
  assert.equal(creditUnitsForProviderCost(10_000_000_000n), 1_000_000_000_000n);
  assert.equal(creditUnitsForProviderCost(3_333_333_333n), 333_333_333_300n);
  const credit = 1_000_000_000_000n;
  const hosted = { unitsPerPicoUsd: 150n, round: units => ((units + credit - 1n) / credit) * credit };
  await registerExtension(
    {
      name: 'pricing',
      register(slots) {
        slots.creditPricing(hosted);
      },
    },
    context,
  );
  assert.equal(creditPricing(), hosted);
  assert.equal(creditUnitsForProviderCost(3_333_333_333n), credit);
  assert.equal(creditUnitsForProviderCost(683_333_333_333n), 103n * credit);
  await assert.rejects(
    registerExtension(
      {
        name: 'other',
        register(slots) {
          slots.creditPricing(providerCostPricing);
        },
      },
      context,
    ),
    /"other" cannot set the credit pricing: "pricing" already set it/,
  );
  resetExtensions();
  for (const bad of [
    { unitsPerPicoUsd: 0n, round: x => x },
    { unitsPerPicoUsd: 100, round: x => x },
    { unitsPerPicoUsd: 1n },
  ])
    await assert.rejects(
      registerExtension(
        {
          name: 'bad',
          register(slots) {
            slots.creditPricing(bad);
          },
        },
        context,
      ),
      /positive bigint unitsPerPicoUsd/,
    );
  assert.equal(creditPricing(), providerCostPricing);
});

test('a failing register() leaves the registry unchanged', async () => {
  await assert.rejects(
    registerExtension(
      {
        name: 'broken',
        register(slots) {
          slots.creditGate({ ...unlimitedCredits });
          slots.analytics({ capture: () => assert.fail('must not be registered') });
          throw new Error('missing key');
        },
      },
      context,
    ),
    /missing key/,
  );
  assert.deepEqual(loadedExtensions(), []);
  assert.equal(creditGate(), unlimitedCredits);
  captureAnalytics({ event: 'e', distinctId: 'd' });
});

test('names must be unique and well formed, and slots close when register() returns', async () => {
  let late;
  await registerExtension(
    {
      name: 'a',
      register(slots) {
        late = slots;
      },
    },
    context,
  );
  assert.throws(() => late.analytics({ capture: () => undefined }), /registered a slot after register\(\) returned/);
  await assert.rejects(registerExtension({ name: 'a', register() {} }, context), /already registered/);
  await assert.rejects(registerExtension({ name: 'Bad Name', register() {} }, context), /must be lowercase/);
});

test('extension migrations are validated and kept in load order', async () => {
  const sql = 'SELECT 1;';
  await registerExtension(
    {
      name: 'private',
      register(slots) {
        slots.migrations({
          schema: 'private',
          migrations: [
            { name: '0001_ledger.sql', sql },
            { name: '0002_more.sql', sql },
          ],
        });
      },
    },
    context,
  );
  assert.deepEqual(extensionMigrations(), [
    {
      extension: 'private',
      schema: 'private',
      migrations: [
        { name: '0001_ledger.sql', sql },
        { name: '0002_more.sql', sql },
      ],
    },
  ]);
  const attempt = (schema, migrations) =>
    registerExtension(
      {
        name: `x${Math.random().toString(36).slice(2, 8)}`,
        register(slots) {
          slots.migrations({ schema, migrations });
        },
      },
      context,
    );
  await assert.rejects(attempt('private', []), /schema "private" is already registered/);
  for (const schema of ['public', 'app', 'database_management', 'pg_x', 'Bad'])
    await assert.rejects(attempt(schema, []), /reserved or not a lowercase identifier/);
  await assert.rejects(attempt('other', [{ name: 'ledger.sql', sql }]), /must match NNNN_name.sql/);
  await assert.rejects(
    attempt('other', [
      { name: '0002_a.sql', sql },
      { name: '0001_b.sql', sql },
    ]),
    /out of order/,
  );
  await assert.rejects(
    attempt('other', [
      { name: '0001_a.sql', sql },
      { name: '0001_b.sql', sql },
    ]),
    /reuses a number/,
  );
  await assert.rejects(attempt('other', [{ name: '0001_a.sql', sql: ' ' }]), /is empty/);
});

test('every lifecycle hook reaches its subscriber, and a failing subscriber is logged without rejecting', async t => {
  const seen = [];
  const logged = [];
  t.mock.method(process.stderr, 'write', line => {
    logged.push(JSON.parse(line));
    return true;
  });
  const events = {
    'user.signed-up': { userId: 'u', email: 'a@example.com', name: 'A' },
    'workspace.created': { workspaceId: 'w', userId: 'u' },
    'member.invited': { workspaceId: 'w', invitationId: 'i', invitedByUserId: 'u', replacesInvitationId: null },
    'task.completed': { workspaceId: 'w', taskId: 't', outcome: 'completed' },
    'usage.recorded': {
      workspaceId: 'w',
      usageId: 'a',
      flowId: 'f',
      modelId: 'm',
      activity: 'chat',
      providerPicoUsd: '1',
    },
  };
  await registerExtension(
    defineExtension({
      name: 'recorder',
      register(slots) {
        slots.hooks(
          Object.fromEntries(
            Object.keys(events).map(event => [
              event,
              payload => {
                seen.push([event, payload]);
              },
            ]),
          ),
        );
        slots.hooks({
          'task.completed': async () => {
            throw new Error('subscriber down');
          },
        });
      },
    }),
    context,
  );
  for (const [event, payload] of Object.entries(events)) await emitHook(event, payload);
  assert.deepEqual(seen, Object.entries(events));
  assert.deepEqual(logged, [
    { level: 'error', event: 'extension_hook_failed', hook: 'task.completed', extension: 'recorder' },
  ]);
});
