import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { z } from 'zod';
import { registerSlack } from '../src/slack.ts';

test('failed browser callbacks log safe diagnostics and preserve recovery redirects', async t => {
  const entries = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.includes('"operation":"slack.link.')) {
      entries.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  const failure = z.object({ id_token: z.string() }).safeParse({ id_token: 123 }).error;
  const app = Fastify();
  t.after(() => app.close());
  const recoveries = [];
  const memberLinking = {
    proveIdentity: async () => {
      throw failure;
    },
    consent: async () => {
      throw failure;
    },
    complete: async () => {
      throw failure;
    },
    recover: async (...args) => {
      recoveries.push(args);
      return { workspaceId: 'test-workspace', eventId: 'test-event' };
    },
  };
  const auth = {
    api: { getSession: async () => ({ user: { id: 'private-user' }, session: { id: 'private-session' } }) },
  };
  registerSlack(app, auth, { config: {}, memberLinking });
  for (const action of ['identity', 'consent', 'complete']) {
    const response = await app.inject({
      url: `/slack/link/${action}?state=private-state&code=private-code`,
      headers: { accept: 'text/html', cookie: '__Host-slack-link=private-browser' },
    });
    assert.equal(response.statusCode, 303);
    assert.equal(new URL(response.headers.location).searchParams.get('recovery'), 'retry');
    assert.match(response.headers['set-cookie'], /Max-Age=0/);
    const entry = entries.at(-1);
    assert.equal(entry.operation, `slack.link.${action}`);
    assert.equal(entry['error.type'], 'invalid-slack-data');
    assert.equal(entry['error.issues'], '[{"code":"invalid_type","path":["id_token"]}]');
  }
  const denied = await app.inject({
    url: '/slack/link/complete?state=private-state&error=private-provider-error',
    headers: { accept: 'text/html', cookie: '__Host-slack-link=private-browser' },
  });
  assert.equal(denied.statusCode, 303);
  assert.equal(entries.at(-1)['error.type'], 'unrecognized-provider-error');
  assert.equal(entries.length, 4);
  assert.equal(recoveries.length, 4);
  assert.equal(JSON.stringify(entries).includes('private-'), false);
});
