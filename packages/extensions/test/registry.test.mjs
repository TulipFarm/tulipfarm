import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  appHost,
  captureAnalytics,
  configuredExecutionBackend,
  creditGate,
  creditPricing,
  creditUnitsForProviderCost,
  defineExtension,
  emitHook,
  executionBackend,
  extensionMigrations,
  flagProvider,
  flushExtensions,
  identifyAnalyticsGroup,
  identifyAnalyticsPerson,
  loadedExtensions,
  recordUsage,
  registerExtension,
  reportError,
  resetExtensions,
  shutdownExtensions,
  socialPlatformApps,
  unavailableAppHost,
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
  assert.equal(socialPlatformApps(), undefined);
  assert.equal(executionBackend(), undefined);
  assert.equal(appHost(), unavailableAppHost);
  const signal = new AbortController().signal;
  const unavailable = {
    name: 'AppHostUnavailableError',
    message: 'No app host is registered, so server apps cannot run',
  };
  await assert.rejects(
    appHost().provision({ appId: 'a', releaseId: 'r', size: { vcpu: 1, memMiB: 1024 } }, signal),
    unavailable,
  );
  await assert.rejects(appHost().switch({ appId: 'a', hostRef: 'h', drainS: 30 }, signal), unavailable);
  await assert.rejects(appHost().connect({ appId: 'a' }, signal), unavailable);
  await assert.rejects(appHost().remove({ appId: 'a', hostRef: 'h' }, signal), unavailable);
  await assert.rejects(Array.fromAsync(appHost().list(signal)), unavailable);
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

test('social platform apps are a single slot for the hosted edition (social PRODUCT 3, 4)', async () => {
  const resolver = {
    resolve: platform => (platform === 'x' ? { kind: 'workspace-app-required' } : { kind: 'unavailable' }),
  };
  await registerExtension(
    defineExtension({
      name: 'hosted',
      register(slots) {
        slots.socialPlatformApps(resolver);
      },
    }),
    context,
  );
  assert.equal(socialPlatformApps(), resolver);
  await assert.rejects(
    registerExtension(
      defineExtension({
        name: 'other',
        register(slots) {
          slots.socialPlatformApps(resolver);
        },
      }),
      context,
    ),
    /"other" cannot set the social platform apps: "hosted" already set it/,
  );
  resetExtensions();
  await assert.rejects(
    registerExtension(
      defineExtension({
        name: 'broken',
        register(slots) {
          slots.socialPlatformApps({});
        },
      }),
      context,
    ),
    /"broken" social platform apps need a resolve function/,
  );
  assert.equal(socialPlatformApps(), undefined);
});

function executionFixture() {
  const profiles = [
    { id: 'small', resources: { kind: 'limited', cpuMillis: 500, memoryMiB: 1024, diskBytes: 1048576 } },
  ];
  const backend = {
    descriptor: {
      profiles,
      capabilities: {
        isolation: 'container',
        network: 'public-only',
        hardDeadlines: true,
        reconnect: true,
        previews: false,
      },
    },
    ...Object.fromEntries(
      [
        'prepare',
        'inspect',
        'destroy',
        'startJob',
        'inspectJob',
        'stopJob',
        'readOutput',
        'listFiles',
        'readFile',
        'writeFile',
        'removeFile',
      ].map(method => [method, () => assert.fail(`Preflight must not call ${method}`)]),
    ),
  };
  return {
    backend,
    configuration: { mode: 'extension', policy: { profiles, network: 'public-only' }, policyRevision: 'a'.repeat(64) },
  };
}

test('execution remains off after registration and never falls back to another backend', async () => {
  const { backend, configuration } = executionFixture();
  assert.throws(() => configuredExecutionBackend(configuration), /backend is unavailable/);
  await registerExtension({ name: 'execution', register: slots => slots.executionBackend(backend) }, context);
  assert.equal(configuredExecutionBackend({ mode: 'off' }), undefined);
  assert.equal(configuredExecutionBackend(configuration), backend);
  for (const mode of ['local', 'docker'])
    assert.throws(() => configuredExecutionBackend({ ...configuration, mode }), /backend is unavailable/);
  assert.equal(configuredExecutionBackend({ ...configuration, mode: 'docker' }, { docker: backend }), backend);
});

