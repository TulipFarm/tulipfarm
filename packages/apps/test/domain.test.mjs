import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unavailableAppHost } from '@tulipfarm/extensions';
import {
  appBuildId,
  appBuilders,
  appNameSchema,
  appSlugSchema,
  commitSchema,
  edgeStatus,
  readAppRecipe,
  recipeBuilder,
} from '../src/index.ts';

const commit = commitSchema.parse('a'.repeat(40));

test('app names are DNS labels that are not reserved and never read as punycode', () => {
  assert.equal(appNameSchema.parse('acme-orders'), 'acme-orders');
  assert.equal(appNameSchema.parse('a1b'), 'a1b');
  // eslint-disable-next-line tulipfarm/product-copy -- Reserved hostnames, not user-facing copy.
  for (const name of ['www', 'api', 'preview', 'tulipfarm', 'staging', 'packs']) {
    const result = appNameSchema.safeParse(name);
    assert.equal(result.success, false, name);
    assert.equal(result.error.issues[0].message, 'Reserved app name');
  }
  assert.equal(appNameSchema.safeParse('xn--acme').error?.issues[0].message, 'App names cannot contain --');
  for (const name of ['ab', 'Acme', '-acme', 'acme-', 'acme_orders', 'a'.repeat(64)])
    assert.equal(appNameSchema.safeParse(name).success, false, name);
  assert.equal(appNameSchema.parse('a'.repeat(63)), 'a'.repeat(63));
});

test('app slugs are short path segments other than the new-app route', () => {
  assert.equal(appSlugSchema.parse('orders'), 'orders');
  assert.equal(appSlugSchema.parse('x'), 'x');
  assert.equal(appSlugSchema.safeParse('new').error?.issues[0].message, 'Reserved app slug');
  for (const slug of ['', 'Orders', 'orders/', '-orders', 'a'.repeat(49)])
    assert.equal(appSlugSchema.safeParse(slug).success, false, slug);
  assert.equal(appSlugSchema.parse('a'.repeat(48)), 'a'.repeat(48));
});

test('a tree without app.json is copied from its root', () => {
  assert.deepEqual(readAppRecipe(null), { ok: true, recipe: { kind: 'copy', root: '.' } });
  assert.deepEqual(readAppRecipe('{"kind":"copy"}'), { ok: true, recipe: { kind: 'copy', root: '.' } });
  assert.deepEqual(readAppRecipe('{"kind":"copy","root":"public"}'), {
    ok: true,
    recipe: { kind: 'copy', root: 'public' },
  });
});

test('a command recipe names its runtime, command and output directory', () => {
  assert.deepEqual(
    readAppRecipe('{"kind":"command","runtime":"node22","install":"npm ci","command":"npm run build","output":"dist"}'),
    {
      ok: true,
      recipe: { kind: 'command', runtime: 'node22', install: 'npm ci', command: 'npm run build', output: 'dist' },
    },
  );
});

test('a server recipe names its runtime, optional build steps, and the port and command it serves on', () => {
  assert.deepEqual(
    readAppRecipe(
      '{"kind":"server","runtime":"node22","install":"npm ci","command":"npm run build","serve":{"port":3000,"start":"node server.js"}}',
    ),
    {
      ok: true,
      recipe: {
        kind: 'server',
        runtime: 'node22',
        install: 'npm ci',
        command: 'npm run build',
        serve: { port: 3000, start: 'node server.js' },
      },
    },
  );
  assert.deepEqual(readAppRecipe('{"kind":"server","runtime":"node22","serve":{"port":1024,"start":"npm start"}}'), {
    ok: true,
    recipe: { kind: 'server', runtime: 'node22', serve: { port: 1024, start: 'npm start' } },
  });
  assert.deepEqual(
    readAppRecipe('{"kind":"server","runtime":"node22","serve":{"port":65535,"start":"npm start"}}').recipe.serve,
    { port: 65535, start: 'npm start' },
  );
});

test('a server recipe needs a port from 1024 to 65535 and a start command', () => {
  const server = serve => readAppRecipe(JSON.stringify({ kind: 'server', runtime: 'node22', serve }));
  const failure = message => ({ ok: false, failure: { code: 'recipe-invalid', message, retryable: false } });
  const badPort = failure('app.json serve.port: Use a whole number port from 1024 to 65535');
  const badStart = failure('app.json serve.start: Name the command that starts the server');
  for (const port of [1023, 65536, 0, -1, 3000.5, '3000', null])
    assert.deepEqual(server({ port, start: 'npm start' }), badPort, String(port));
  assert.deepEqual(server({ start: 'npm start' }), badPort);
  for (const start of ['', '   ', 42]) assert.deepEqual(server({ port: 3000, start }), badStart, JSON.stringify(start));
  assert.deepEqual(server({ port: 3000 }), badStart);
  assert.deepEqual(
    readAppRecipe('{"kind":"server","runtime":"node22"}'),
    failure('app.json serve: Invalid input: expected object, received undefined'),
  );
  assert.deepEqual(
    server({ port: 3000, start: 'npm start', env: { TOKEN: 'x' } }),
    failure('app.json serve: Unrecognized key: "env"'),
  );
  assert.deepEqual(
    readAppRecipe('{"kind":"server","runtime":"node22","output":"dist","serve":{"port":3000,"start":"npm start"}}'),
    failure('app.json Unrecognized key: "output"'),
  );
});

