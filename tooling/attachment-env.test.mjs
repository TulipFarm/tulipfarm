import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const credentials = {
  CHAT_R2_ACCOUNT_ID: 'a'.repeat(32),
  CHAT_R2_BUCKET: 'synthetic-private-attachments',
  CHAT_R2_ACCESS_KEY_ID: 'synthetic-attachment-access',
  CHAT_R2_SECRET_ACCESS_KEY: 'synthetic-attachment-secret',
};

test('Turbo resolves attachment credentials only for API and worker dev, never builds or maintenance', () => {
  const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'dev', 'dev:storage', 'build', '--dry=json'], {
    cwd: root,
    encoding: 'utf8',
    // The dry-run plan lists every task's files and already outgrows the 1 MB default.
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...credentials },
  });
  assert.equal(result.status, 0, result.stderr);
  const tasks = JSON.parse(result.stdout).tasks;
  assert.equal(
    tasks.some(task => task.taskId === '@tulipfarm/api#dev'),
    true,
  );
  assert.equal(
    tasks.some(task => task.taskId === '@tulipfarm/worker#dev'),
    true,
  );
  assert.equal(
    tasks.some(task => task.taskId === '@tulipfarm/worker#dev:storage'),
    true,
  );
  assert.equal(
    tasks.some(task => task.taskId === '@tulipfarm/web#build'),
    true,
  );
  for (const task of tasks) {
    const expected = ['@tulipfarm/api#dev', '@tulipfarm/worker#dev'].includes(task.taskId);
    for (const name of Object.keys(credentials)) {
      assert.equal(JSON.stringify(task.environmentVariables).includes(name), expected, `${task.taskId} ${name}`);
    }
  }
});

test('actual strict-mode Turbo dev children receive scoped attachment values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attachment-turbo-'));
  try {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'attachment-env-proof', private: true, packageManager: packageJson.packageManager }),
    );
    await writeFile(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    await writeFile(
      join(directory, 'pnpm-lock.yaml'),
      'lockfileVersion: 9.0\nimporters:\n  .: {}\n  apps/api: {}\n  apps/worker: {}\n  apps/web: {}\n',
    );
    await copyFile(join(root, 'turbo.json'), join(directory, 'turbo.json'));
    for (const service of ['api', 'worker', 'web']) {
      const app = join(directory, 'apps', service);
      await mkdir(app, { recursive: true });
      if (service !== 'web') await copyFile(join(root, 'apps', service, 'turbo.json'), join(app, 'turbo.json'));
      const scripts = { dev: 'node proof.mjs dev', build: 'node proof.mjs build' };
      if (service === 'worker') scripts['dev:storage'] = 'node proof.mjs dev:storage';
      await writeFile(join(app, 'package.json'), JSON.stringify({ name: `@tulipfarm/${service}`, scripts }));
      await writeFile(
        join(app, 'proof.mjs'),
        `
import assert from 'node:assert/strict';
const expected = ${JSON.stringify(credentials)};
const enabled = process.argv[2] === 'dev' && ${JSON.stringify(service)} !== 'web';
for (const [key, value] of Object.entries(expected)) assert.equal(process.env[key], enabled ? value : undefined, key);
assert.equal(process.env.CHAT_R2_ENDPOINT, undefined);
console.log('attachment-env-verified-${service}-' + process.argv[2]);
`,
      );
    }
    const install = spawnSync('pnpm', ['install', '--offline', '--ignore-scripts'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const result = spawnSync(
      join(root, 'node_modules/.bin/turbo'),
      ['run', 'dev', 'dev:storage', 'build', '--env-mode=strict'],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, ...credentials, CHAT_R2_ENDPOINT: 'http://must-not-forward.invalid' },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const name of [
      'api-dev',
      'worker-dev',
      'web-dev',
      'api-build',
      'worker-build',
      'web-build',
      'worker-dev:storage',
    ]) {
      assert.ok(result.stdout.includes(`attachment-env-verified-${name}`), name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
