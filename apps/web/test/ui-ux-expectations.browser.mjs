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
      if (p.endsWith('/provider-integrations/test')) {
        if (state.testHold) await state.testHold;
        return state.testFailure ? send({ error: 'credentials' }, 409) : send({ verified: true });
      }
      if (p.endsWith('/provider-integrations/resources')) {
        if (state.resourceHold) await state.resourceHold;
        if (state.resourceFailure) return send({ error: 'permission' }, 409);
        const choices = {
          teamId: [{ value: 'T0123ABC', label: 'Operations' }],
          channelId: [
            { value: 'C0123ABC', label: 'ops' },
            { value: 'COTHER', label: 'support' },
          ],
          spreadsheetId: [{ value: 'sheet1', label: 'Orders' }],
          formId: [{ value: 'form1', label: 'Intake' }],
          dataSourceId: [{ value: id(5), label: 'Tasks data source' }],
          emailAddress: [{ value: 'ops@example.com', label: 'ops@example.com' }],
          labelId: [{ value: 'INBOX', label: 'Inbox' }],
          cloudId: [{ value: id(6), label: 'Operations site' }],
          projectKey: [{ value: 'OPS', label: 'Operations project' }],
          portalId: [{ value: '123', label: 'HubSpot portal 123' }],
        };
        return send({ items: state.emptyResources ? [] : choices[body.resource], nextCursor: null });
      }
      if (p.endsWith('/provider-integrations')) {
        state.integrations = [
          {
            id: body.id,
            name: body.name,
            source: body.source,
            generation: 1,
            enabled: true,
            authorized: true,
            capabilities: { use: true, manage: true, rotate: true },
          },
        ];
        return send({ saved: true });
      }
      if (request.method() === 'PATCH' && p.includes('/provider-integrations/')) {
        state.integrations[0].generation++;
        return send({ saved: true });
      }
      return p.endsWith('/provider-integrations') ? send({ ok: true }) : send({ error: 'unexpected-write' }, 500);
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
    if (p.endsWith('/provider-integrations')) return send(state.integrations ?? []);
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

