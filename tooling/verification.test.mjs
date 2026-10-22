import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { checkPrerequisites, slackPrerequisites, localServiceUrl } from './verification-preflight.mjs';
import { runLogged } from './check-logged.mjs';

test('preflight reports all missing settings without echoing their values', async () => {
  await assert.rejects(
    checkPrerequisites(
      {
        environment: ['TEST_ADMIN_DATABASE_URL', 'R2_SECRET_ACCESS_KEY'],
        executables: { TEMPORAL_BINARY: '/missing/private-credential-value' },
      },
      {},
    ),
    error => {
      assert.match(error.message, /TEST_ADMIN_DATABASE_URL/);
      assert.match(error.message, /R2_SECRET_ACCESS_KEY/);
      assert.match(error.message, /TEMPORAL_BINARY/);
      assert.doesNotMatch(error.message, /private-credential-value/);
      return true;
    },
  );
});

test('task journey refuses missing foundation tools before spawning Temporal', () => {
  const result = spawnSync(process.execPath, ['tooling/verify-task-journey.mjs'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, TEMPORAL_BINARY: process.execPath },
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /POSTGRES_BIN\/initdb/);
  assert.match(result.stderr, /RUSTFS_BINARY/);
  assert.doesNotMatch(result.stderr, /bad option:.*server|unknown option.*server/);
});

test('Slack preflight checks reader credentials before launching any suite', async () => {
  await assert.rejects(slackPrerequisites({}), error => {
    assert.match(error.message, /R2_SOUL_READ_ACCESS_KEY_ID/);
    assert.match(error.message, /R2_SOUL_READ_SECRET_ACCESS_KEY/);
    assert.match(error.message, /TEST_TEMPORAL_CLI/);
    assert.match(error.message, /TEST_ADMIN_DATABASE_URL/);
    return true;
  });
  await assert.rejects(checkPrerequisites({ executables: { DIRECTORY: tmpdir() } }), /must name an executable file/);
  await checkPrerequisites({ executables: { NODE: process.execPath } });
  assert.throws(
    () => localServiceUrl('TEST_ADMIN_DATABASE_URL', 'postgres://test@localhost/postgres?host=example.com'),
    /must point to a disposable local service/,
  );
  assert.equal(localServiceUrl('TEST_ADMIN_DATABASE_URL', 'postgres://test@localhost/postgres').hostname, 'localhost');
  await assert.rejects(
    checkPrerequisites({ files: ['apps/api/dist/absent-navigation-test-artifact.js'] }),
    /Build or install apps\/api\/dist\/absent-navigation-test-artifact.js/,
  );
});

test('logged checks retain large output and preserve failing exit codes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'check-logged-test-'));
  try {
    const result = await runLogged(
      process.execPath,
      [
        '-e',
        "process.stdout.write('x'.repeat(100000)+'\\n'); process.stderr.write('specific failure\\n'); process.exitCode=7",
      ],
      parent,
    );
    assert.equal(result.code, 7);
    const log = await readFile(join(result.directory, 'stdout.log'), 'utf8');
    assert.ok(log.includes('x'.repeat(100000)));
    assert.match(await readFile(join(result.directory, 'stderr.log'), 'utf8'), /specific failure/);
    const summary = await readFile(join(result.directory, 'summary.md'), 'utf8');
    assert.match(summary, /FAIL.*Exit code 7/);
    assert.ok(summary.length < 2000);
    const passed = await runLogged(process.execPath, ['-e', "console.log('all checks passed')"], parent);
    assert.equal(passed.code, 0);
    assert.notEqual(passed.directory, result.directory);
    const missing = await runLogged(join(parent, 'missing-executable'), [], parent);
    assert.equal(missing.code, 1);
    assert.match(await readFile(join(missing.directory, 'stderr.log'), 'utf8'), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test(
  'logged checks retain successful exit codes when process group cleanup is unsignallable',
  { skip: process.platform === 'win32' },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), 'check-logged-test-'));
    const kill = process.kill;
    process.kill = (pid, signal) => {
      if (pid < 0) {
        const error = new Error(`kill EPERM ${pid} ${signal}`);
        error.code = 'EPERM';
        throw error;
      }
      return kill(pid, signal);
    };
    try {
      const result = await runLogged(process.execPath, ['-e', "console.log('all checks passed')"], parent);
      assert.equal(result.code, 0);
    } finally {
      process.kill = kill;
      await rm(parent, { recursive: true, force: true });
    }
  },
);