test('execution registration is single-owner and failed registrations roll back all slots', async () => {
  const { backend } = executionFixture();
  await assert.rejects(
    registerExtension(
      {
        name: 'broken',
        register(slots) {
          slots.executionBackend(backend);
          throw new Error('registration failed');
        },
      },
      context,
    ),
    /registration failed/,
  );
  assert.equal(executionBackend(), undefined);
  await assert.rejects(
    registerExtension(
      {
        name: 'invalid',
        register: slots => slots.executionBackend({ ...backend, startJob: undefined }),
      },
      context,
    ),
    /invalid execution backend/,
  );
  assert.equal(executionBackend(), undefined);
  await registerExtension({ name: 'execution', register: slots => slots.executionBackend(backend) }, context);
  await assert.rejects(
    registerExtension(
      {
        name: 'other',
        register(slots) {
          slots.flagProvider({ isEnabled: async () => true });
          slots.executionBackend(backend);
        },
      },
      context,
    ),
    /"execution" already set it/,
  );
  assert.equal(flagProvider(), undefined);
  assert.equal(executionBackend(), backend);
  assert.deepEqual(loadedExtensions(), ['execution']);
});

test('execution rejects unsupported isolation, network, deadlines and reconnection', () => {
  const { backend, configuration } = executionFixture();
  for (const change of [
    { isolation: 'direct' },
    { network: 'inherited' },
    { hardDeadlines: false },
    { reconnect: false },
  ]) {
    const candidate = {
      ...backend,
      descriptor: { ...backend.descriptor, capabilities: { ...backend.descriptor.capabilities, ...change } },
    };
    assert.throws(
      () => configuredExecutionBackend({ ...configuration, mode: 'docker' }, { docker: candidate }),
      /cannot enforce/,
    );
  }
  const direct = {
    ...backend,
    descriptor: {
      profiles: [{ id: 'shared', resources: { kind: 'shared' } }],
      capabilities: { ...backend.descriptor.capabilities, isolation: 'direct', network: 'inherited' },
    },
  };
  const local = {
    ...configuration,
    mode: 'local',
    policy: { profiles: direct.descriptor.profiles, network: 'inherited' },
  };
  assert.equal(configuredExecutionBackend(local, { local: direct }), direct);
  assert.throws(() => configuredExecutionBackend(local, { local: backend }), /cannot enforce/);
});

test('execution profiles require exact resource matches without rounding up', () => {
  const { backend, configuration } = executionFixture();
  const requested = configuration.policy.profiles[0];
  for (const profile of [
    { ...requested, id: 'other' },
    { ...requested, resources: { kind: 'shared' } },
    ...['cpuMillis', 'memoryMiB', 'diskBytes'].map(field => ({
      ...requested,
      resources: { ...requested.resources, [field]: requested.resources[field] + 1 },
    })),
  ]) {
    const candidate = { ...backend, descriptor: { ...backend.descriptor, profiles: [profile] } };
    assert.throws(
      () => configuredExecutionBackend({ ...configuration, mode: 'docker' }, { docker: candidate }),
      /does not support the requested profiles/,
    );
  }
});

test('execution shutdown closes its client once without destroying allocations', async () => {
  const { backend } = executionFixture();
  let closed = 0;
  backend.shutdown = async () => {
    closed++;
  };
  await registerExtension({ name: 'execution', register: slots => slots.executionBackend(backend) }, context);
  await flushExtensions();
  assert.equal(closed, 0);
  await Promise.all([shutdownExtensions(), shutdownExtensions()]);
  assert.equal(closed, 1);
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
    'workspace.created': { workspaceId: 'w', workspaceName: 'W', userId: 'u' },
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

test('group and person profiles reach analytics that support them, and a failure never reaches the caller', async () => {
  const seen = [];
  await registerExtension(
    defineExtension({
      name: 'profiles',
      register(slots) {
        slots.analytics({ capture: () => undefined });
        slots.analytics({
          capture: () => undefined,
          group: group => seen.push(['group', group]),
          person: person => {
            seen.push(['person', person]);
            throw new Error('person down');
          },
        });
      },
    }),
    context,
  );
  const group = { type: 'workspace', key: 'w1', properties: { slug: 'acme' } };
  const person = { distinctId: 'u1', properties: { email_domain: 'example.com' } };
  identifyAnalyticsGroup(group);
  identifyAnalyticsPerson(person);
  assert.deepEqual(seen, [
    ['group', group],
    ['person', person],
  ]);
});
