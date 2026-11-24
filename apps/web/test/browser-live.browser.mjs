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

test(
  'the live browser opens when the agent asks for a person, waits for the browser to start, and lets the member take over and hand back',
  { timeout: 120000 },
  async () => {
    const { workspace, session } = createWorkspaceFixture();
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    });
    await server.listen();
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    // A blank 1280x800 page stands in for a screencast frame.
    const pixel = await page.evaluate(() => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 800 });
      return canvas.toDataURL('image/jpeg').split(',')[1];
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

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
    const history = chatHistory();
    // The browser has not started when the panel first opens.
    let started = false;
    let state = {
      sessionId,
      url: 'https://orchid.example/join',
      title: 'Orchid Club sign up',
      controller: 'agent',
      needsPerson: 'Tick the terms box to accept the Orchid Club terms.',
      controlledBy: null,
    };
    const refusedStreams = [];
    const controls = [];
    const inputs = [];
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
        if (path === `${base}/live`) {
          if (!started) {
            refusedStreams.push(Date.now());
            return route.fulfill({ status: 404, json: { error: 'browser-not-found' } });
          }
          const events = [
            `event: state\ndata: ${JSON.stringify(state)}\n\n`,
            `event: frame\ndata: ${JSON.stringify({ data: pixel, width: 1280, height: 800 })}\n\n`,
          ];
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: `retry: 60000\n${events.join('')}`,
          });
        }
        if (path === base && method === 'GET') {
          // The browser starts while the panel is waiting for it.
          if (refusedStreams.length > 0) started = true;
          return route.fulfill({ json: { browser: started ? state : null } });
        }
        if (path === `${base}/control` && method === 'POST') {
          const { controller } = request.postDataJSON();
          controls.push(controller);
          state = {
            ...state,
            controller,
            needsPerson: controller === 'person' ? state.needsPerson : null,
            controlledBy: controller === 'person' ? session.user.id : null,
          };
          return route.fulfill({ json: { browser: state } });
        }
        if (path === `${base}/input` && method === 'POST') {
          inputs.push(request.postDataJSON());
          return route.fulfill({ status: 204 });
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
          if (rest === '/events') return route.fulfill({ status: 204 });
          return route.fulfill({ json: [] });
        }
        if (method === 'GET') return route.fulfill({ status: 404, json: { error: 'not-found' } });
        throw new Error(`Unexpected API request ${method} ${path}`);
      });

      await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}/chat/${chatId}`);
      const screen = page.getByRole('application', { name: /Browser screen/ });
      await screen.locator('img').waitFor();
      assert.ok(refusedStreams.length >= 1, 'the panel opened before the browser had started');
      await page.getByText('The agent needs you').waitFor();
      await page.getByText('Tick the terms box to accept the Orchid Club terms.').waitFor();

      await page.getByRole('button', { name: 'Take over' }).click();
      await page.getByText('You’re in control. The agent waits until you hand back.').waitFor();
      assert.equal(await page.getByText('The agent needs you').count(), 0, 'the alert hides while the member acts');
      await page.getByRole('application', { name: 'Browser screen. Click and type to use the page.' }).waitFor();

      // A click at the centre of the screen lands at the centre of the page.
      const box = await screen.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expectInputs(inputs, 2);
      const [press, release] = inputs;
      assert.equal(press.type, 'mouse');
      assert.equal(press.event, 'mousePressed');
      assert.equal(release.event, 'mouseReleased');
      assert.ok(Math.abs(press.x - 640) <= 2 && Math.abs(press.y - 400) <= 2, JSON.stringify(press));

      await page.getByRole('button', { name: 'Hand back to the agent' }).click();
      await page.getByRole('button', { name: 'Take over' }).waitFor();
      await page.waitForFunction(() =>
        document
          .querySelector('[aria-label="Message"]')
          ?.textContent?.includes('I’ve finished in the browser. Continue.'),
      );
      assert.deepEqual(controls, ['person', 'agent']);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
);

async function expectInputs(inputs, count) {
  const deadline = Date.now() + 5000;
  while (inputs.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(inputs.length, count, JSON.stringify(inputs));
}
