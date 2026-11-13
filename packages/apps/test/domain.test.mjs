import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBuildId, appNameSchema, appSlugSchema, commitSchema, edgeStatus, readAppRecipe } from '../src/index.ts';

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
  assert.equal(readAppRecipe('{"kind":"command","runtime":"node18","command":"x","output":"dist"}').ok, false);
  assert.equal(readAppRecipe('{"kind":"copy","script":"rm -rf /"}').ok, false);
  assert.equal(readAppRecipe('{"kind":"shell"}').ok, false);
});

test('the build id is a digest of commit, canonical recipe and builder', async () => {
  assert.equal(
    await appBuildId(commit, { kind: 'copy', root: '.' }, 'copy'),
    '45d3bdabd2521005c86c9a768b65091785c6ccd7ff07caad310974d092255915',
  );
  const recipe = { output: 'dist', command: 'npm run build', runtime: 'node22', kind: 'command', install: undefined };
  assert.equal(
    await appBuildId(commit, recipe, 'builder-1'),
    '77ee2607878df28737db4dcc2477e4b591b99118e4c82c2614a15a62741bddab',
  );
  assert.equal(
    await appBuildId(commit, { kind: 'copy', root: '.' }, 'builder-1'),
    '458d011e5ec88446155858ed787a0d8d1734dc0a866b8dc6f62574fc0d91b14b',
  );
});

test('disable outranks any pause, and any pause outranks active', () => {
  const at = '2026-11-13T00:00:00.000Z';
  assert.equal(edgeStatus({ disabledAt: null, editorPausedAt: null, budgetPausedAt: null }), 'active');
  assert.equal(edgeStatus({ disabledAt: null, editorPausedAt: at, budgetPausedAt: null }), 'paused');
  assert.equal(edgeStatus({ disabledAt: null, editorPausedAt: null, budgetPausedAt: at }), 'paused');
  assert.equal(edgeStatus({ disabledAt: at, editorPausedAt: at, budgetPausedAt: at }), 'disabled');
});
