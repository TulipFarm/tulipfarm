import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  appBuilder,
  appHost,
  AppHostConflictError,
  appPublisher,
  registerExtension,
  resetExtensions,
  unavailableAppHost,
} from '../src/index.ts';
import { appPublisherContract, memoryAppPublisher, testAppPublisher } from '../src/testing.ts';

const context = { app: 'worker', env: {} };
const builder = {
  id: 'sandbox-node22-v1',
  build: async () => ({ ok: false, code: 'build-failed', log: 'npm ERR! missing script: build', units: 7n }),
};

beforeEach(() => resetExtensions());

test('app builder and publisher read as undefined until an extension registers them', async () => {
  assert.equal(appBuilder(), undefined);
  assert.equal(appPublisher(), undefined);
  const publisher = memoryAppPublisher();
  await registerExtension(
    {
      name: 'hosted',
      register(slots) {
        slots.appBuilder(builder);
        slots.appPublisher(publisher);
      },
    },
    context,
  );
  assert.equal(appBuilder().id, 'sandbox-node22-v1');
  assert.deepEqual(await appBuilder().build({}, new AbortController().signal), {
    ok: false,
    code: 'build-failed',
    log: 'npm ERR! missing script: build',
    units: 7n,
  });
  assert.equal(appPublisher(), publisher);
});

test('a second app builder or publisher fails startup and leaves the first in place', async () => {
  const publisher = memoryAppPublisher();
  await registerExtension(
    {
      name: 'hosted',
      register(slots) {
        slots.appBuilder(builder);
        slots.appPublisher(publisher);
      },
    },
    context,
  );
  await assert.rejects(
    registerExtension({ name: 'other', register: slots => slots.appBuilder({ ...builder, id: 'other' }) }, context),
    {
      name: 'ExtensionRegistrationError',
      message: 'Extension "other" cannot set the app builder: "hosted" already set it',
    },
  );
  await assert.rejects(
    registerExtension({ name: 'other', register: slots => slots.appPublisher(memoryAppPublisher()) }, context),
    {
      name: 'ExtensionRegistrationError',
      message: 'Extension "other" cannot set the app publisher: "hosted" already set it',
    },
  );
  assert.equal(appBuilder().id, 'sandbox-node22-v1');
  assert.equal(appPublisher(), publisher);
});

test('app slots refuse incomplete implementations', async () => {
  const { usage: _usage, ...noUsage } = memoryAppPublisher();
  await assert.rejects(
    registerExtension({ name: 'partial', register: slots => slots.appPublisher(noUsage) }, context),
    {
      message:
        'Extension "partial" app publisher needs stage, apply, remove, discard, list, releases and usage functions',
    },
  );
  await assert.rejects(
    registerExtension({ name: 'anonymous', register: slots => slots.appBuilder({ ...builder, id: '' }) }, context),
    { message: 'Extension "anonymous" app builder needs an id and a build function' },
  );
  assert.equal(appBuilder(), undefined);
  assert.equal(appPublisher(), undefined);
});

const generations = new Map();
const host = {
  provision: async ({ appId, releaseId, size, output }) => ({
    hostRef: `${appId}/${releaseId}/${size.vcpu}x${size.memMiB}/${output.artifact}:${output.port}`,
  }),
  switch: async ({ appId, expectedGeneration }) => {
    const current = generations.get(appId) ?? 0;
    if (expectedGeneration !== undefined && expectedGeneration !== current)
      throw new AppHostConflictError(appId, expectedGeneration);
    generations.set(appId, current + 1);
    return { generation: current + 1 };
  },
  connect: async ({ appId }) => ({
    url: `https://forward.example.test/${appId}`,
    headers: { authorization: 'Bearer t' },
  }),
  remove: async () => undefined,
  async *list() {
    yield { appId: 'orders', hostRef: 'orders/r1/1x1024' };
  },
};

test('a registered app host replaces the unavailable default', async () => {
  generations.clear();
  await registerExtension({ name: 'hosted', register: slots => slots.appHost(host) }, context);
  const signal = new AbortController().signal;
  assert.equal(appHost(), host);
  const output = { kind: 'server', artifact: 'sha256:ab12', port: 3000, start: 'node server.js' };
  assert.deepEqual(
    await appHost().provision({ appId: 'orders', releaseId: 'r1', size: { vcpu: 1, memMiB: 1024 }, output }, signal),
    { hostRef: 'orders/r1/1x1024/sha256:ab12:3000' },
  );
  assert.deepEqual(await appHost().switch({ appId: 'orders', hostRef: 'h1', drainS: 30 }, signal), { generation: 1 });
  assert.deepEqual(
    await appHost().switch({ appId: 'orders', hostRef: 'h2', drainS: 30, expectedGeneration: 1 }, signal),
    { generation: 2 },
  );
  const stale = await appHost()
    .switch({ appId: 'orders', hostRef: 'h3', drainS: 30, expectedGeneration: 1 }, signal)
    .catch(error => error);
  assert.ok(stale instanceof AppHostConflictError);
  assert.deepEqual(
    { name: stale.name, message: stale.message, appId: stale.appId, expectedGeneration: stale.expectedGeneration },
    {
      name: 'AppHostConflictError',
      message: 'The endpoint of app "orders" is no longer at generation 1',
      appId: 'orders',
      expectedGeneration: 1,
    },
  );
  assert.deepEqual(await appHost().connect({ appId: 'orders' }, signal), {
    url: 'https://forward.example.test/orders',
    headers: { authorization: 'Bearer t' },
  });
  assert.deepEqual(await Array.fromAsync(appHost().list(signal)), [{ appId: 'orders', hostRef: 'orders/r1/1x1024' }]);
});

