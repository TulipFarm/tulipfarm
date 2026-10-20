import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { skillRuntimePathSchema, skillResultSchema } from '../dist/skill-protocol.js';
import { configuredSkillRuntimeProbe } from '../dist/client.js';

test('skill paths reject host paths, traversal, hidden dependency trees, and platform ambiguity', () => {
  for (const path of [
    '/tmp/x',
    '../x',
    'a/../x',
    'a\\b',
    'a//b',
    'file:',
    'a. ',
    '.git/config',
    'node_modules/a',
    'a\0',
  ]) {
    assert.equal(skillRuntimePathSchema.safeParse(path).success, false, path);
  }
  assert.equal(skillRuntimePathSchema.safeParse('scripts/process.py').success, true);
});

test('skill outputs enforce the aggregate decoded byte budget and unique paths', () => {
  const base = { kind: 'completed', exitCode: 0, stdout: '', stderr: '' };
  assert.equal(
    skillResultSchema.safeParse({
      ...base,
      files: [
        { path: 'a', content: '' },
        { path: 'A', content: '' },
      ],
    }).success,
    false,
  );
  const content = Buffer.alloc(6 * 1024 * 1024).toString('base64');
  assert.equal(
    skillResultSchema.safeParse({
      ...base,
      files: [
        { path: 'a', content },
        { path: 'b', content },
      ],
    }).success,
    false,
  );
  assert.equal(skillResultSchema.safeParse({ ...base, files: [{ path: 'a', content: 'AQI=' }] }).success, true);
});

test('runtime status is opt-in, read-only, credential-free and bounded', async t => {
  assert.equal(await configuredSkillRuntimeProbe({})(), false);
  assert.throws(
    () => configuredSkillRuntimeProbe({ SKILL_SCRIPTS_ENABLED: 'true' }),
    /incomplete-skill-status-configuration/,
  );
  for (const url of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/?token=x',
    'https://example.com/#x',
  ]) {
    assert.throws(
      () => configuredSkillRuntimeProbe({ SKILL_SCRIPTS_ENABLED: 'true', SKILL_BROKER_STATUS_URL: url }),
      /invalid-snippet-broker-url/,
    );
  }
  let body = JSON.stringify({ available: true, profile: 'skill-runtime-v1' }),
    status = 200;
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/health/skill-runtime');
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(status, { 'content-type': 'application/json', location: '/elsewhere' }).end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const probe = configuredSkillRuntimeProbe({
    SKILL_SCRIPTS_ENABLED: 'true',
    SKILL_BROKER_STATUS_URL: `http://127.0.0.1:${server.address().port}`,
    SNIPPET_ALLOW_LOCAL_HTTP: 'true',
  });
  assert.equal(await probe(), true);
  body = JSON.stringify({ available: false, profile: 'skill-runtime-v1' });
  assert.equal(await probe(), false);
  body = 'x'.repeat(1025);
  await assert.rejects(probe(), /skill-runtime-status-invalid/);
  body = JSON.stringify({ available: true, profile: 'unknown' });
  await assert.rejects(probe());
  status = 503;
  await assert.rejects(probe(), /skill-runtime-status-unavailable/);
  status = 302;
  await assert.rejects(probe(), /fetch failed/);
});
