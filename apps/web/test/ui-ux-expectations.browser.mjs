import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5465,
  origin = `http://127.0.0.1:${port}`;
const shots = process.env.UI_EXPECTATIONS_SCREENSHOTS;
const cdp = process.env.UI_EXPECTATIONS_CDP_PORT;
const id = n =>
  `${n}`.repeat(8) +
  '-' +
  `${n}`.repeat(4) +
  '-4' +
  `${n}`.repeat(3) +
  '-8' +
  `${n}`.repeat(3) +
  '-' +
  `${n}`.repeat(12);
const [wid, mid, tid, fid] = Array.from({ length: 4 }, (_, i) => id(i + 1));
const at = '2026-09-30T09:00:00Z';
const workspace = {
  id: wid,
  slug: 'acme',
  name: 'Acme Operations',
  status: 'ready',
  createdAt: at,
  soulCommit: 'a'.repeat(40),
};
const teams = [{ id: tid, name: 'Customer Operations', description: 'Customer support', membershipIds: [mid] }];
const file = {
  id: fid,
  kind: 'file',
  name: 'Pricing notes.txt',
  parentId: null,
  creatorMembershipId: mid,
  mediaType: 'text/plain',
  size: 120,
  trashed: false,
  role: 'manager',
  deletion: null,
};

function fixture(state) {
  return async route => {
    const request = route.request(),
      url = new URL(request.url()),
      p = url.pathname;
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (p === '/v1/user/visit') return send({ firstSession: false });
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      state.writes.push({ path: p, body });
      return send({ error: 'unexpected-write' }, 500);
    }
    if (p === '/v1/auth/get-session')
      return send({
        session: { id: 'fixture', userId: 'ada' },
        user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
      });
    if (p === '/v1/workspaces') return send([workspace]);
    if (p === '/v1/workspaces/acme') return send(workspace);
    if (p.endsWith('/credits'))
      return send({ available: 100, granted: 100, used: 0, held: 0, days: [], breakdown: [], series: [] });
    if (p.endsWith('/governance/me'))
      return send({
        membershipId: mid,
        role: 'admin',
        teams,
        capabilities: { manageGovernance: true, canLeave: true },
      });
    if (p.endsWith('/model-catalog')) return send(chatCatalog);
    if (p.endsWith('/events')) return send({ error: 'unavailable' }, 503);
    if (p.endsWith('/conversations')) return send({ chats: [], nextCursor: null });
    if (p.endsWith('/agent-tasks')) return send({ tasks: [], nextCursor: null });
    if (p.endsWith('/files')) return send({ items: url.searchParams.has('query') ? [file] : [] });
    if (p.endsWith('/files/suggestions')) return send({ items: [file], next: null });
    if (p.endsWith('/workflows')) return send([]);
    if (p.endsWith('/provider-integrations')) return send([]);
    if (p.endsWith('/grants')) return send([]);
    if (p.endsWith('/sharing-candidates')) return send({ membershipId: mid, people: [], teams: [] });
    return send({ error: 'fixture-unavailable' }, 404);
  };
}

let server, browser;
before(async () => {
  server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  for (
    let i = 0;
    !(await fetch(origin).then(
      r => r.ok,
      () => false,
    ));
    i++
  ) {
    if (i > 300) throw Error('Vite did not start');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
  if (shots) await mkdir(shots, { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

async function open(path) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const state = { writes: [] };
  await page.route('**/v1/**', fixture(state));
  await page.goto(origin + path);
  return { page, errors, state, close: () => context.close() };
}

// Records the screen even when an assertion fails, so a baseline run still produces its "before" evidence.
async function evidence(page, name, check) {
  try {
    await check();
  } finally {
    if (shots) {
      if (cdp)
        execFileSync(
          'agent-browser',
          ['--session', 'provider-integrations-876', '--cdp', cdp, 'screenshot', `${shots}/${name}.png`],
          { stdio: 'pipe' },
        );
      else await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }).catch(() => {});
    }
  }
}

test('a direct inbox link explains where waiting work lives today', async () => {
  const { page, errors, close } = await open('/acme/inbox');
  await evidence(page, 'a18-inbox', async () => {
    await page.getByRole('heading', { level: 1, name: 'Inbox isn’t available yet' }).waitFor();
    await page.getByText(/no single inbox yet/).waitFor();
    for (const [name, href] of [
      ['Open tasks', '/acme/agent-tasks'],
      ['Open workflows', '/acme/workflows'],
      ['Open chats', '/acme/chat'],
    ]) {
      // Sprout Button with nativeButton={false} keeps the link role (pages/workspace.tsx:394-396).
      assert.equal(await page.getByRole('link', { name, exact: true }).getAttribute('href'), href);
    }
  });
  assert.deepEqual(errors, []);
  await close();
});

test('the inbox keeps its own title while the next page is still loading', async () => {
  const { page, errors, close } = await open('/acme/inbox');
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  await page.route(/\/src\/pages\/agent-tasks\.tsx/, async route => {
    await held;
    await route.continue();
  });
  await page.getByRole('heading', { level: 1, name: 'Inbox isn’t available yet' }).waitFor();
  await page.getByRole('link', { name: 'Open tasks', exact: true }).click();
  await page.waitForURL(`${origin}/acme/agent-tasks`);
  await evidence(page, 'a18-inbox-leaving', async () => {
    // The lazy page shows the router's pending state, which has no page title (cloud 5e16bb45 #346, router.tsx:487-488).
    await page.getByRole('status').filter({ hasText: 'Opening TulipFarm…' }).waitFor();
    assert.deepEqual(await page.getByRole('heading', { level: 1 }).allTextContents(), []);
  });
  const headings = [];
  for (let i = 0; i < 15; i++) {
    headings.push(...(await page.getByRole('heading', { level: 1 }).allTextContents()));
    await delay(100);
  }
  assert.deepEqual(
    headings.filter(text => text !== 'Inbox isn’t available yet'),
    [],
    'no other page name appears in the inbox panel while the next page loads',
  );
  release();
  await evidence(page, 'a18-inbox-destination', async () => {
    await page.getByRole('heading', { level: 1, name: 'My agent tasks', exact: true }).waitFor();
    assert.equal(await page.getByText(/isn’t available yet/).count(), 0);
  });
  assert.deepEqual(errors, []);
  await close();
});

test('the add menu uploads, and @ lets the assistant read a saved file', async () => {
  const { page, errors, close } = await open('/acme');
  const renderErrors = [];
  page.on('console', message => {
    if (message.type() === 'error' && /Maximum update depth|flushSync/.test(message.text()))
      renderErrors.push(message.text());
  });
  await evidence(page, 'a17-file-choices', async () => {
    await page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('heading', { level: 2 }).waitFor();
    await page.getByRole('button', { name: 'Add files and more', exact: true }).click();
    const menu = page.getByRole('menu');
    await menu.getByRole('menuitem', { name: 'Upload from computer', exact: true }).waitFor();
    assert.equal(await menu.getByRole('menuitem').count(), 1);
  });
  await page.keyboard.press('Escape');
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.click();
  await message.pressSequentially('@');
  await evidence(page, 'a17-read-file', async () => {
    await page.getByRole('option', { name: /Pricing notes\.txt/ }).click();
    await page
      .getByText(
        'The assistant reads this file from Files for your requests in this chat, using your current access.',
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.locator('[contenteditable="true"]').getByText('Pricing notes.txt', { exact: true }).count(),
      1,
    );
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(renderErrors, []);
  await close();
});