test(
  'provider fields list sources, test before saving, reject stale results and test rotation',
  { timeout: 120000 },
  async () => {
    const { page, errors, state, close } = await open('/acme/workflows?provider=slack');
    const tokenInput = page.getByLabel('Bearer token for new source or rotation', { exact: true });
    const connect = page.getByRole('button', { name: 'Connect provider source', exact: true });
    const choose = async (label, option) => {
      await page.getByRole('button', { name: `Load ${label.toLowerCase()}`, exact: true }).click();
      await page.getByLabel(label, { exact: true }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    };
    try {
      await page.getByRole('heading', { name: 'Advanced workflow inputs', exact: true }).waitFor();
      await page.getByLabel('Source name', { exact: true }).fill('Ops channel');
      assert.equal(await connect.isDisabled(), true);
      await tokenInput.fill('xoxb-fixture');
      await choose('Slack workspace ID', 'Operations');
      state.resourceFailure = true;
      await page.getByRole('button', { name: 'Load conversation id', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'The token cannot read this source.' }).waitFor();
      assert.equal(await tokenInput.inputValue(), 'xoxb-fixture');
      state.resourceFailure = false;
      await choose('Conversation ID', 'ops');
      state.testFailure = true;
      await page.getByRole('button', { name: 'Test integration', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'The token is invalid or expired.' }).waitFor();
      assert.equal(await connect.isDisabled(), true);
      state.testFailure = false;
      let release;
      state.testHold = new Promise(resolve => {
        release = resolve;
      });
      await page.getByRole('button', { name: 'Test integration', exact: true }).click();
      await page.getByRole('button', { name: 'Testing integration…', exact: true }).waitFor();
      await tokenInput.fill('replacement-fixture');
      release();
      state.testHold = null;
      await delay(100);
      assert.equal(await page.getByText(/Integration test succeeded/).count(), 0);
      assert.equal(await connect.isDisabled(), true);
      await page.getByRole('button', { name: 'Test integration', exact: true }).click();
      await page.getByText(/Integration test succeeded/).waitFor();
      await page.getByRole('checkbox').check();
      await choose('Slack workspace ID', 'Operations');
      await choose('Conversation ID', 'support');
      assert.equal(await connect.isDisabled(), true, 'changing the source invalidates the test');
      await evidence(page, '876-provider-picker', async () => {
        await page.getByLabel('Conversation ID', { exact: true }).click();
        await page.getByRole('option', { name: 'support', exact: true }).waitFor();
      });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Test integration', exact: true }).click();
      await page.getByText(/Integration test succeeded/).waitFor();
      await evidence(page, '876-provider-tested', async () => {
        assert.equal(await connect.isEnabled(), true);
        await page.locator('#provider-name').evaluate(element => element.scrollIntoView({ block: 'start' }));
      });
      await connect.click();
      // Cloud 4a3eb8e3 #1021: the workflows page offers no trigger picker, so saving points to chat (pages/workflow-providers.tsx:62, pages/workflows.tsx:145).
      await page
        .getByText('Connected source saved. Create or edit a workflow in chat to use it.', { exact: true })
        .waitFor();
      assert.equal(await tokenInput.inputValue(), '');
      const saved = state.writes.filter(write => write.path.endsWith('/provider-integrations'));
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0].body.source, {
        provider: 'slack',
        teamId: 'T0123ABC',
        channelId: 'COTHER',
        conversation: 'public',
      });
      await tokenInput.fill('rotation-fixture');
      const rotate = page.getByRole('button', { name: 'Rotate token for Ops channel', exact: true });
      assert.equal(await rotate.isDisabled(), true);
      await page.getByRole('button', { name: 'Test replacement token for Ops channel', exact: true }).click();
      await page.getByText(/Integration test succeeded for the selected saved source/).waitFor();
      await rotate.click();
      await page.waitForFunction(() => document.querySelector('#provider-token')?.value === '');
      assert.equal(state.integrations[0].generation, 2);
      // 'Use <source>' only exists beside a trigger picker (pages/workflow-providers.tsx:164); the saved row names the source.
      await evidence(page, '876-provider-saved', async () => {
        await page.getByText('Ops channel · slack · Enabled', { exact: true }).scrollIntoViewIfNeeded();
      });

      for (const [provider, fields] of [
        ['Google Sheets', [['Spreadsheet ID', 'Orders']]],
        ['Notion', [['Data source ID', 'Tasks data source']]],
        [
          'Gmail',
          [
            ['Gmail account email', 'ops@example.com'],
            ['Gmail label ID', 'Inbox'],
          ],
        ],
        ['Google Forms', [['Google Form ID', 'Intake']]],
        [
          'Jira',
          [
            ['Jira cloud ID', 'Operations site'],
            ['Jira project key', 'Operations project'],
          ],
        ],
        ['HubSpot', [['HubSpot portal ID', 'HubSpot portal 123']]],
      ]) {
        await page.getByRole('button', { name: provider, exact: true }).click();
        await tokenInput.fill('directory-fixture');
        for (const [label, option] of fields) await choose(label, option);
        assert.equal(await connect.isDisabled(), true);
      }
      await page.getByRole('button', { name: 'Google Forms', exact: true }).click();
      await tokenInput.fill('empty-fixture');
      state.emptyResources = true;
      await page.getByRole('button', { name: 'Load google form id', exact: true }).click();
      await page.getByText(/No choices on this page/).waitFor();
      state.emptyResources = false;
      state.resourceHold = new Promise(resolve => {
        release = resolve;
      });
      await page.getByRole('button', { name: 'Load google form id', exact: true }).click();
      await page.getByText('Loading google form id choices.', { exact: true }).waitFor();
      await tokenInput.fill('different-directory-fixture');
      release();
      state.resourceHold = null;
      await delay(100);
      assert.equal(await page.getByLabel('Google Form ID', { exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Enter google form id manually', exact: true }).click();
      await page.getByLabel('Google Form ID', { exact: true }).fill('invalid form url');
      const before = state.writes.length;
      await page.getByRole('button', { name: 'Test integration', exact: true }).click();
      await page.getByText('Check the source fields and token before testing.', { exact: true }).waitFor();
      assert.equal(state.writes.length, before);
      assert.equal(await connect.isDisabled(), true);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
