import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLocalTarget, SeedRefused } from '../src/env.ts';
import { parseFlags } from '../src/options.ts';
import { createRandom, stableId } from '../src/random.ts';
import { generators, scenarios } from '../src/registry.ts';
import { resetSeed } from '../src/reset.ts';

test('flags accept inline and spaced values and repeat --workspace', () => {
  assert.deepEqual(
    parseFlags([
      'add',
      'rows',
      '--count=5',
      '--table',
      'Contacts',
      '--workspace',
      'seed-a',
      '--workspace=seed-b',
      '--json',
      'x',
    ]),
    {
      values: { count: '5', table: 'Contacts', json: true },
      positionals: ['add', 'rows', 'x'],
      workspaces: ['seed-a', 'seed-b'],
    },
  );
  assert.throws(() => parseFlags(['--workspace']), /needs a slug/);
});

test('stable IDs and random streams are deterministic UUIDs', () => {
  assert.equal(stableId('a', 1), stableId('a', 1));
  assert.notEqual(stableId('a', 1), stableId('a', 2));
  assert.match(stableId('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const values = seed => {
    const random = createRandom(seed);
    return [random.next(), random.int(1, 9)];
  };
  assert.deepEqual(values(7), values(7));
});

test('seeding refuses non-local targets', () => {
  const root = `${mkdtempSync(join(tmpdir(), 'dev-seed-'))}/`;
  const local = 'postgresql://u:p@127.0.0.1:5432/tulipfarm';
  const env = {
    DATABASE_URL: local,
    WORKSPACE_PROVISIONING_DATABASE_URL: local,
    WORKSPACE_DATABASE_ENDPOINT: local,
    WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL: local,
    WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
  };
  assert.throws(() => assertLocalTarget(env, root), SeedRefused);
  writeFileSync(`${root}.env.dev-setup.json`, '{}');
  assertLocalTarget(env, root);
  assert.throws(() => assertLocalTarget({ ...env, NODE_ENV: 'production' }, root), /production/);
  assert.throws(
    () => assertLocalTarget({ ...env, DATABASE_URL: 'postgresql://u:p@db.example.com/x' }, root),
    /loopback/,
  );
});

test('registry names are unique and dependencies resolve', () => {
  const names = generators.map(generator => generator.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(scenarios.map(scenario => scenario.name)).size, scenarios.length);
  for (const generator of generators)
    for (const dependency of generator.requires)
      assert.ok(dependency === 'workspace' || names.includes(dependency), `${generator.name} requires ${dependency}`);
  assert.deepEqual(
    ['empty', 'basic', 'rich', 'large', 'access', 'agent-builder'].filter(
      name => !scenarios.some(scenario => scenario.name === name),
    ),
    [],
  );
});

test('reset refuses workspaces outside the seed prefix before connecting', async () => {
  await assert.rejects(
    resetSeed({ users: {}, workspaces: {} }, { slugs: ['acme'], users: false }, () => {}),
    SeedRefused,
  );
});
