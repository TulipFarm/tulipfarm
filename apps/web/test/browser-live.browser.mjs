import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits, governance } from './chat-query.fixture.mjs';

const chatId = '7a1f0c2e-5b3d-4c6a-9e8f-1d2c3b4a5f60';
const sessionId = '2b6e9d41-8c7f-4a3e-b5d2-6f1e0a9c8b74';
function chatHistory() {
  const tool = (id, name, label) => ({
    id,
    tool: name,
    status: 'completed',
    activity: null,
    presentation: { label, brand: null },
    web: null,
  });
  return [
    {
      id: '0c9a7b6e-1d2f-4e3a-8b5c-7d6e5f4a3b21',
      sequence: 1,
      author: 'human',
      createdAt: '2026-11-24T10:00:01.000Z',
      parts: [{ kind: 'text', text: 'Sign me up to the Orchid Club' }],
      turn: null,
      tools: [
        tool('4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8', 'browser.act', 'Using the browser'),
        tool('5f6a7b8c-9d0e-4f1a-b2c3-d4e5f6a7b8c9', 'browser.handoff', 'Asking you to take over the browser'),
      ],
      calendarResults: [],
    },
    {
      id: '1d0b8c7f-2e3a-4f4b-9c6d-8e7f6a5b4c32',
      sequence: 2,
      author: 'assistant',
      createdAt: '2026-11-24T10:00:09.000Z',
      parts: [{ kind: 'text', text: 'Please tick the terms box in the browser, then hand it back.' }],
      turn: null,
      tools: [],
      calendarResults: [],
    },
  ];
}

const chat = {
  id: chatId,
  title: 'Join the Orchid Club',
  titleRevision: 1,
  titleManual: false,
  archived: false,
  activityAt: '2026-11-24T10:00:00.000000Z',
  createdAt: '2026-11-24T10:00:00.000000Z',
  projectId: null,
};

/**
 * Opens the chat with a mocked API. `browser` is the browser's state, `started` whether it is running yet, and
 * `handle(path, method, request)` answers extra requests; return `undefined` to fall through.
 */
async function openChat(
  {
    browser: initial,
    started: startedAtOpen = true,
    handle = () => undefined,
    page: pagePath,
    history = chatHistory(),
    opens = !pagePath,
    events,
  },
  run,
) {
  const { workspace, session } = createWorkspaceFixture();
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const chromiumBrowser = await chromium.launch();
  const context = await chromiumBrowser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  // A blank 1280x800 page stands in for a screencast frame.
  const pixel = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 800 });
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const live = {
    state: { sessionId, ...initial },
    started: startedAtOpen,
    refusedStreams: [],
    controls: [],
    inputs: [],
    inputRequests: 0,
    stateReads: 0,
  };
  const base = `/v1/workspaces/${workspace.id}/conversations/${chatId}/browser`;
  const shell = new Map([
    ...workspaceShellReads(workspace.id),
    ['/v1/feature-flags', { 'browser-use': true }],
    ['/v1/auth/get-session', session],
    ['/v1/user/visit', { firstSession: false }],
    ['/v1/workspaces', [workspace]],
    [`/v1/workspaces/${workspace.slug}`, workspace],
  ]);
  const suffixes = [
    ['/governance/me', membership],
    ['/governance', governance],
    ['/credits', credits],
    ['/model-catalog', chatCatalog],
    ['/google-workspace/availability', { configured: false }],
    ['/google-workspace', { status: 'disconnected' }],
    ['/projects', []],
    ['/google-workspace/operations/proposals', { proposals: [], nextCursor: null }],
    ['/candidates', []],
    ['/integrations', { integrations: [] }],
    ['/selection', { accountId: null, generation: null, version: 0 }],
    ['/system-package-installations', { installations: [], nextCursor: null }],
  ];
  try {
    await page.route('**/v1/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const extra = await handle(path.replace(`/v1/workspaces/${workspace.id}`, ''), method, request, live);
      if (extra !== undefined) return route.fulfill(extra);
      if (path === `${base}/live`) {
        if (!live.started) {
          live.refusedStreams.push(Date.now());
          return route.fulfill({ status: 404, json: { error: 'browser-not-found' } });
        }
        const events = [
          `event: state\ndata: ${JSON.stringify(live.state)}\n\n`,
          `event: frame\ndata: ${JSON.stringify({ data: pixel, width: 1280, height: 800 })}\n\n`,
        ];
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: `retry: 60000\n${events.join('')}`,
        });
      }
      if (path === base && method === 'GET') {
        live.stateReads++;
        // The browser starts while the panel is waiting for it.
        if (live.refusedStreams.length > 0) live.started = true;
        return route.fulfill({ json: { browser: live.started ? live.state : null } });
      }
      if (path === `${base}/control` && method === 'POST') {
        const { controller } = request.postDataJSON();
        live.controls.push(controller);
        const person = controller === 'person';
        live.state = {
          ...live.state,
          controller,
          needsPerson: person ? live.state.needsPerson : null,
          signIn: person ? live.state.signIn : null,
          controlledBy: person ? session.user.id : null,
        };
        return route.fulfill({ json: { browser: live.state } });
      }
      if (path === `${base}/input` && method === 'POST') {
        live.inputRequests++;
        live.inputs.push(...[request.postDataJSON()].flat());
        // A round trip to the host, during which later inputs wait to go together.
        await new Promise(resolve => setTimeout(resolve, 100));
        return route.fulfill({ json: { ok: true } });
      }
      if (await serveWorkspaceShellEvent(route, workspace)) return;
      const body = shell.has(path) ? shell.get(path) : suffixes.find(([suffix]) => path.endsWith(suffix))?.[1];
      if (body !== undefined) return route.fulfill({ json: body });
      if (path.endsWith('/conversations/pinned')) return route.fulfill({ json: { chats: [] } });
      if (path.endsWith('/conversations') && method === 'GET')
        return route.fulfill({ json: { chats: [chat], nextCursor: null } });
      const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
      if (conversation && method === 'GET') {
        const rest = conversation[2] ?? '';
        if (rest === '/messages')
          return route.fulfill({ json: { messages: history, nextBefore: null, hasGitHubProposals: false } });
        if (!rest) return route.fulfill({ json: chat });
        if (rest === '/events')
          return events
            ? route.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 60000\n${events}` })
            : route.fulfill({ status: 204 });
        return route.fulfill({ json: [] });
      }
      if (method === 'GET') return route.fulfill({ status: 404, json: { error: 'not-found' } });
      throw new Error(`Unexpected API request ${method} ${path}`);
    });
    await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}/${pagePath ?? `chat/${chatId}`}`);
    if (opens)
      await page
        .getByRole('application', { name: /Browser screen/ })
        .locator('img')
        .waitFor();
    await run({ page, live, session });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await chromiumBrowser.close();
    await server.close();
  }
}

