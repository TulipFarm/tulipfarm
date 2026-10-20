import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { createAuth } from '../src/auth.ts';
import { registerConversations } from '../src/conversations.ts';
import { registerCredits } from '../src/credits.ts';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '@tulipfarm/conversations';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { reverseReply } from '../../../packages/conversations/test/fixture.mjs';
import { securityServerOptions } from '../src/security.ts';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// The credits route reads the balance through the registered gate.
await registerExtension(creditAccountExtension, { app: 'api', env: {} });

test(
  'authenticated private chat HTTP persists replies and fences duplicate queue controls with real restricted logins',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    const role = `chat_identity_${randomUUID().replaceAll('-', '')}`;
    const app = Fastify(securityServerOptions());
    let identity,
      runtime,
      roleCreated = false;
    try {
      await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const password = randomUUID();
      await db.admin.query(
        `CREATE ROLE ${escapeIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`,
      );
      roleCreated = true;
      const url = new URL(db.connectionString);
      await db.platform.query(
        `GRANT CONNECT ON DATABASE ${escapeIdentifier(url.pathname.slice(1))} TO ${escapeIdentifier(role)}; GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(role)}`,
      );
      await db.platform.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON app.users, app.sessions, app.accounts, app.verifications TO ${escapeIdentifier(role)}`,
      );
      url.username = role;
      url.password = password;
      identity = new Pool({ connectionString: url.href, options: '-c search_path=app' });
      const links = [];
      const auth = createAuth(
        identity,
        async ({ url }) => {
          links.push(url);
        },
        async () => {},
      );
      async function signIn(name) {
        await auth.api.signInMagicLink({
          headers: new Headers({ origin: 'http://localhost:5173' }),
          body: { email: `${randomUUID()}@example.com`, name },
        });
        const response = await auth.handler(new Request(links.pop()));
        const cookie = response.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; ');
        const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
        assert.ok(session);
        return { id: session.user.id, cookie };
      }
      const owner = await signIn('Chat owner');
      const other = await signIn('Workspace admin');
      const stream = await workspaceTableMigrations();
      const a = await db.create(stream, { userId: owner.id }),
        b = await db.create(stream, { userId: owner.id });
      const table = name => qualified(a.names.schema, name);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        other.id,
      ]);
      await assert.rejects(
        identity.query(`SELECT * FROM ${table('tf_conversations')}`),
        error => error.code === '42501',
      );
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 40,
        maxPools: 2,
        connectionsPerPool: 4,
        resolveCredential: async id => {
          const workspace = db.workspaces.find(item => item.id === id);
          assert.ok(workspace);
          return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
        },
      });
      const service = createConversations(runtime);
      const executor = createConversationExecutor(runtime, reverseReply);
      await app.register(swagger, { openapi: { info: { title: 'Private chats', version: '1' } } });
      await app.register(async routes => registerConversations(routes, { auth, service }), { prefix: '/v1' });
      await app.register(async routes => registerCredits(routes, { auth, runtime }), { prefix: '/v1' });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const base = `/v1/workspaces/${a.id}/conversations`;
      async function request(who, method, path, body, expected = 200, origin = 'http://localhost:5173') {
        const response = await fetch(`${address}${path}`, {
          method,
          headers: {
            ...(who ? { cookie: who.cookie } : {}),
            ...(origin ? { origin } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const result = await response.json();
        assert.equal(response.status, expected, JSON.stringify(result));
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return result;
      }
      const chatId = randomUUID(),
        commandId = randomUUID(),
        chat = `${base}/${chatId}`;
      const creditPath = `/v1/workspaces/${a.id}/credits`;
      await request(null, 'GET', creditPath, undefined, 401);
      const welcome = await request(owner, 'GET', creditPath);
      assert.equal(welcome.available, 1000);
      assert.equal(welcome.granted, 1000);
      assert.equal(welcome.days.length, 30);
      assert.deepEqual(welcome.breakdown, []);
      assert.doesNotMatch(JSON.stringify(welcome), /usd|dollar|prompt|message/i);
      assert.equal((await request(other, 'GET', creditPath)).available, 1000);
      await request(other, 'GET', `/v1/workspaces/${b.id}/credits`, undefined, 404);
      await request(null, 'GET', base, undefined, 401);
      await request(owner, 'PUT', chat, { commandId }, 403, 'https://foreign.example');
      await request(owner, 'PUT', chat, { commandId }, 403, '');
      assert.deepEqual(await request(owner, 'PUT', chat, { commandId }), { id: chatId });
      assert.deepEqual(await request(owner, 'PUT', chat, { commandId }), { id: chatId });
      const messageId = randomUUID(),
        send = {
          commandId: randomUUID(),
          parts: [
            { kind: 'text', text: ' hello ' },
            { kind: 'text', text: '👩🏽‍🌾' },
          ],
        };
      const [accepted, duplicate] = await Promise.all([
        request(owner, 'PUT', `${chat}/messages/${messageId}`, send),
        request(owner, 'PUT', `${chat}/messages/${messageId}`, send),
      ]);
      assert.deepEqual(accepted, duplicate);
      await request(
        owner,
        'PUT',
        `${chat}/messages/${messageId}`,
        { ...send, parts: [{ kind: 'text', text: 'changed' }] },
        409,
      );
      await request(owner, 'PUT', `${chat}/messages/${randomUUID()}`, { ...send, author: 'assistant' }, 400);
      await request(
        owner,
        'PUT',
        `${chat}/messages/${randomUUID()}`,
        { commandId: randomUUID(), parts: [{ kind: 'text', text: 'x'.repeat(65537) }] },
        400,
      );
      await request(
        owner,
        'PUT',
        `${chat}/messages/${randomUUID()}`,
        { commandId: randomUUID(), parts: [{ kind: 'text', text: 'x'.repeat(1100000) }] },
        413,
      );
      await request(owner, 'GET', `${base}?cursor=not-json`, undefined, 400);
      const invalidDate = Buffer.from(
        JSON.stringify({ activityAt: '2026-99-99T00:00:00.000000Z', id: chatId }),
      ).toString('base64url');
      await request(owner, 'GET', `${base}?cursor=${invalidDate}`, undefined, 400);
      await request(owner, 'GET', `${chat}/messages?before=9999999999`, undefined, 400);
      for (const path of [chat, `${chat}/messages`, `${base}/${randomUUID()}`])
        assert.deepEqual(await request(other, 'GET', path, undefined, 404), { error: 'conversation-not-found' });
      assert.deepEqual((await request(other, 'GET', base)).chats, []);
      await request(owner, 'GET', `/v1/workspaces/${b.id}/conversations/${chatId}`, undefined, 404);
      assert.equal(await executor.process((await executor.due(a.id))[0]), 'completed');
      let history = await request(owner, 'GET', `${chat}/messages`);
      assert.deepEqual(
        history.messages.map(message => message.parts.map(part => part.text).join('')),
        [' hello 👩🏽‍🌾', '👩🏽‍🌾 olleh '],
      );
      assert.deepEqual(history.messages[0].turn, { id: accepted.turnId, status: 'completed', generation: 0 });
      assert.deepEqual(
        await request(owner, 'PATCH', chat, { commandId: randomUUID(), title: 'Saved %_ title', expectedRevision: 1 }),
        { titleRevision: 2 },
      );
      await request(owner, 'PATCH', chat, { commandId: randomUUID(), title: 'Stale', expectedRevision: 1 }, 409);
      assert.equal((await request(owner, 'GET', `${base}?query=${encodeURIComponent('%_')}`)).chats[0].id, chatId);
      await request(owner, 'PATCH', chat, { commandId: randomUUID(), archived: true });
      assert.deepEqual((await request(owner, 'GET', base)).chats, []);
      assert.equal((await request(owner, 'GET', `${base}?archived=true`)).chats[0].id, chatId);
      await request(owner, 'PATCH', chat, { commandId: randomUUID(), archived: false });
      const next = await request(owner, 'PUT', `${chat}/messages/${randomUUID()}`, {
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: 'retry' }],
      });
      const work = (await executor.due(a.id))[0];
      const staleFence = await executor.claim(work);
      await db.platform.query(
        `UPDATE ${table('tf_conversation_turns')} SET status = 'failed', lease_until = NULL WHERE id = $1`,
        [next.turnId],
      );
      const retry = { commandId: randomUUID(), expectedGeneration: 0 };
      const retryPath = `${chat}/turns/${next.turnId}/retry`;
      const retried = await request(owner, 'POST', retryPath, retry);
      assert.deepEqual(retried, { turnId: next.turnId, status: 'queued', generation: 1 });
      assert.deepEqual(await request(owner, 'POST', retryPath, retry), retried);
      await request(other, 'POST', retryPath, retry, 404);
      await request(owner, 'POST', retryPath, { ...retry, commandId: randomUUID() }, 409);
      assert.equal(await executor.complete(staleFence), 'stale');
      const newFence = await executor.claim({ ...work, generation: 1 });
      const cancel = { commandId: randomUUID(), expectedGeneration: 1 };
      const cancelPath = `${chat}/turns/${next.turnId}/cancel`;
      const cancelled = await request(owner, 'POST', cancelPath, cancel);
      assert.deepEqual(cancelled, { turnId: next.turnId, status: 'cancelled', generation: 2 });
      assert.deepEqual(await request(owner, 'POST', cancelPath, cancel), cancelled);
      assert.equal(await executor.complete(newFence), 'stale');
      await request(
        owner,
        'POST',
        `${chat}/turns/${accepted.turnId}/cancel`,
        { commandId: randomUUID(), expectedGeneration: 0 },
        409,
      );
      await request(
        owner,
        'POST',
        `${chat}/turns/${randomUUID()}/cancel`,
        { commandId: randomUUID(), expectedGeneration: 0 },
        404,
      );
      await request(owner, 'POST', `${chat}/turns/${next.turnId}/cancel`, { ...cancel, action: 'approve' }, 400);
      const queued = await request(owner, 'PUT', `${chat}/messages/${randomUUID()}`, {
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: 'skip this' }],
      });
      const later = await request(owner, 'PUT', `${chat}/messages/${randomUUID()}`, {
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: 'keep this' }],
      });
      await request(owner, 'POST', `${chat}/turns/${queued.turnId}/cancel`, {
        commandId: randomUUID(),
        expectedGeneration: 0,
      });
      assert.equal((await executor.due(a.id))[0].turnId, later.turnId);
      assert.equal(await executor.process((await executor.due(a.id))[0]), 'completed');
      const waiting = await request(owner, 'PUT', `${chat}/messages/${randomUUID()}`, {
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: 'domain-owned wait' }],
      });
      await db.platform.query(`UPDATE ${table('tf_conversation_turns')} SET status = 'waiting' WHERE id = $1`, [
        waiting.turnId,
      ]);
      await request(
        owner,
        'POST',
        `${chat}/turns/${waiting.turnId}/cancel`,
        { commandId: randomUUID(), expectedGeneration: 0 },
        409,
      );
      await db.platform.query(`UPDATE ${table('tf_conversation_turns')} SET status = 'reconciling' WHERE id = $1`, [
        waiting.turnId,
      ]);
      await request(
        owner,
        'POST',
        `${chat}/turns/${waiting.turnId}/retry`,
        { commandId: randomUUID(), expectedGeneration: 0 },
        409,
      );
      await db.platform.query(`UPDATE ${table('tf_conversation_turns')} SET status = 'failed' WHERE id = $1`, [
        waiting.turnId,
      ]);
      const race = await Promise.all([
        fetch(`${address}${chat}/turns/${waiting.turnId}/retry`, {
          method: 'POST',
          headers: { cookie: owner.cookie, origin: 'http://localhost:5173', 'content-type': 'application/json' },
          body: JSON.stringify({ commandId: randomUUID(), expectedGeneration: 0 }),
        }),
        fetch(`${address}${chat}/turns/${waiting.turnId}/cancel`, {
          method: 'POST',
          headers: { cookie: owner.cookie, origin: 'http://localhost:5173', 'content-type': 'application/json' },
          body: JSON.stringify({ commandId: randomUUID(), expectedGeneration: 0 }),
        }),
      ]);
      assert.deepEqual(race.map(response => response.status).sort(), [200, 409]);
      for (const response of race) await response.json();
      for (let index = 0; index < 51; index++)
        await service.create(a.id, owner.id, { chatId: randomUUID(), commandId: randomUUID() });
      const page = await request(owner, 'GET', base);
      assert.equal(page.chats.length, 50);
      assert.equal(typeof page.nextCursor, 'string');
      const older = await request(owner, 'GET', `${base}?cursor=${page.nextCursor}`);
      assert.equal(older.chats.length, 2);
      assert.equal(older.nextCursor, null);
      assert.equal(new Set([...page.chats, ...older.chats].map(item => item.id)).size, 52);
      await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=0`);
      assert.equal((await request(owner, 'GET', creditPath)).available, 0);
      assert.deepEqual(await request(owner, 'PUT', `${base}/${randomUUID()}`, { commandId: randomUUID() }, 409), {
        error: 'credits-exhausted',
      });
      assert.deepEqual(
        await request(
          owner,
          'PUT',
          `${chat}/messages/${randomUUID()}`,
          { commandId: randomUUID(), parts: [{ kind: 'text', text: 'No free inference' }] },
          409,
        ),
        { error: 'credits-exhausted' },
      );
      assert.equal((await request(owner, 'GET', `${chat}/messages`)).messages.length > 0, true);
      assert.equal((await request(owner, 'GET', `/v1/workspaces/${b.id}/credits`)).available, 1000);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
        a.membershipId,
      ]);
      await request(owner, 'GET', creditPath, undefined, 404);
      await request(owner, 'GET', chat, undefined, 404);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        owner.id,
      ]);
      await request(owner, 'PUT', chat, { commandId }, 404);
      await request(owner, 'POST', cancelPath, cancel, 404);
      assert.deepEqual((await request(owner, 'GET', base)).chats, []);
      assert.deepEqual(
        Object.keys(app.swagger().paths['/v1/workspaces/{workspaceId}/conversations/{chatId}/messages/{messageId}']),
        ['put'],
      );
    } finally {
      await app.close();
      await runtime?.close();
      await identity?.end();
      if (roleCreated) {
        await db.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
        await db.admin.query(`DROP ROLE ${escapeIdentifier(role)}`);
      }
      await db.close();
    }
  },
);
