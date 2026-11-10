import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerSkillImports } from '../src/skill-imports.ts';

test('refused skill links return client errors before creating an import', async () => {
  const app = Fastify();
  let transactions = 0;
  registerSkillImports(app, {
    auth: {
      api: { getSession: async () => ({ user: { id: randomUUID() }, session: { id: randomUUID() } }) },
    },
    runtime: {
      transaction() {
        transactions++;
        throw new Error('A refused source must not start an import');
      },
    },
    objects: {},
  });
  try {
    for (const [url, code] of [
      ['ftp://example.com/SKILL.md', 'source-not-https'],
      ['file:///etc/passwd', 'source-not-https'],
      ['javascript:alert(1)', 'source-not-https'],
      ['http://example.com/SKILL.md', 'source-not-https'],
      ['https://github.com/example', 'source-unsupported'],
      ['https://example.com:8443/SKILL.md', 'source-unsupported'],
      ['https://example.com/SKILL.md?token=x', 'source-unsupported'],
      ['http://localhost/SKILL.md', 'source-not-public'],
      ['http://127.0.0.1:3002/SKILL.md', 'source-not-public'],
      ['http://169.254.169.254/latest/meta-data/', 'source-not-public'],
      ['https://[::1]/SKILL.md', 'source-not-public'],
      ['https://100.64.0.1/SKILL.md', 'source-not-public'],
      ['not a url', 'source-invalid-url'],
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: `/workspaces/${randomUUID()}/skill-imports/${randomUUID()}`,
        headers: { origin: 'http://localhost:5173' },
        payload: { url },
      });
      assert.equal(response.statusCode, 400, url);
      assert.deepEqual(response.json(), { error: code }, url);
    }
    assert.equal(transactions, 0);
  } finally {
    await app.close();
  }
});