const composerHas = (page, text) =>
  page.waitForFunction(
    expected => document.querySelector('[aria-label="Message"]')?.textContent?.includes(expected),
    text,
  );

test(
  'the live browser opens when the agent asks for a person, waits for the browser to start, and lets the member take over and hand back',
  { timeout: 120000 },
  async () => {
    const browser = {
      url: 'https://orchid.example/join',
      title: 'Orchid Club sign up',
      controller: 'agent',
      needsPerson: 'Tick the terms box to accept the Orchid Club terms.',
      controlledBy: null,
      signIn: null,
      logins: [],
    };
    await openChat({ browser, started: false }, async ({ page, live }) => {
      assert.ok(live.refusedStreams.length >= 1, 'the panel opened before the browser had started');
      await page.getByText('The agent needs you').waitFor();
      await page.getByText('Tick the terms box to accept the Orchid Club terms.').waitFor();

      await page.getByRole('button', { name: 'Take over' }).click();
      await page.getByText('You’re in control. The agent waits until you hand back.').waitFor();
      assert.equal(await page.getByText('The agent needs you').count(), 0, 'the alert hides while the member acts');
      const screen = page.getByRole('application', { name: 'Browser screen. Click and type to use the page.' });
      await screen.waitFor();

      // A click at the centre of the screen lands at the centre of the page.
      const box = await screen.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expectInputs(live.inputs, 2);
      const [press, release] = live.inputs;
      assert.equal(press.type, 'mouse');
      assert.equal(press.event, 'mousePressed');
      assert.equal(release.event, 'mouseReleased');
      assert.ok(Math.abs(press.x - 640) <= 2 && Math.abs(press.y - 400) <= 2, JSON.stringify(press));

      // Fast typing goes in a few requests, in order, rather than two per key.
      await page.keyboard.type('orchids are lovely', { delay: 5 });
      await expectInputs(live.inputs, 2 + 2 * 'orchids are lovely'.length);
      const typed = live.inputs.filter(input => input.type === 'key' && input.event === 'keyDown');
      assert.equal(typed.map(input => input.text).join(''), 'orchids are lovely');
      assert.ok(live.inputRequests < 12, `typing took ${live.inputRequests} requests`);
      assert.equal(await page.getByText('Couldn’t reach the browser. Check your connection.').count(), 0);

      await page.getByRole('button', { name: 'Hand back to the agent' }).click();
      await page.getByRole('button', { name: 'Take over' }).waitFor();
      await composerHas(page, 'I’ve finished in the browser. Continue.');
      assert.deepEqual(live.controls, ['person', 'agent']);
      assert.equal(await page.getByRole('dialog').count(), 0, 'no save prompt without a sign-in');
    });
  },
);