test('copy recipes build anywhere, commands need a builder, and servers need a host and a server builder', () => {
  const server = { kind: 'server', runtime: 'node22', serve: { port: 3000, start: 'npm start' } };
  const command = { kind: 'command', runtime: 'node22', command: 'npm run build', output: 'dist' };
  const hostUnavailable = {
    ok: false,
    failure: {
      code: 'host-unavailable',
      message: 'This server cannot run apps that start their own server',
      retryable: false,
    },
  };
  const none = appBuilders(undefined, unavailableAppHost);
  const host = { ...unavailableAppHost };
  const staticOnly = { id: 'sandbox-node22-v1', build: async () => ({}) };
  const serverCapable = { ...staticOnly, buildServer: async () => ({}) };
  assert.deepEqual(none, { command: undefined, server: undefined });
  assert.deepEqual(recipeBuilder({ kind: 'copy', root: '.' }, none), { ok: true, builder: 'copy' });
  assert.deepEqual(recipeBuilder(command, appBuilders(staticOnly, unavailableAppHost)), {
    ok: true,
    builder: 'sandbox-node22-v1',
  });
  assert.deepEqual(recipeBuilder(command, none), {
    ok: false,
    failure: { code: 'builder-unavailable', message: 'This server cannot run build commands', retryable: false },
  });
  assert.deepEqual(recipeBuilder(server, none), hostUnavailable);
  assert.deepEqual(recipeBuilder(server, appBuilders(serverCapable, unavailableAppHost)), hostUnavailable);
  assert.deepEqual(recipeBuilder(server, appBuilders(staticOnly, host)), hostUnavailable);
  assert.deepEqual(recipeBuilder(server, appBuilders(serverCapable, host)), {
    ok: true,
    builder: 'sandbox-node22-v1',
  });
});

test('an invalid app.json is a recipe failure that names the problem', () => {
  const failure = message => ({ ok: false, failure: { code: 'recipe-invalid', message, retryable: false } });
  assert.deepEqual(readAppRecipe('{'), failure('app.json is not valid JSON'));
  assert.deepEqual(
    readAppRecipe('{"kind":"command","runtime":"node22","command":"npm run build","output":"../site"}'),
    failure('app.json output: Path must stay inside the app'),
  );
  assert.deepEqual(
    readAppRecipe('{"kind":"copy","root":"/etc"}'),
    failure('app.json root: Use a relative path with / separators'),
  );
  assert.deepEqual(
    readAppRecipe('{"kind":"copy","root":"site/.git"}'),
    failure('app.json root: Path must stay inside the app'),
  );
  assert.deepEqual(
    readAppRecipe('{"kind":"copy","root":"site/.GIT"}'),
    failure('app.json root: Path must stay inside the app'),
  );
  assert.equal(readAppRecipe('{"kind":"command","runtime":"node18","command":"x","output":"dist"}').ok, false);
  assert.equal(readAppRecipe('{"kind":"copy","script":"rm -rf /"}').ok, false);
  assert.equal(readAppRecipe('{"kind":"shell"}').ok, false);
});

test('the build id is a digest of app, commit, canonical recipe and builder', async () => {
  const app = '0b5e3c2a-8d4f-4e1b-9c7a-6f2d1e0a3b4c';
  assert.equal(
    await appBuildId(app, commit, { kind: 'copy', root: '.' }, 'copy'),
    'c70f51b6853cbc6ccdfe95e5a5751605a6062d1a2ad98eaec50774c543c2d842',
  );
  const recipe = { output: 'dist', command: 'npm run build', runtime: 'node22', kind: 'command', install: undefined };
  assert.equal(
    await appBuildId(app, commit, recipe, 'builder-1'),
    '807ec77d76f21c5ea8442f0e5c7f1125bbd96ded7c297c63ab53e3c8b3e44659',
  );
  assert.equal(
    await appBuildId(app, commit, { kind: 'copy', root: '.' }, 'builder-1'),
    '336171f8a4f4386d04221d548dd3a5a348c95cef2103bdda60624d736d7cfcb9',
  );
  assert.equal(
    await appBuildId('5f0c2a8e-7b1d-4c3e-9a6f-2d8b4e1c7a90', commit, { kind: 'copy', root: '.' }, 'copy'),
    '9c6e06c8dc0ed9f61d2ec7a21a5ecf0b07eb1b756d22ea7ad00649c1bec43dd6',
  );
});

test('disable outranks any pause, and any pause outranks active', () => {
  const at = '2026-11-13T00:00:00.000Z';
  assert.equal(edgeStatus({ disabledAt: null, editorPausedAt: null, budgetPausedAt: null }), 'active');
  assert.equal(edgeStatus({ disabledAt: null, editorPausedAt: at, budgetPausedAt: null }), 'paused');
  assert.equal(edgeStatus({ disabledAt: null, editorPausedAt: null, budgetPausedAt: at }), 'paused');
  assert.equal(edgeStatus({ disabledAt: at, editorPausedAt: at, budgetPausedAt: at }), 'disabled');
});
