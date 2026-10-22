import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createAuth } from '../src/better-auth.ts';
import { fixture, loadPlatformBaseline } from '../../../packages/workspace-storage/test/integration/fixture.mjs';

test(
  'real OAuth callbacks seed profiles once and preserve local edits on later sign-in and linking',
  { timeout: 45000 },
  async t => {
    const previous = {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    };
    Object.assign(process.env, {
      GOOGLE_CLIENT_ID: 'fixture-google-client',
      GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    });
    t.after(() => {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    const db = await fixture();
    let pool;
    t.after(async () => {
      await pool?.end();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app', max: 2 });
    const deliveries = [],
      cookies = new Map();
    const auth = createAuth(
      pool,
      async ({ url }) => deliveries.push(url),
      async () => {},
    );
    const context = await auth.$context;
    const provider = context.socialProviders.find(provider => provider.id === 'google');
    assert.ok(provider);
    assert.equal(provider.options.overrideUserInfoOnSignIn, false);
    assert.equal(auth.options.account.accountLinking.updateUserInfoOnLink, false);
    let remote = {
      id: randomUUID(),
      email: `${randomUUID()}@example.test`,
      name: 'Google seed',
      image: 'https://example.test/google.png',
    };
    t.mock.method(provider, 'validateAuthorizationCode', async () => ({
      accessToken: 'fixture-access-token',
      scopes: ['openid', 'email', 'profile'],
    }));
    t.mock.method(provider, 'getUserInfo', async () => ({
      user: { ...remote, emailVerified: true },
      data: {
        id: remote.id,
        sub: remote.id,
        email: remote.email,
        email_verified: true,
        name: remote.name,
        picture: remote.image,
      },
    }));
    t.mock.method(globalThis, 'fetch', async () =>
      assert.fail('This provider fixture must not make an external request'),
    );
    const cookie = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const receive = response => {
      for (const header of response.headers.getSetCookie()) {
        const part = header.split(';')[0],
          split = part.indexOf('='),
          name = part.slice(0, split),
          value = part.slice(split + 1);
        if (value) cookies.set(name, value);
        else cookies.delete(name);
      }
      return response;
    };
    const request = async (path, body) =>
      receive(
        await auth.handler(
          new Request(`http://localhost:3001/v1/auth/${path}`, {
            method: body ? 'POST' : 'GET',
            headers: {
              origin: 'http://localhost:5173',
              cookie: cookie(),
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        ),
      );
    const oauth = async (path = 'sign-in/social') => {
      const start = await request(path, { provider: 'google', callbackURL: 'http://localhost:5173/account' });
      assert.equal(start.status, 200);
      const authorization = new URL((await start.json()).url);
      assert.equal(authorization.hostname, 'accounts.google.com');
      const response = await request(
        `callback/google?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`,
      );
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), 'http://localhost:5173/account');
    };
    const profile = async email =>
      (
        await pool.query('SELECT id,name,image,profile_revision::text AS revision FROM app.users WHERE email=$1', [
          email,
        ])
      ).rows[0];
    await oauth();
    const initial = await profile(remote.email);
    assert.equal(initial.name, 'Google seed');
    assert.equal(initial.image, remote.image);
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTH0AAAAASUVORK5CYII=';
    assert.equal((await request('update-user', { name: 'Local profile', image })).status, 200);
    const local = await profile(remote.email);
    assert.equal(local.revision, '2');
    assert.equal((await request('sign-out', {})).status, 200);
    remote = { ...remote, name: 'Changed Google name', image: 'https://example.test/changed.png' };
    await oauth();
    assert.deepEqual(await profile(remote.email), local);
    assert.equal(
      (await pool.query('SELECT revision::text FROM app.member_profile_outbox WHERE user_id=$1', [local.id])).rows[0]
        .revision,
      '2',
    );

    assert.equal((await request('sign-out', {})).status, 200);
    const email = `${randomUUID()}@example.test`;
    await auth.api.signInMagicLink({
      headers: new Headers({ origin: 'http://localhost:5173' }),
      body: { email, name: 'Email profile' },
    });
    receive(await auth.handler(new Request(deliveries.pop())));
    assert.equal((await request('update-user', { name: 'Keep on account linking', image })).status, 200);
    const beforeLink = await profile(email);
    remote = { id: randomUUID(), email, name: 'New Google account name', image: 'https://example.test/linked.png' };
    await oauth('link-social');
    assert.deepEqual(await profile(email), beforeLink);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM app.accounts WHERE user_id=$1 AND provider_id='google'",
          [beforeLink.id],
        )
      ).rows[0].count,
      1,
    );
  },
);