const signInBrowser = {
  url: 'https://shop.example/sign-in',
  title: 'Sign in to Orchid Shop',
  controller: 'agent',
  needsPerson: 'Sign in to Orchid Shop, then hand the browser back.',
  signIn: 'shop.example',
  controlledBy: null,
  logins: [],
};
const savedLogin = {
  id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  name: 'Orchid Shop team',
  site: 'shop.example',
  ownerMembershipId: membership.membershipId,
  status: 'active',
  grants: [],
  canManage: true,
  canUse: true,
  createdAt: '2026-11-24T09:00:00.000Z',
  savedAt: '2026-11-24T09:00:00.000Z',
  lastUsedAt: null,
};

test(
  'a sign-in request offers the saved logins for the site and loads the chosen one',
  { timeout: 120000 },
  async () => {
    const listed = [];
    const loaded = [];
    await openChat(
      {
        browser: signInBrowser,
        handle: (path, method, request, live) => {
          if (path === '/browser-logins' && method === 'GET') {
            listed.push(new URL(request.url()).searchParams.get('site'));
            return {
              json: {
                enabled: true,
                logins: [savedLogin, { ...savedLogin, id: crypto.randomUUID(), name: 'Gone', status: 'suspended' }],
              },
            };
          }
          if (path === `/conversations/${chatId}/browser/logins/${savedLogin.id}/load` && method === 'POST') {
            loaded.push(savedLogin.id);
            live.state = {
              ...live.state,
              url: 'https://shop.example/account',
              needsPerson: null,
              signIn: null,
              logins: [{ id: savedLogin.id, site: 'shop.example', signedOut: false }],
            };
            return { json: { browser: live.state } };
          }
        },
      },
      async ({ page, live }) => {
        await page.getByText('Sign in to shop.example').waitFor();
        const logins = page.getByRole('list', { name: 'Saved logins for shop.example' });
        await logins.getByText('Orchid Shop team').waitFor();
        assert.equal(await logins.getByText('Gone').count(), 0, 'a suspended login is not offered');
        assert.equal(await page.getByText('The agent needs you').count(), 0, 'the picker replaces the generic alert');
        assert.deepEqual([...new Set(listed)], ['shop.example']);

        await page.getByRole('button', { name: 'Use this login' }).click();
        await composerHas(page, 'shop.example');
        assert.deepEqual(loaded, [savedLogin.id]);
        assert.deepEqual(live.controls, [], 'loading a login needs no take over');
        await page.getByRole('button', { name: 'Take over' }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Use this login' }).count(), 0);
      },
    );
  },
);

test('saved logins sharing a name say who saved them and when', { timeout: 120000 }, async () => {
  const grace = governance.members[1];
  // Twenty minutes apart at midday UTC, so the same local date in every time zone.
  const mine = { ...savedLogin, createdAt: '2026-11-24T12:00:00.000Z' };
  const mineLater = { ...savedLogin, id: crypto.randomUUID(), createdAt: '2026-11-24T12:20:00.000Z' };
  const graces = {
    ...savedLogin,
    id: crypto.randomUUID(),
    ownerMembershipId: grace.id,
    status: 'needs-sign-in',
    canManage: false,
    createdAt: '2026-11-20T09:00:00.000Z',
  };
  const gone = { ...savedLogin, id: crypto.randomUUID(), ownerMembershipId: crypto.randomUUID() };
  let release;
  const directory = new Promise(resolve => (release = resolve));
  await openChat(
    {
      browser: signInBrowser,
      handle: async path => {
        if (path === '/browser-logins') return { json: { enabled: true, logins: [mine, mineLater, graces, gone] } };
        if (path === '/governance/directory') {
          await directory;
          return { json: { members: governance.members.map(member => ({ ...member, image: null })) } };
        }
      },
    },
    async ({ page }) => {
      const date = iso =>
        page.evaluate(
          value => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
          iso,
        );
      const time = iso =>
        page.evaluate(value => new Date(value).toLocaleTimeString(undefined, { timeStyle: 'short' }), iso);
      const logins = page.getByRole('list', { name: 'Saved logins for shop.example' });
      const on = async login => `${await date(login.createdAt)}, ${await time(login.createdAt)}`;
      await logins.getByText(`Saved on ${await date(graces.createdAt)}`).waitFor();
      await logins.getByText(`Saved by you on ${await on(mine)}`).waitFor();
      assert.equal(
        await logins.getByText('a former member').count(),
        0,
        'no one is called a former member before names load',
      );
      release();
      await logins.getByText(`Saved by you on ${await on(mineLater)}`).waitFor();
      await logins.getByText(`Saved by Grace on ${await date(graces.createdAt)}`).waitFor();
      await logins.getByText(`Saved by a former member on ${await date(gone.createdAt)}`).waitFor();
      const buttons = logins.getByRole('button', { name: 'Use this login' });
      assert.equal(await buttons.count(), 4);
      assert.equal(
        await buttons
          .nth(2)
          .getAttribute('aria-describedby')
          .then(ids =>
            page.evaluate(
              list =>
                list
                  .split(' ')
                  .map(id => document.getElementById(id)?.textContent)
                  .join(', '),
              ids,
            ),
          ),
        `Orchid Shop team, Signed out, Saved by Grace on ${await date(graces.createdAt)}`,
      );
    },
  );
});

for (const running of ['browser.act', 'browser.handoff'])
  test(
    `a browser call refused before any browser opened shows no browser, and a running ${running} opens it once it is open`,
    { timeout: 120000 },
    async () => {
      const step = (id, status, extra = {}, tool = 'browser.act') => ({
        id,
        tool,
        status,
        activity: null,
        presentation: { label: 'Using the browser', brand: null },
        web: null,
        ...extra,
      });
      const message = (id, sequence, author, text, turn, tools) => ({
        id,
        sequence,
        author,
        createdAt: `2026-11-24T10:00:0${sequence}.000Z`,
        parts: [{ kind: 'text', text }],
        turn,
        tools,
        calendarResults: [],
      });
      const history = [
        message('0c9a7b6e-1d2f-4e3a-8b5c-7d6e5f4a3b21', 1, 'human', 'Check the Orchid Club opening hours', null, [
          step('4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8', 'completed', {
            activityStatus: 'failed',
            browserNotOpened: true,
          }),
        ]),
        message(
          '1d0b8c7f-2e3a-4f4b-9c6d-8e7f6a5b4c32',
          2,
          'assistant',
          'All browsers for this workspace are in use. I’ll try again shortly.',
          null,
          [],
        ),
        message(
          '2e1c9d8a-3f4b-4a5c-8d7e-9f8a7b6c5d43',
          3,
          'human',
          'Try again now',
          { id: '3f2d0e9b-4a5c-4b6d-9e8f-0a9b8c7d6e54', status: 'processing', generation: 1 },
          [step('5f6a7b8c-9d0e-4f1a-b2c3-d4e5f6a7b8c9', 'running', {}, running)],
        ),
      ];
      const browser = {
        url: 'https://orchid.example/hours',
        title: 'Orchid Club hours',
        controller: 'agent',
        needsPerson: null,
        controlledBy: null,
        signIn: null,
        logins: [],
      };
      await openChat({ browser, started: false, history, opens: false }, async ({ page, live }) => {
        await page.getByText('All browsers for this workspace are in use. I’ll try again shortly.').waitFor();
        // While the agent waits for a browser, none is open: the chat checks for one but shows nothing.
        await new Promise(resolve => setTimeout(resolve, 4000));
        assert.ok(live.stateReads >= 2, `the chat checked for an open browser (${live.stateReads})`);
        assert.equal(live.refusedStreams.length, 0, 'the panel did not open');
        assert.equal(await page.getByRole('button', { name: 'Show the browser' }).count(), 0);
        assert.equal(await page.getByText('The browser has closed').count(), 0);

        live.started = true;
        await page
          .getByRole('application', { name: /Browser screen/ })
          .locator('img')
          .waitFor();
      });
    },
  );

test(
  'a hand-off streamed for a turn not yet in the history opens the browser only once one exists',
  { timeout: 120000 },
  async () => {
    // The refusal's receipt hasn't been saved, so the completed event alone says nothing about whether a browser opened.
    const handoff = {
      turnId: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
      generation: 0,
      epoch: 1,
      id: '7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e',
      tool: 'browser.handoff',
      sequence: 1,
      status: 'completed',
      presentation: { label: 'Asking you to take over the browser', brand: null },
    };
    const history = chatHistory().slice(1);
    const browser = {
      url: 'https://orchid.example/join',
      title: 'Orchid Club sign up',
      controller: 'agent',
      needsPerson: 'Tick the terms box to accept the Orchid Club terms.',
      controlledBy: null,
      signIn: null,
      logins: [],
    };
    await openChat(
      { browser, started: false, history, opens: false, events: `event: tool\ndata: ${JSON.stringify(handoff)}\n\n` },
      async ({ page, live }) => {
        await page.getByText('Please tick the terms box in the browser, then hand it back.').waitFor();
        await new Promise(resolve => setTimeout(resolve, 4000));
        assert.ok(live.stateReads >= 2, `the chat checked for an open browser (${live.stateReads})`);
        assert.equal(live.refusedStreams.length, 0, 'the panel did not open');

        live.started = true;
        await page.getByText('The agent needs you').waitFor();
      },
    );
  },
);

test('a member who signs in themselves is offered to save the login on hand back', { timeout: 120000 }, async () => {
  const saved = [];
  await openChat(
    {
      browser: signInBrowser,
      handle: (path, method, request) => {
        if (path === '/browser-logins' && method === 'GET') return { json: { enabled: true, logins: [] } };
        if (path === `/conversations/${chatId}/browser/logins` && method === 'POST') {
          saved.push(request.postDataJSON());
          return { json: { ...savedLogin, name: request.postDataJSON().name } };
        }
      },
    },
    async ({ page, live }) => {
      await page.getByText('Sign in to shop.example').waitFor();
      await page.getByRole('button', { name: 'Sign in yourself' }).click();
      await page.getByText('You’re in control. The agent waits until you hand back.').waitFor();
      live.state = { ...live.state, url: 'https://shop.example/account', title: 'Your account' };

      await page.getByRole('button', { name: 'Hand back to the agent' }).click();
      const dialog = page.getByRole('dialog', { name: 'Save login' });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('textbox', { name: 'Site' }).inputValue(), 'shop.example');
      await dialog.getByRole('textbox', { name: 'Name' }).fill('Orchid Shop team');
      await dialog.getByRole('button', { name: 'Save login' }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.deepEqual(saved, [{ name: 'Orchid Shop team', site: 'shop.example' }]);
      assert.deepEqual(live.controls, ['person', 'agent']);
      await composerHas(page, 'I’ve finished in the browser. Continue.');
    },
  );
});

test('the browser logins settings page lists, renames and deletes logins', { timeout: 120000 }, async () => {
  const changes = [];
  let logins = [
    { ...savedLogin, lastUsedAt: '2026-11-24T09:30:00.000Z' },
    { ...savedLogin, id: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a', name: 'Old shop', status: 'needs-sign-in' },
  ];
  await openChat(
    {
      page: 'settings/browser-logins',
      browser: signInBrowser,
      handle: (path, method, request) => {
        if (path === '/browser-logins' && method === 'GET') return { json: { enabled: true, logins } };
        const one = /^\/browser-logins\/([\w-]+)$/.exec(path);
        if (one && method === 'PATCH') {
          const { name } = request.postDataJSON();
          changes.push(['rename', one[1], name]);
          logins = logins.map(login => (login.id === one[1] ? { ...login, name } : login));
          return { json: logins.find(login => login.id === one[1]) };
        }
        if (one && method === 'DELETE') {
          changes.push(['delete', one[1]]);
          logins = logins.filter(login => login.id !== one[1]);
          return { status: 204 };
        }
      },
    },
    async ({ page }) => {
      await page.getByText('Orchid Shop team').waitFor();
      await page.getByText('Signed out').waitFor();

      await page.getByRole('button', { name: 'Actions for Orchid Shop team' }).click();
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      await page.getByRole('dialog').getByRole('textbox', { name: 'Name' }).fill('Shop for the team');
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      await page.getByText('Shop for the team').waitFor();

      await page.getByRole('button', { name: 'Actions for Old shop' }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await page.getByRole('button', { name: 'Delete login' }).click();
      await page.getByRole('button', { name: 'Actions for Old shop' }).waitFor({ state: 'detached' });
      assert.deepEqual(changes, [
        ['rename', savedLogin.id, 'Shop for the team'],
        ['delete', '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a'],
      ]);
    },
  );
});

async function expectInputs(inputs, count) {
  const deadline = Date.now() + 5000;
  while (inputs.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(inputs.length, count, JSON.stringify(inputs));
}
