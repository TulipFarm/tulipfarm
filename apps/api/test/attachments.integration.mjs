import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createAttachments, attachmentLimit } from '@tulipfarm/conversations/attachments';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { registerConversations } from '../src/conversations.ts';
import { securityServerOptions } from '../src/security.ts';

test('attachment HTTP authenticates before bytes and serves bound downloads without object URLs', async () => {
  const f = await conversationFixture();
  const app = Fastify(securityServerOptions());
  const objects = new Map();
  try {
    const { workspace: w, store } = f;
    const attachments = createAttachments(f.runtime, {
      putIfAbsent: async (key, value) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(value));
      },
      read: async key => objects.get(key),
      remove: async key => {
        objects.delete(key);
      },
    });
    const auth = {
      api: {
        getSession: async ({ headers }) => {
          const cookie = headers.get('cookie');
          return cookie === 'owner'
            ? { user: { id: w.userId } }
            : cookie === 'admin'
              ? { user: { id: 'other-admin' } }
              : null;
        },
      },
    };
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,'other-admin','admin')`,
      [randomUUID()],
    );
    registerConversations(app, { auth, service: store, attachments });
    const chat = randomUUID(),
      upload = randomUUID();
    await store.create(w.id, w.userId, { chatId: chat, commandId: randomUUID() });
    const base = `/workspaces/${w.id}/conversations/${chat}`;
    const headers = { cookie: 'owner', origin: 'http://localhost:5173' };
    const content = Buffer.alloc(attachmentLimit, 42);
    const metadata = {
      filename: 'private report.txt',
      mediaType: 'text/plain',
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    const reservation = await app.inject({
      method: 'PUT',
      url: `${base}/uploads/${upload}`,
      headers,
      payload: metadata,
    });
    assert.equal(reservation.statusCode, 200, reservation.body);
    assert.equal(reservation.json().state, 'reserved');
    assert.equal('object_key' in reservation.json(), false);
    const receive = (cookie, payload = content) =>
      app.inject({
        method: 'PUT',
        url: `${base}/uploads/${upload}/content`,
        headers: { ...headers, cookie, 'content-type': 'application/octet-stream' },
        payload,
      });
    assert.equal((await receive('')).statusCode, 401);
    assert.equal((await receive('admin')).statusCode, 404);
    assert.equal(objects.size, 0);
    assert.equal((await receive('owner', Buffer.alloc(attachmentLimit + 1))).statusCode, 413);
    assert.equal((await receive('owner')).statusCode, 200);
    assert.equal((await receive('owner')).statusCode, 200);
    const downloadUrl = `${base}/attachments/${upload}/content`;
    assert.equal((await app.inject({ url: downloadUrl, headers })).statusCode, 404);
    const sent = await app.inject({
      method: 'PUT',
      url: `${base}/messages/${randomUUID()}`,
      headers,
      payload: { commandId: randomUUID(), parts: [{ kind: 'attachment', attachmentId: upload }] },
    });
    assert.equal(sent.statusCode, 200, sent.body);
    const downloaded = await app.inject({ url: downloadUrl, headers });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(downloaded.rawPayload, content);
    assert.equal(downloaded.headers['cache-control'], 'no-store');
    assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
    assert.equal(downloaded.headers['content-type'], 'application/octet-stream');
    assert.match(downloaded.headers['content-disposition'], /^attachment;/);
    assert.equal(downloaded.headers.location, undefined);
    assert.equal((await app.inject({ url: downloadUrl, headers: { cookie: 'admin' } })).statusCode, 404);
  } finally {
    await app.close();
    await f.close();
  }
});

for (const enabled of [false, true]) {
  test(`ordinary conversation routes retain the 1 MiB binary limit with attachments ${enabled ? 'enabled' : 'disabled'}`, async () => {
    const app = Fastify(securityServerOptions());
    const auth = { api: { getSession: async () => ({ user: { id: 'fixture-owner' } }) } };
    registerConversations(app, { auth, service: {}, attachments: enabled ? {} : undefined });
    try {
      const base = `/workspaces/${randomUUID()}/conversations/${randomUUID()}`;
      for (const [method, url] of [
        ['PUT', base],
        ['PUT', `${base}/messages/${randomUUID()}`],
        ['PATCH', base],
        ['PUT', `${base}/uploads/${randomUUID()}`],
      ]) {
        const response = await app.inject({
          method,
          url,
          headers: { origin: 'http://localhost:5173', 'content-type': 'application/octet-stream' },
          payload: Buffer.alloc(1_048_577),
        });
        assert.equal(response.statusCode, 413, `${method} ${url}: ${response.body}`);
        assert.deepEqual(response.json(), { error: 'request-too-large' });
      }
    } finally {
      await app.close();
    }
  });
}
