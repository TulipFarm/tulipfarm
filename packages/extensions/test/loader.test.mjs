import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, test } from 'node:test';
import {
  creditGate,
  emitHook,
  extensionMigrations,
  flagProvider,
  loadedExtensions,
  resetExtensions,
  unlimitedCredits,
} from '../src/index.ts';
import {
  ExtensionLoadError,
  loadConfiguredExtensions,
  loadExtensions,
  parseExtensionSpecifiers,
} from '../src/loader.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = name => new URL(`./fixtures/${name}.mjs`, import.meta.url).href;

beforeEach(() => resetExtensions());

test('parses comma-separated specifiers; unset means none', () => {
  assert.deepEqual(parseExtensionSpecifiers(undefined), []);
  assert.deepEqual(parseExtensionSpecifiers(' , '), []);
  assert.deepEqual(parseExtensionSpecifiers(' @acme/one, ./two.mjs ,'), ['@acme/one', './two.mjs']);
  assert.throws(() => parseExtensionSpecifiers('a,a'), /extension "a" is listed twice/);
});

test('zero configured extensions registers nothing', async () => {
  assert.deepEqual(await loadConfiguredExtensions('worker', { env: {} }), []);
  assert.deepEqual(loadedExtensions(), []);
  assert.equal(creditGate(), unlimitedCredits);
});

test('loads a fixture extension from TULIPFARM_EXTENSIONS by relative path, file URL, and bare specifier', async () => {
  const names = await loadConfiguredExtensions('worker', {
    env: { TULIPFARM_EXTENSIONS: './recording-extension.mjs' },
    cwd: fixtures,
  });
  assert.deepEqual(names, ['fixture-recording']);
  const { received } = await import(fixture('recording-extension'));
  assert.deepEqual(received.contexts, ['worker']);
  const tx = { schema: 's', client: { query: async () => ({ rows: [], rowCount: 0 }) } };
  assert.equal(await creditGate().available(tx), 0n);
  await assert.rejects(creditGate().debit(tx, 1n, { id: 'r', activity: 'chat' }), /credits-exhausted/);
  assert.equal(await flagProvider()?.isEnabled('on', { user: { id: 'u' } }), true);
  await emitHook('user.signed-up', { userId: 'u', email: 'a@example.com', name: 'A' });
  assert.deepEqual(received.hooks, [{ userId: 'u', email: 'a@example.com', name: 'A' }]);
  assert.equal(extensionMigrations()[0]?.schema, 'fixture');

  resetExtensions();
  assert.deepEqual(await loadExtensions([fixture('recording-extension')], { app: 'api', env: {} }), [
    'fixture-recording',
  ]);
  resetExtensions();
  const resolved = [];
  assert.deepEqual(
    await loadExtensions(
      ['@acme/recording'],
      { app: 'api', env: {} },
      {
        resolve: specifier => {
          resolved.push(specifier);
          return fixture('recording-extension');
        },
      },
    ),
    ['fixture-recording'],
  );
  assert.deepEqual(resolved, ['@acme/recording']);
});

test('bad modules fail with a clear error naming the specifier', async () => {
  const load = name => loadExtensions([`./${name}.mjs`], { app: 'api', env: {} }, { cwd: fixtures });
  await assert.rejects(
    load('missing'),
    error =>
      error instanceof ExtensionLoadError &&
      error.specifier === './missing.mjs' &&
      error.message.startsWith('TULIPFARM_EXTENSIONS: extension "./missing.mjs" could not be imported: '),
  );
  await assert.rejects(
    load('throws-on-import'),
    /extension "\.\/throws-on-import\.mjs" could not be imported: boom at import/,
  );
  await assert.rejects(
    load('not-an-extension'),
    /extension "\.\/not-an-extension\.mjs" must default-export \{ name, register\(\) \}/,
  );
  await assert.rejects(
    load('register-fails'),
    /extension "\.\/register-fails\.mjs" failed to register: missing POSTHOG_KEY/,
  );
  await assert.rejects(
    loadExtensions(['@tulipfarm/no-such-extension'], { app: 'api', env: {} }),
    /extension "@tulipfarm\/no-such-extension" could not be imported/,
  );
  assert.deepEqual(loadedExtensions(), []);
  await loadExtensions(['./recording-extension.mjs'], { app: 'api', env: {} }, { cwd: fixtures });
  await assert.rejects(
    loadExtensions(['./second-gate.mjs'], { app: 'api', env: {} }, { cwd: fixtures }),
    /extension "\.\/second-gate\.mjs" failed to register: Extension "fixture-second-gate" cannot set the credit gate: "fixture-recording" already set it/,
  );
});

test('startExtensions exits 1 with one JSON error line on a bad module, and is silent with none', () => {
  const run = value =>
    spawnSync(process.execPath, [fileURLToPath(fixture('start'))], {
      cwd: fixtures,
      encoding: 'utf8',
      env: { ...process.env, TULIPFARM_EXTENSIONS: value },
    });
  const none = run('');
  assert.equal(none.status, 0);
  assert.equal(none.stdout, 'loaded=[]\n');
  assert.equal(none.stderr, '');
  const good = run('./recording-extension.mjs');
  assert.equal(good.status, 0);
  assert.deepEqual(
    good.stdout
      .split('\n')
      .filter(Boolean)
      .map(line => (line.startsWith('{') ? JSON.parse(line) : line)),
    [
      { level: 'info', event: 'extensions_loaded', app: 'api', extensions: ['fixture-recording'] },
      'loaded=["fixture-recording"]',
    ],
  );
  const bad = run('./not-an-extension.mjs');
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.deepEqual(JSON.parse(bad.stderr), {
    level: 'error',
    event: 'extensions_load_failed',
    app: 'api',
    message:
      'TULIPFARM_EXTENSIONS: extension "./not-an-extension.mjs" must default-export { name, register() } (use defineExtension)',
  });
});
