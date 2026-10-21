import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('shared memory conformance is exported and invalidates dependent build and test cache keys', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const require = createRequire(new URL('../packages/memory-postgres/package.json', import.meta.url));
  assert.equal(
    realpathSync(require.resolve('@tulipfarm/memory-core/testing/memory-conformance')),
    realpathSync(new URL('../packages/memory-core/testing/memory-conformance.mjs', import.meta.url)),
  );
  const child = spawn(
    'pnpm',
    ['exec', 'turbo', 'run', 'build', 'test', '--dry=json', '--filter=@tulipfarm/memory-core'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Turbo dry run interrupted: ${signal}`));
      else resolve(code);
    });
  });
  assert.equal(code, 0, Buffer.concat(stderr).toString());
  const { tasks } = JSON.parse(Buffer.concat(stdout).toString());
  for (const operation of ['build', 'test']) {
    const task = tasks.find(task => task.taskId === `@tulipfarm/memory-core#${operation}`);
    assert.ok(task);
    assert.ok(Object.hasOwn(task.inputs, 'testing/memory-conformance.mjs'), operation);
  }
});