test('a second or incomplete app host fails startup and leaves the registry as it was', async () => {
  const { switch: _switch, ...noSwitch } = host;
  await assert.rejects(registerExtension({ name: 'partial', register: slots => slots.appHost(noSwitch) }, context), {
    name: 'ExtensionRegistrationError',
    message: 'Extension "partial" app host needs provision, switch, connect, remove and list functions',
  });
  assert.equal(appHost(), unavailableAppHost);
  await registerExtension({ name: 'hosted', register: slots => slots.appHost(host) }, context);
  await assert.rejects(registerExtension({ name: 'other', register: slots => slots.appHost({ ...host }) }, context), {
    name: 'ExtensionRegistrationError',
    message: 'Extension "other" cannot set the app host: "hosted" already set it',
  });
  assert.equal(appHost(), host);
});

let names = 0;
testAppPublisher('memory publisher', () => ({ publisher: memoryAppPublisher(), name: async () => `app-${++names}` }));

const failures = async publisher => {
  const failed = [];
  for (const contractCase of appPublisherContract) {
    try {
      await contractCase.run({ publisher, name: async () => `app-${++names}` });
    } catch (error) {
      if (error.name !== 'AssertionError') throw error;
      failed.push(contractCase.name);
    }
  }
  return failed;
};

// Routes kept outside the memory publisher, so discard must consult them too.
const routedBy = (publisher, routes) => {
  const discard = publisher.discard;
  publisher.discard = async (input, signal) => {
    if (![...routes.values()].some(route => route.releaseId === input.releaseId)) await discard(input, signal);
  };
};

test('the publisher contract catches broken route versions, removes, copies and discards', async () => {
  const lastWriteWins = memoryAppPublisher();
  const routes = new Map();
  Object.assign(lastWriteWins, {
    apply: async route => (routes.set(route.name, route), { stored: route }),
    remove: async ({ name, version }) => {
      if ((routes.get(name)?.version ?? -1) < version) routes.delete(name);
    },
    list: async function* () {
      yield* routes.values();
    },
  });
  routedBy(lastWriteWins, routes);
  assert.deepEqual(await failures(lastWriteWins), [
    'apply only moves a route forward',
    'remove takes a route away only for a newer version',
  ]);

  const forgetful = memoryAppPublisher();
  const forgetfulRoutes = new Map();
  Object.assign(forgetful, {
    apply: async route => {
      if ((forgetfulRoutes.get(route.name)?.version ?? -1) < route.version) forgetfulRoutes.set(route.name, route);
      return { stored: forgetfulRoutes.get(route.name) ?? null };
    },
    remove: async ({ name, version }) => {
      if ((forgetfulRoutes.get(name)?.version ?? -1) < version) forgetfulRoutes.delete(name);
    },
    list: async function* () {
      yield* forgetfulRoutes.values();
    },
  });
  routedBy(forgetful, forgetfulRoutes);
  assert.deepEqual(await failures(forgetful), ['remove takes a route away only for a newer version']);

  const unchecked = memoryAppPublisher();
  const remove = unchecked.remove;
  unchecked.remove = ({ name }, signal) => remove({ name, version: Number.MAX_SAFE_INTEGER }, signal);
  assert.deepEqual(await failures(unchecked), ['remove takes a route away only for a newer version']);

  const recopies = memoryAppPublisher();
  const stage = recopies.stage;
  recopies.stage = async (input, signal) => {
    await recopies.discard({ releaseId: input.releaseId }, signal);
    await stage(input, signal);
  };
  assert.deepEqual(await failures(recopies), ['stage copies each file once and discard drops the release']);

  const reckless = memoryAppPublisher();
  reckless.discard = async ({ releaseId }) => {
    for (const key of reckless.objects.keys())
      if (key.startsWith(`releases/${releaseId}/`)) reckless.objects.delete(key);
  };
  assert.deepEqual(await failures(reckless), ['discard keeps a release that a route points at']);
});
