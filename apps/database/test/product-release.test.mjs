import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { parseProductReleaseArgs, runProductRelease } from '../src/product-release.ts';

function fixture() {
  const secrets = new Map([
    ['database-password', 'protected-app-password'],
    ['model-key', 'operator-owned'],
  ]);
  let generated = 0;
  let role = 'absent';
  const ports = {
    readSecret: async name => secrets.get(name),
    createSecret: async (name, value) => {
      assert.equal(secrets.has(name), false);
      secrets.set(name, value);
    },
    randomHex: () => (++generated).toString(16).padStart(64, '0'),
    encryptedKeyIds: async () => ({ email: [], integration: [] }),
    inspectEmailLogin: async () => role,
    createEmailLogin: async password => {
      assert.equal(password.length, 64);
      role = 'retained';
    },
    loginUrl: password => `postgresql://email:${password}@localhost/test`,
    loginPassword: url => new URL(url).password,
    verifyEmailLogin: async url => assert.equal(new URL(url).username, 'email'),
  };
  return { secrets, ports };
}

test('strict production-only arguments and offline help', () => {
  assert.deepEqual(parseProductReleaseArgs(['keys', '--env', 'production']), { kind: 'keys', apply: false });
  assert.equal(parseProductReleaseArgs(['--help']), 'help');
  for (const args of [
    ['keys'],
    ['keys', '--env', 'local'],
    ['keys', '--env', 'production', '--apply', '--apply'],
    ['model-key', '--env', 'production'],
  ]) {
    assert.throws(() => parseProductReleaseArgs(args), /Invalid/);
  }
});

test('plan generates nothing; apply creates independent bundles and preserves every existing credential on replay', async () => {
  const { secrets, ports } = fixture();
  const plan = await runProductRelease({ kind: 'keys', apply: false }, ports);
  assert.deepEqual(
    plan.keys.map(key => [key.keyId, key.action]),
    [
      ['email-v1', 'create-missing'],
      ['connection-v1', 'create-missing'],
    ],
  );
  assert.equal(secrets.size, 2);
  const applied = await runProductRelease({ kind: 'keys', apply: true }, ports);
  assert.equal(secrets.get('email-delivery-key'), '1'.padStart(64, '0'));
  assert.equal(secrets.get('integration-credential-key'), '2'.padStart(64, '0'));
  assert.equal(secrets.get('email-delivery-previous-keys'), '{}');
  const before = [...secrets];
  const retry = await runProductRelease({ kind: 'keys', apply: true }, ports);
  assert.deepEqual(
    retry.keys.map(key => key.action),
    ['retain', 'retain'],
  );
  assert.deepEqual([...secrets], before);
  assert.equal(JSON.stringify(applied).includes(secrets.get('email-delivery-key')), false);
  assert.equal(secrets.get('database-password'), 'protected-app-password');
  assert.equal(secrets.get('model-key'), 'operator-owned');
});

test('ciphertext and partial or malformed configuration fail before any writes', async () => {
  for (const mutation of [
    ({ ports }) => {
      ports.encryptedKeyIds = async () => ({ email: ['old'], integration: [] });
    },
    ({ secrets }) => {
      secrets.set('email-delivery-key', 'a'.repeat(64));
    },
    ({ secrets }) => {
      secrets.set('integration-credential-previous-keys', 'invalid-secret-json');
    },
    ({ secrets }) => {
      secrets.set('email-delivery-previous-keys', JSON.stringify({ 'email-v1': 'a'.repeat(64) }));
    },
  ]) {
    const state = fixture();
    mutation(state);
    const before = [...state.secrets];
    await assert.rejects(runProductRelease({ kind: 'keys', apply: true }, state.ports));
    assert.deepEqual([...state.secrets], before);
  }
});

test('existing encrypted data retains active and previous keys and refuses unknown IDs', async () => {
  const { secrets, ports } = fixture();
  await runProductRelease({ kind: 'keys', apply: true }, ports);
  secrets.set('email-delivery-previous-keys', JSON.stringify({ old: 'a'.repeat(64) }));
  ports.encryptedKeyIds = async () => ({ email: ['email-v1', 'old'], integration: ['connection-v1'] });
  const before = [...secrets];
  assert.deepEqual(
    (await runProductRelease({ kind: 'keys', apply: true }, ports)).keys.map(key => key.action),
    ['retain', 'retain'],
  );
  assert.deepEqual([...secrets], before);
  ports.encryptedKeyIds = async () => ({ email: ['lost'], integration: [] });
  await assert.rejects(runProductRelease({ kind: 'keys', apply: true }, ports), /unavailable key ID/);
});

test('email login is create-only and resumes after a secret-only partial failure', async () => {
  const { secrets, ports } = fixture();
  const create = ports.createEmailLogin;
  ports.createEmailLogin = async () => {
    throw new Error('interrupted');
  };
  await assert.rejects(runProductRelease({ kind: 'email-login', apply: true }, ports), /interrupted/);
  const before = [...secrets];
  ports.createEmailLogin = create;
  assert.equal((await runProductRelease({ kind: 'email-login', apply: true }, ports)).action, 'create');
  ports.createEmailLogin = async () => assert.fail('must not alter a retained role');
  assert.equal((await runProductRelease({ kind: 'email-login', apply: true }, ports)).action, 'retain');
  assert.deepEqual([...secrets], before);
  secrets.delete('email-delivery-database-url');
  await assert.rejects(runProductRelease({ kind: 'email-login', apply: true }, ports), /Recover it without rotation/);
});

test('duplicate generated keys fail before writes and interrupted key setup resumes with its original key', async () => {
  const state = fixture();
  state.ports.randomHex = () => 'a'.repeat(64);
  await assert.rejects(runProductRelease({ kind: 'keys', apply: true }, state.ports), /Independent key generation/);
  assert.equal(state.secrets.size, 2);
  const retry = fixture();
  const create = retry.ports.createSecret;
  retry.ports.createSecret = async (name, value) => {
    if (name === 'integration-credential-key') throw new Error('interrupted');
    await create(name, value);
  };
  await assert.rejects(runProductRelease({ kind: 'keys', apply: true }, retry.ports), /interrupted/);
  const original = retry.secrets.get('email-delivery-key');
  retry.ports.createSecret = create;
  assert.equal((await runProductRelease({ kind: 'keys', apply: true }, retry.ports)).keys[0].action, 'retain');
  assert.equal(retry.secrets.get('email-delivery-key'), original);
  assert.equal(retry.secrets.get('integration-credential-key'), '3'.padStart(64, '0'));
});

test('actual CLI handles help and invalid secret arguments without provider access or disclosure', () => {
  const cli = new URL('../src/product-release-cli.ts', import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Read-only plan by default/);
  const invalid = spawnSync(
    process.execPath,
    [cli.pathname, 'keys', '--env', 'production', '--secret=private-sentinel'],
    { encoding: 'utf8' },
  );
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, 'Invalid product release arguments. Use --help.\n');
  assert.equal((invalid.stdout + invalid.stderr).includes('private-sentinel'), false);
});
