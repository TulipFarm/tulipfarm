import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { shellRead } from './shell-reads.mjs';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

/** The API origin of the development build. Every tab of one browser context shares its cookie jar, as tabs of one profile do. */
const api = 'http://localhost:3001';
let server, browser, origin;

before(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    envDir: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * Two members of one workspace, Ann (the owner) and Ben (an admin), with real sessions against the real Files API.
 * Requests carry whatever cookie the shared jar holds when they start, so replacing it in one tab changes who every tab sends as.
 */
async function profile(t) {
  const f = await knowledgeFixture();
  t.after(() => f.close());
  const ann = f.signed.owner,
    ben = f.signed.admin;
  for (const [id, name] of [
    [ann.id, 'Ann Owner'],
    [ben.id, 'Ben Admin'],
  ])
    await f.db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [id, name]);
  const { workspace } = createWorkspaceFixture({
    id: f.workspace.id,
    userId: ann.id,
    slug: 'files-session',
    name: 'Files session',
  });
  const files = `/v1/workspaces/${workspace.id}/files`;
  const memberships = new Map([
    [ann.id, f.workspace.membershipId],
    [ben.id, f.adminMembership],
  ]);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const errors = [],
    sent = [],
    held = new Map();
  let afterSessionRead;
  const jar = async () => (await context.cookies(api)).map(({ name, value }) => `${name}=${value}`).join('; ');
  const signIn = async cookie => {
    await context.clearCookies();
    await context.addCookies(
      cookie
        .split('; ')
        .map(pair => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: api })),
    );
  };
  await signIn(ann.cookie);
  await context.addInitScript(() => {
    window.queryNotices = [];
    new BroadcastChannel('tulipfarm:query:v1').onmessage = event => window.queryNotices.push(event.data);
  });
  await context.route('**/v1/**', async route => {
    try {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname,
        method = request.method();
      const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
      if (method === 'OPTIONS')
        return await route.fulfill({
          status: 204,
          headers: {
            ...cors,
            'access-control-allow-methods': 'GET,POST,PUT,PATCH,OPTIONS',
            'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? 'content-type',
          },
        });
      const cookie = await jar();
      const session = cookie ? await f.signed.auth.api.getSession({ headers: new Headers({ cookie }) }) : null;
      if (path === '/v1/auth/get-session') {
        const swap = afterSessionRead;
        afterSessionRead = undefined;
        if (swap) await swap();
        return await route.fulfill({ json: session, headers: cors });
      }
      if (path === '/v1/auth/sign-out') {
        if (session) await f.signed.auth.api.signOut({ headers: new Headers({ cookie }) });
        await context.clearCookies();
        return await route.fulfill({ json: { success: true }, headers: cors });
      }
      if (path === '/v1/auth/options') return await route.fulfill({ json: { turnstileSiteKey: null }, headers: cors });
      if (path.startsWith(files)) {
        const upload =
          method === 'PUT' && path.endsWith('/content')
            ? { name: url.searchParams.get('name'), as: session?.user.id ?? null }
            : null;
        const gate = upload && held.get(upload.name);
        if (gate) {
          held.delete(upload.name);
          gate.reached();
          await gate.released;
        }
        const forwarded = Object.fromEntries(
          Object.entries(request.headers()).filter(
            ([name]) => name === 'content-type' || name.startsWith('x-tulipfarm-'),
          ),
        );
        const body = request.postDataBuffer();
        const response = await fetch(`${f.origin}${path}${url.search}`, {
          method,
          headers: { ...forwarded, cookie, origin: 'http://localhost:5173' },
          ...(body === null ? {} : { body }),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (upload)
          sent.push({
            ...upload,
            status: response.status,
            error: response.ok ? null : JSON.parse(bytes.toString()).error,
          });
        return await route.fulfill({
          status: response.status,
          body: bytes,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json', ...cors },
        });
      }
      if (!session) return await route.fulfill({ status: 401, json: { error: 'sign-in-required' }, headers: cors });
      if (await serveWorkspaceShellEvent(route, workspace)) return;
      const shell = new Map([
        ...workspaceShellReads(workspace.id),
        ['/v1/feature-flags', {}],
        ['/v1/user/visit', { firstSession: false }],
        ['/v1/workspaces', [workspace]],
        [`/v1/workspaces/${workspace.slug}`, workspace],
        [
          `/v1/workspaces/${workspace.id}/governance/me`,
          {
            membershipId: memberships.get(session.user.id),
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          },
        ],
        [
          `/v1/workspaces/${workspace.id}/credits`,
          { scope: 'workspace', available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
        ],
        [`/v1/workspaces/${workspace.id}/projects`, []],
        [`/v1/workspaces/${workspace.id}/model-catalog`, { families: [] }],
        ['/v1/google-workspace/availability', { configured: true }],
        [`/v1/workspaces/${workspace.id}/google-workspace`, { status: 'disconnected' }],
      ]);
      const neutral = shell.has(path) ? undefined : shellRead(method, path, workspace);
      if (neutral) return await route.fulfill({ ...neutral, headers: cors });
      assert.ok(shell.has(path), `Unexpected browser route ${method} ${path}`);
      return await route.fulfill({ json: shell.get(path), headers: cors });
    } catch (error) {
      errors.push(error);
      await route.abort().catch(() => {});
    }
  });
  const readme = randomUUID();
  assert.equal(
    (
      await f.call(
        `${files}/${readme}/content?${new URLSearchParams({ name: 'Readme.txt', mediaType: 'text/plain', parentId: 'null' })}`,
        { method: 'PUT', cookie: ann.cookie, body: Buffer.from('Read me first') },
      )
    ).status,
    200,
  );
  async function tab() {
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error));
    return page;
  }
  return {
    ann,
    ben,
    workspace,
    errors,
    sent,
    signIn,
    tab,
    swapAfterNextSessionRead: cookie => {
      afterSessionRead = () => signIn(cookie);
    },
    /** Names in a member's My files, read straight from the API. */
    mine: async cookie =>
      (await f.call(`${files}/library?${new URLSearchParams({ section: 'mine' })}`, { cookie }))
        .json()
        .items.map(item => item.name)
        .sort(),
    /** Holds the named upload after its request starts, until released. */
    hold(name) {
      let reached, release;
      const gate = {
        reached: new Promise(resolve => {
          reached = resolve;
        }),
        released: new Promise(resolve => {
          release = resolve;
        }),
      };
      held.set(name, { reached, released: gate.released });
      return { reached: gate.reached, release };
    },
    /** Opens My files and waits for its listing: Ann sees her Readme, Ben has nothing yet. */
    async openFiles(page, ready = 'link') {
      await page.goto(`${origin}/${workspace.slug}/files`);
      await (
        ready === 'link'
          ? page.getByRole('link', { name: 'Readme.txt' })
          : page.getByText('No files yet', { exact: true })
      ).waitFor();
    },
    async drop(page, names) {
      const transfer = await page.evaluateHandle(names => {
        const transfer = new DataTransfer();
        for (const name of names) transfer.items.add(new File([`${name} body`], name, { type: 'text/plain' }));
        return transfer;
      }, names);
      const list = page.getByRole('region', { name: 'My files' });
      for (const type of ['dragenter', 'dragover', 'drop']) await list.dispatchEvent(type, { dataTransfer: transfer });
    },
    /** Opens a file in the same document, so the Files page that queued uploads unmounts while the queue keeps running. */
    async openReadme(page) {
      await page.getByRole('link', { name: 'Readme.txt' }).click();
      await page.getByRole('heading', { name: 'Readme.txt', level: 1 }).waitFor({ state: 'attached' });
    },
    /** Resolves once the named upload's response has been delivered to the browser, or after a bounded wait. */
    async settled(name, timeout = 20000) {
      const start = Date.now();
      while (!sent.some(entry => entry.name === name)) {
        assert.ok(Date.now() - start < timeout, `${name} never reached the API`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    },
  };
}

/** Lets a settled upload's response reach the queue, then gives a following dispatch time to start. */
const quiet = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1500)));

