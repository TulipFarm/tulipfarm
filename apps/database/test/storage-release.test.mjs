import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  parseStorageReleaseArgs,
  releaseLogins,
  runStorageRelease,
  StorageReleaseError,
} from '../src/storage-release.ts';

const exec = promisify(execFile);
function fixture(initial = []) {
  const secrets = new Map(initial);
  const writes = [];
  let retention = 7;
  let generated = 0;
  const dependencies = {
    prerequisites: async () => ({ credentialsExist: false }),
    readSecret: async name => secrets.get(name),
    saveSecret: async (name, value) => {
      writes.push(['secret', name]);
      secrets.set(name, value);
    },
    randomHex: () => (++generated).toString(16).padStart(64, '0'),
    loginUrl: (login, password) => `postgresql://${login.role}:${password}@localhost/disposable`,
    loginPassword: (login, value) => {
      const url = new URL(value);
      assert.equal(url.username, login.role);
      return url.password;
    },
    inspectLogins: async () => {},
    configureLogin: async (login, password) => {
      writes.push(['login', login.role, password]);
    },
    verifyLogin: async login => {
      writes.push(['verify', login.role]);
    },
    retention: async () => retention,
    setRetention: async value => {
      writes.push(['retention', value]);
      retention = value;
    },
  };
  return { secrets, writes, dependencies };
}

test('commands default to plan and reject ambiguous or incomplete arguments', () => {
  assert.deepEqual(parseStorageReleaseArgs(['retention', '--env', 'production']), {
    kind: 'retention',
    apply: false,
    days: 30,
    expectedCurrent: undefined,
  });
  assert.deepEqual(parseStorageReleaseArgs(['keys', '--env', 'production']), { kind: 'keys', apply: false });
  for (const args of [
    [],
    ['keys'],
    ['keys', '--env', 'local'],
    ['keys', '--env', 'production', '--days', '30'],
    ['keys', '--env', 'production', '--apply', '--apply'],
    ['retention', '--env', 'production', '--apply'],
    ['restore-retention', '--env', 'production'],
    ['migrate', '--env', 'production'],
    ['retention', '--env', 'production', '--days', '36'],
    ['retention', '--env', 'production', '--days', '7e0'],
  ]) {
    assert.throws(() => parseStorageReleaseArgs(args), StorageReleaseError);
  }
});

test('key and login plans and applies fail prerequisites before touching secrets or roles', async () => {
  for (const kind of ['keys', 'logins'])
    for (const apply of [false, true]) {
      const f = fixture();
      f.dependencies.prerequisites = async () => {
        throw new StorageReleaseError('preservation blocked');
      };
      f.dependencies.readSecret = async () => assert.fail('read secrets after failed preflight');
      f.dependencies.retention = async () => assert.fail('read Azure after failed preflight');
      await assert.rejects(
        runStorageRelease({ kind, apply, days: 30, expectedCurrent: 7 }, f.dependencies),
        /preservation blocked/,
      );
      assert.deepEqual(f.writes, []);
    }
});

test('keys plan is read-only, apply creates independent keys, replay retains values and IDs', async () => {
  const f = fixture();
  const plan = await runStorageRelease({ kind: 'keys', apply: false }, f.dependencies);
  assert.equal(plan.keys.length, 3);
  assert.deepEqual(f.writes, []);
  const applied = await runStorageRelease({ kind: 'keys', apply: true }, f.dependencies);
  assert.equal(f.secrets.size, 6);
  assert.equal(new Set([...f.secrets].filter(([name]) => name.endsWith('-key')).map(([, value]) => value)).size, 3);
  const snapshot = [...f.secrets];
  f.writes.length = 0;
  await runStorageRelease({ kind: 'keys', apply: true }, f.dependencies);
  assert.deepEqual([...f.secrets], snapshot);
  assert.deepEqual(f.writes, []);
  for (const [name, value] of f.secrets) if (name.endsWith('-key')) assert.ok(!JSON.stringify(applied).includes(value));
});

test('all stored keys are validated before writes, including decoded independence and encrypted-data recovery', async () => {
  for (const values of [
    [['workspace-confirmation-key', 'invalid']],
    [
      ['workspace-runtime-key', 'ab'.repeat(32)],
      ['workspace-migration-key', 'AB'.repeat(32)],
    ],
    [['workspace-confirmation-key-id', '']],
  ]) {
    const f = fixture(values);
    await assert.rejects(runStorageRelease({ kind: 'keys', apply: true }, f.dependencies));
    assert.deepEqual(f.writes, []);
  }
  const f = fixture();
  f.dependencies.prerequisites = async () => ({ credentialsExist: true });
  await assert.rejects(runStorageRelease({ kind: 'keys', apply: true }, f.dependencies), /Recover missing keys/);
  assert.deepEqual(f.writes, []);
  const collision = fixture();
  collision.dependencies.randomHex = () => 'ab'.repeat(32);
  await assert.rejects(runStorageRelease({ kind: 'keys', apply: true }, collision.dependencies), /generation failed/);
  assert.deepEqual(collision.writes, []);
});

