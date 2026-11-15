import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// The apps serve the shipped model catalog, which needs a provider key.
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const heavy = ['docx', 'exceljs', 'js-tiktoken', 'jszip', 'pptxgenjs', 'sharp'];
const loaded = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    for (const name of heavy) if (result.url.includes(`/node_modules/${name}/`)) loaded.add(name);
    return result;
  },
});

test('neither app loads the Office, tokenizer or image libraries at startup', async () => {
  await import('../src/app.ts');
  const { buildJobsApp } = await import('../src/jobs-app.ts');
  const app = buildJobsApp();
  try {
    await app.ready();
  } finally {
    await app.close();
  }
  assert.deepEqual([...loaded], []);
});

test('the jobs app answers health checks and serves no request routes', async () => {
  const { buildJobsApp } = await import('../src/jobs-app.ts');
  const app = buildJobsApp();
  try {
    assert.equal((await app.inject('/')).statusCode, 200);
    assert.equal((await app.inject('/v1/health/live')).statusCode, 200);
    for (const url of ['/v1/workspaces', '/v1/me', '/v1/auth/get-session', '/documentation/json'])
      assert.equal((await app.inject(url)).statusCode, 404, url);
  } finally {
    await app.close();
  }
});
