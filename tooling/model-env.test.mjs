import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('Turbo forwards model credentials only to API and ordinary worker development', () => {
  const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'dev', '--dry=json'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, AZURE_FOUNDRY_API_KEY: 'synthetic-not-secret', MODEL_FAMILIES: 'gpt-luna' },
  });
  assert.equal(result.status, 0, result.stderr);
  const tasks = JSON.parse(result.stdout).tasks;
  assert.equal(
    tasks.some(task => task.package === '@tulipfarm/api'),
    true,
  );
  assert.equal(
    tasks.some(task => task.package === '@tulipfarm/web'),
    true,
  );
  assert.equal(
    tasks.some(task => task.package === '@tulipfarm/worker'),
    true,
  );
  for (const task of tasks) {
    const forwarded = task.environmentVariables.specified.passThroughEnv ?? [];
    assert.equal(forwarded.includes('MODEL_FAMILIES'), ['@tulipfarm/api', '@tulipfarm/worker'].includes(task.package));
    assert.equal(
      forwarded.includes('AZURE_FOUNDRY_API_KEY'),
      ['@tulipfarm/api', '@tulipfarm/worker'].includes(task.package),
    );
  }
});

test('model credentials never enter Turbo build environments', () => {
  const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'build', '--dry=json'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, AZURE_FOUNDRY_API_KEY: 'synthetic-not-secret', MODEL_FAMILIES: 'gpt-luna' },
  });
  assert.equal(result.status, 0, result.stderr);
  const tasks = JSON.parse(result.stdout).tasks;
  assert.ok(tasks.some(task => task.package === '@tulipfarm/web'));
  for (const task of tasks) {
    assert.equal(JSON.stringify(task.environmentVariables).includes('AZURE_FOUNDRY_API_KEY'), false);
    assert.equal(JSON.stringify(task.environmentVariables).includes('MODEL_FAMILIES'), false);
  }
});