test('partial key installation resumes without replacing completed material', async () => {
  const f = fixture();
  const save = f.dependencies.saveSecret;
  f.dependencies.saveSecret = async (name, value) => {
    if (name === 'workspace-migration-key') throw new Error('injected interruption');
    return save(name, value);
  };
  await assert.rejects(runStorageRelease({ kind: 'keys', apply: true }, f.dependencies), /interruption/);
  const existing = f.secrets.get('workspace-runtime-key');
  f.dependencies.saveSecret = save;
  await runStorageRelease({ kind: 'keys', apply: true }, f.dependencies);
  assert.equal(f.secrets.get('workspace-runtime-key'), existing);
  assert.equal(f.secrets.size, 6);
});

test('login plan validates all credentials before writes; interrupted SQL reuses durable password', async () => {
  const f = fixture();
  await runStorageRelease({ kind: 'logins', apply: false }, f.dependencies);
  assert.deepEqual(f.writes, []);
  const configure = f.dependencies.configureLogin;
  f.dependencies.configureLogin = async () => {
    throw new Error('SQL interrupted');
  };
  await assert.rejects(runStorageRelease({ kind: 'logins', apply: true }, f.dependencies), /SQL interrupted/);
  const url = f.secrets.get(releaseLogins[0].secret);
  assert.ok(url);
  f.dependencies.configureLogin = configure;
  f.writes.length = 0;
  const result = await runStorageRelease({ kind: 'logins', apply: true }, f.dependencies);
  assert.equal(f.secrets.get(releaseLogins[0].secret), url);
  assert.deepEqual(f.writes[0], ['login', releaseLogins[0].role, new URL(url).password]);
  assert.equal(f.writes.filter(([kind]) => kind === 'verify').length, 4);
  assert.ok(!JSON.stringify(result).includes(new URL(url).password));
  f.writes.length = 0;
  f.secrets.set(releaseLogins[3].secret, 'invalid-url');
  await assert.rejects(runStorageRelease({ kind: 'logins', apply: true }, f.dependencies));
  assert.deepEqual(f.writes, []);
});

test('retention defaults to 30; compare, no-op, race rejection, and restore use no unrelated writes', async () => {
  const f = fixture();
  f.dependencies.prerequisites = async () => assert.fail('retention must not open PostgreSQL');
  f.dependencies.readSecret = async () => assert.fail('retention must not read credentials');
  const plan = await runStorageRelease(parseStorageReleaseArgs(['retention', '--env', 'production']), f.dependencies);
  assert.equal(plan.previousDays, 7);
  assert.equal(plan.desiredDays, 30);
  assert.deepEqual(f.writes, []);
  await assert.rejects(
    runStorageRelease({ kind: 'retention', apply: true, days: 30, expectedCurrent: 8 }, f.dependencies),
    /differs/,
  );
  await assert.rejects(
    runStorageRelease({ kind: 'retention', apply: true, days: 30 }, f.dependencies),
    /expected-current/,
  );
  assert.deepEqual(f.writes, []);
  const result = await runStorageRelease(
    { kind: 'retention', apply: true, days: 30, expectedCurrent: 7 },
    f.dependencies,
  );
  assert.equal(result.changed, true);
  assert.match(result.restoreCommand, /restore-retention --env production --days 7 --expected-current 30 --apply$/);
  assert.deepEqual(f.writes, [['retention', 30]]);
  await runStorageRelease({ kind: 'retention', apply: true, days: 30, expectedCurrent: 30 }, f.dependencies);
  assert.equal(f.writes.length, 1);
  await runStorageRelease({ kind: 'restore-retention', apply: true, days: 7, expectedCurrent: 30 }, f.dependencies);
  assert.deepEqual(f.writes, [
    ['retention', 30],
    ['retention', 7],
  ]);
  let reads = 0;
  f.dependencies.retention = async () => (++reads === 1 ? 7 : 8);
  await assert.rejects(
    runStorageRelease({ kind: 'retention', apply: true, days: 30, expectedCurrent: 7 }, f.dependencies),
    /changed after planning/,
  );
  assert.equal(f.writes.length, 2);
});

test('actual compiled CLI help and invalid requests never need Azure authentication', async () => {
  await exec('pnpm', ['--filter', '@tulipfarm/database', 'build'], { cwd: new URL('../../../', import.meta.url) });
  const cli = new URL('../dist/storage-release-cli.js', import.meta.url);
  const options = {
    env: { PATH: process.env.PATH, HOME: '/nonexistent-storage-release-test', AZURE_LOG_LEVEL: 'verbose' },
  };
  const help = await exec(process.execPath, [cli.pathname, '--help'], options);
  assert.match(help.stdout, /read-only plan by default/);
  assert.equal(help.stderr, '');
  for (const args of [
    [],
    ['keys', '--env', 'local'],
    ['retention', '--env', 'production', '--apply'],
    ['migrate', '--env', 'production'],
  ]) {
    await assert.rejects(exec(process.execPath, [cli.pathname, ...args], options), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr, 'Invalid storage release arguments. Use --help.\n');
      return true;
    });
  }
});
