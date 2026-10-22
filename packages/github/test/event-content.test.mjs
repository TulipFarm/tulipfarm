import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { githubEventContent } from '../src/event-content.ts';
import { normalizeGitHubEvent } from '../src/events.ts';

const event = () =>
  normalizeGitHubEvent('pull_request', {
    action: 'opened',
    installation: { id: 20 },
    repository: {
      id: 10,
      full_name: 'acme/private',
      html_url: 'https://github.com/acme/private',
      private: true,
      owner: { id: 30, type: 'Organization' },
    },
    pull_request: {
      number: 1,
      title: 'Private title',
      html_url: 'https://github.com/acme/private/pull/1',
      user: { login: 'author' },
      state: 'open',
      merged_at: null,
      base: { ref: 'main', repo: { id: 10 } },
      head: { ref: 'feature' },
    },
  });
const binding = () => ({ appId: '100', deliveryId: randomUUID(), bodyDigest: 'a'.repeat(64), event: 'pull_request' });
const ring = { activeKeyId: 'current', keys: { current: 'ab'.repeat(32), previous: 'cd'.repeat(32) } };

test('event content is encrypted and bound to its App, delivery, digest and event name', () => {
  const cipher = githubEventContent(ring),
    owner = binding(),
    value = event();
  const sealed = cipher.encrypt(owner, value);
  assert.equal(JSON.stringify(sealed).includes('Private title'), false);
  assert.deepEqual(cipher.decrypt(owner, sealed), value);
  for (const change of [
    { appId: '101' },
    { deliveryId: randomUUID() },
    { bodyDigest: 'b'.repeat(64) },
    { event: 'issue_comment' },
  ]) {
    assert.throws(() => cipher.decrypt({ ...owner, ...change }, sealed));
  }
  assert.throws(() => cipher.decrypt(owner, { ...sealed, tag: Buffer.alloc(16).toString('base64') }));
  assert.throws(() => cipher.decrypt(owner, { ...sealed, ciphertext: 'x'.repeat(44001) }));
  assert.throws(() => cipher.encrypt(owner, { ...value, fields: { ...value.fields, rawPayload: 'private' } }));
});

test('event key rotation reads old ciphertext only while its exact key remains configured', () => {
  const owner = binding(),
    value = event();
  const old = githubEventContent({ ...ring, activeKeyId: 'previous' }).encrypt(owner, value);
  assert.deepEqual(githubEventContent(ring).decrypt(owner, old), value);
  assert.throws(() =>
    githubEventContent({ activeKeyId: 'current', keys: { current: ring.keys.current } }).decrypt(owner, old),
  );
});