test('queued uploads keep sending while the same session moves between Files pages', { timeout: 240000 }, async t => {
  const p = await profile(t);
  const page = await p.tab();
  await p.openFiles(page);
  const alpha = p.hold('Alpha.txt');
  await p.drop(page, ['Alpha.txt', 'Beta.txt']);
  await alpha.reached;
  await page.getByText('Waiting · My files', { exact: true }).waitFor();
  await p.openReadme(page);
  alpha.release();
  await p.settled('Beta.txt');
  assert.deepEqual(
    p.sent.map(({ name, as, status }) => [name, as, status]),
    [
      ['Alpha.txt', p.ann.id, 200],
      ['Beta.txt', p.ann.id, 200],
    ],
    'both uploads go out as Ann after the Files page unmounts',
  );
  await page.goBack();
  await page.getByText('2 files uploaded', { exact: true }).waitFor();
  assert.deepEqual(await p.mine(p.ann.cookie), ['Alpha.txt', 'Beta.txt', 'Readme.txt']);
  assert.deepEqual(p.errors, []);
});

test('a sign-in in another tab cannot send the uploads Ann queued as Ben', { timeout: 240000 }, async t => {
  const p = await profile(t);
  const page = await p.tab();
  await p.openFiles(page);
  const one = p.hold('One.txt');
  await p.drop(page, ['One.txt', 'Two.txt', 'Three.txt']);
  await one.reached;
  await p.openReadme(page);
  await p.signIn(p.ben.cookie);
  const other = await p.tab();
  await p.openFiles(other, 'empty');
  one.release();
  await quiet(page);
  assert.deepEqual(await p.mine(p.ben.cookie), [], 'none of Ann’s files became Ben’s');
  assert.deepEqual(
    p.sent.map(({ name, as, status, error }) => [name, as, status, error]),
    [['One.txt', p.ann.id, 200, null]],
    'the queue checks the current session before dispatching the next upload',
  );
  assert.deepEqual(await p.mine(p.ann.cookie), ['One.txt', 'Readme.txt']);
  assert.deepEqual(p.errors, []);
});

