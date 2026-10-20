import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

export async function googleProviderFixture() {
  const calls = [];
  const state = {
    denyReader: false,
    listFailure: false,
    account: 'owner-account',
    version: '1',
    text: 'orchid supplier confidential terms',
    omitted: false,
    mailDate: '2026-01-15',
  };
  const root = {
    id: 'root',
    name: 'Selected folder',
    mimeType: 'application/vnd.google-apps.folder',
    version: '1',
    modifiedTime: '2026-01-01T00:00:00Z',
    trashed: false,
    parents: [],
  };
  const file = () => ({
    id: 'one',
    name: 'Supplier "terms"\r\n.txt',
    mimeType: 'text/plain',
    version: state.version,
    modifiedTime: '2026-01-01T00:00:00Z',
    trashed: false,
    parents: ['root'],
    size: String(Buffer.byteLength(state.text)),
    capabilities: { canDownload: true, canCopy: true },
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization,
    });
    function json(value, status = 200) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    }
    if (url.pathname === '/token')
      return json({
        access_token: body.get('code') ?? body.get('refresh_token'),
        refresh_token: body.get('code') ?? body.get('refresh_token'),
        token_type: 'Bearer',
        expires_in: 3600,
        scope:
          'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly',
      });
    if (url.pathname.endsWith('/userinfo'))
      return json({
        sub: request.headers.authorization === 'Bearer reader-token' ? 'reader-account' : state.account,
        email: 'fixture@example.test',
        email_verified: true,
      });
    if (url.pathname === '/revoke') {
      response.writeHead(200);
      return response.end();
    }
    if (!['Bearer owner-token', 'Bearer reader-token'].includes(request.headers.authorization))
      return json({ error: 'unauthorized' }, 401);
    if (state.denyReader && request.headers.authorization === 'Bearer reader-token')
      return json({ error: 'forbidden' }, 403);
    if (url.pathname === '/drive/v3/files/root') return json(root);
    if (url.pathname === '/drive/v3/files/one') {
      if (url.searchParams.get('alt') === 'media') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        return response.end(state.text);
      }
      return json(file());
    }
    if (url.pathname === '/drive/v3/files') {
      if (state.listFailure) return json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 429);
      return json({
        files: url.searchParams.get('q')?.includes("mimeType = '") ? [root] : state.omitted ? [] : [file()],
      });
    }
    if (url.pathname === '/drive/v3/drives') return json({ drives: [{ id: 'shared', name: 'Shared library' }] });
    if (url.pathname === '/gmail/v1/users/me/profile')
      return json({ emailAddress: 'fixture@example.test', historyId: '1' });
    if (url.pathname === '/gmail/v1/users/me/labels') return json({ labels: [{ id: 'INBOX', name: 'Inbox' }] });
    if (url.pathname === '/gmail/v1/users/me/labels/INBOX') return json({ id: 'INBOX', name: 'Inbox' });
    if (url.pathname === '/gmail/v1/users/me/messages') return json({ messages: [{ id: 'mailone' }] });
    if (url.pathname === '/gmail/v1/users/me/messages/mailone') {
      const text = 'orchid mailbox delivery terms';
      return json({
        id: 'mailone',
        threadId: 'threadone',
        labelIds: ['INBOX'],
        historyId: '1',
        internalDate: String(Date.parse(state.mailDate)),
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: 'Delivery mail' }],
          body: { size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') },
        },
      });
    }
    return json({ error: `Unexpected fixture path ${url.pathname}` }, 500);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const providerFetch = (input, init) => {
    const url = new URL(input);
    assert.ok(
      ['www.googleapis.com', 'gmail.googleapis.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com'].includes(
        url.hostname,
      ),
    );
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  };
  return {
    calls,
    state,
    providerFetch,
    options: {
      providerFetch,
      keyring: { activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } },
      config: {
        clientId: 'fixture-client',
        clientSecret: 'fixture-secret',
        redirectUri: 'http://localhost:3001/v1/google-workspace/callback',
      },
    },
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

export async function connectGoogle(f, who = f.signed.owner, code = 'owner-token') {
  const prefix = `/v1/workspaces/${f.workspace.id}/google-workspace`;
  const begin = await f.call(`${prefix}/begin?app=drive`, { method: 'POST', cookie: who.cookie });
  assert.equal(begin.status, 200, begin.bytes.toString());
  const state = new URL(begin.json().authorizationUrl).searchParams.get('state');
  const response = await fetch(`${f.origin}/v1/google-workspace/callback?${new URLSearchParams({ state, code })}`, {
    headers: { cookie: who.cookie },
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('outcome'), 'connected');
  return (await f.call(prefix, { cookie: who.cookie })).json();
}