test('the API refuses an upload when the cookie changes after the queue session read', { timeout: 240000 }, async t => {
  const p = await profile(t);
  const page = await p.tab();
  await p.openFiles(page);
  p.swapAfterNextSessionRead(p.ben.cookie);
  await p.drop(page, ['Race.txt']);
  await p.settled('Race.txt');
  await quiet(page);
  assert.deepEqual(
    p.sent.map(({ name, as, status, error }) => [name, as, status, error]),
    [['Race.txt', p.ben.id, 401, 'session-changed']],
    'the expected-session header lets the server reject the post-read cookie swap',
  );
  assert.deepEqual(await p.mine(p.ben.cookie), [], 'the mismatched upload stored nothing for Ben');
  assert.deepEqual(await p.mine(p.ann.cookie), ['Readme.txt'], 'the refused upload stored nothing for Ann');
  assert.deepEqual(p.errors, []);
});

test(
  'after another tab signs out and signs in as Ben, Ann’s queued uploads never leave the tab',
  { timeout: 240000 },
  async t => {
    const p = await profile(t);
    const page = await p.tab();
    await p.openFiles(page);
    const four = p.hold('Four.txt');
    await p.drop(page, ['Four.txt', 'Five.txt']);
    await four.reached;
    await p.openReadme(page);
    const other = await p.tab();
    await other.goto(`${origin}/logout`);
    await page.waitForURL(url => url.pathname === '/login');
    await p.signIn(p.ben.cookie);
    four.release();
    await p.settled('Four.txt');
    await quiet(page);
    assert.deepEqual(
      p.sent.map(({ name, as }) => [name, as]),
      [['Four.txt', p.ann.id]],
      'the waiting upload was not sent after the session ended',
    );
    assert.deepEqual(await p.mine(p.ben.cookie), []);
    assert.deepEqual(p.errors, []);
  },
);

test('logging out in the uploading tab stops its queued uploads', { timeout: 240000 }, async t => {
  const p = await profile(t);
  const page = await p.tab();
  await p.openFiles(page);
  const six = p.hold('Six.txt');
  await p.drop(page, ['Six.txt', 'Seven.txt']);
  await six.reached;
  const prompts = [];
  page.on('dialog', dialog => {
    prompts.push(dialog.type());
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForFunction(() => window.queryNotices.some(notice => notice.kind === 'logout'));
  assert.ok(
    prompts.length > 0 && prompts.every(type => type === 'beforeunload'),
    'the browser asked before leaving with an upload still sending, and the person stayed',
  );
  six.release();
  await p.settled('Six.txt');
  await quiet(page);
  assert.deepEqual(
    p.sent.map(({ name, as }) => [name, as]),
    [['Six.txt', p.ann.id]],
    'the waiting upload was not sent after logout',
  );
  assert.deepEqual(p.errors, []);
});
