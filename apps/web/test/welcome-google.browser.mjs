import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { toolPresentation } from '@tulipfarm/conversations/tool-activity';
import { googleAppScopes } from '@tulipfarm/google-workspace/public-contracts';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const port = Number(process.env.WELCOME_GOOGLE_PORT ?? 5487);
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const fixture = createWorkspaceFixture();
const second = createWorkspaceFixture({ slug: 'second-workspace', name: 'Second workspace' }).workspace;
second.id = '22222222-2222-4222-8222-222222222222';
const id = fixture.workspace.id;
let browser;
try {
  for (
    let attempt = 0;
    !(await fetch(origin).then(
      response => response.ok,
      () => false,
    ));
    attempt++
  ) {
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch();
  await mkdir(new URL('../../../reports/check/welcome-google/', import.meta.url), { recursive: true });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      colorScheme: mobile ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = {
      session: structuredClone(fixture.session),
      visitStatus: 200,
      gate: null,
      google: { status: 'disconnected' },
      beginStatus: 200,
      begins: 0,
      tools: [],
    };
    const firstSessions = new Map();
    state.session.user.name = 'M';
    await context.route('https://accounts.google.com/**', route =>
      route.fulfill({ contentType: 'text/html', body: '<p>Fixture Google consent</p>' }),
    );
    await context.route('**/v1/**', async route => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      let json;
      if (path === '/v1/auth/get-session') json = state.session;
      else if (path === '/v1/user/visit') {
        assert.equal(request.method(), 'POST');
        const { user, session } = state.session;
        await state.gate?.promise;
        if (state.visitStatus !== 200)
          return route.fulfill({ status: state.visitStatus, json: { error: 'unavailable' } });
        if (!firstSessions.has(user.id)) firstSessions.set(user.id, session.id);
        return route.fulfill({ json: { firstSession: firstSessions.get(user.id) === session.id } });
      } else if (path === '/v1/workspaces') json = [fixture.workspace, second];
      else if (path === `/v1/workspaces/${fixture.workspace.slug}`) json = fixture.workspace;
      else if (path === `/v1/workspaces/${second.slug}`) json = second;
      else if (path.endsWith('/governance/me')) json = membership;
      else if (path.endsWith('/credits')) json = credits;
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path.endsWith('/projects')) json = { projects: [], nextCursor: null };
      else if (path.endsWith('/google-workspace/availability')) json = { configured: true };
      else if (path.endsWith('/google-workspace')) json = state.google;
      else if (path.endsWith('/google-workspace/begin')) {
        state.begins++;
        await delay(300);
        return route.fulfill({
          status: state.beginStatus,
          json:
            state.beginStatus === 200
              ? { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?fixture=true' }
              : { error: 'provider-unavailable' },
        });
      } else if (path.endsWith('/github/accounts')) json = { configured: true, accounts: [] };
      else if (path.endsWith('/slack/status'))
        json = { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] };
      else if (path.endsWith('/atlassian/accounts')) json = { accounts: [], providers: [] };
      else if (path.endsWith('/integrations')) json = { integrations: [] };
      else if (path.endsWith('/integrations/creation-context')) json = { teams: [] };
      else if (path.endsWith('/messages'))
        json = {
          messages: [
            {
              id,
              sequence: 1,
              author: 'assistant',
              createdAt: fixture.workspace.createdAt,
              parts: [{ kind: 'text', text: 'Connect Google to continue.' }],
              turn: { id, status: 'completed', generation: 0 },
              tools: state.tools,
            },
          ],
          nextBefore: null,
          hasGitHubProposals: false,
        };
      else if (path.endsWith(`/conversations/${id}`))
        json = {
          id,
          title: 'Google reads',
          titleRevision: 1,
          archived: false,
          activityAt: fixture.workspace.createdAt,
          createdAt: fixture.workspace.createdAt,
        };
      else return route.fulfill({ status: 404, json: { error: 'not-found' } });
      return route.fulfill({ json });
    });
    state.session.user.id = 'deep-link-user';
    state.session.user.name = 'Maya';
    state.session.session.id = 'session-A';
    const recorded = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/user/visit');
    await page.goto(`${origin}/${fixture.workspace.slug}/integrations`);
    assert.deepEqual(await (await recorded).json(), { firstSession: true });
    assert.equal(await page.getByRole('heading', { name: /^Welcome/ }).count(), 0);
    state.session.session.id = 'session-B';
    await page.goto(`${origin}/${second.slug}`);
    await page.getByRole('heading', { name: 'Welcome back, Maya', exact: true }).waitFor();
    state.session = structuredClone(fixture.session);
    state.session.user.name = 'M';
    state.gate = Promise.withResolvers();
    await page.goto(`${origin}/${fixture.workspace.slug}`);
    const heading = page.getByRole('heading', { name: 'What should we work on?', exact: true });
    await heading.waitFor();
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('Keep this draft');
    state.gate.resolve();
    state.gate = null;
    await page.getByRole('heading', { name: 'Welcome to TulipFarm', exact: true }).waitFor();
    assert.equal(await input.textContent(), 'Keep this draft');
    await page.reload();
    await page.getByRole('heading', { name: 'Welcome to TulipFarm', exact: true }).waitFor();
    await page.goto(`${origin}/${second.slug}`);
    await page.getByRole('heading', { name: 'Welcome to TulipFarm', exact: true }).waitFor();
    state.session.session.id = 'returning-session';
    state.session.user.name = 'Maya Smith';
    await page.reload();
    await page.getByRole('heading', { name: 'Welcome back, Maya', exact: true }).waitFor();
    state.session.user.id = 'other-user';
    state.session.session.id = 'other-session';
    state.session.user.name = 'Ana';
    await page.reload();
    await page.getByRole('heading', { name: 'Welcome, Ana', exact: true }).waitFor();
    state.visitStatus = 503;
    await page.reload();
    await heading.waitFor();
    await input.fill('Still usable');
    assert.equal(await input.textContent(), 'Still usable');
    state.visitStatus = 200;
    await page.reload();
    await page.getByRole('heading', { name: 'Welcome, Ana', exact: true }).waitFor();
    await page.screenshot({
      path: new URL(
        `../../../reports/check/welcome-google/welcome-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
        import.meta.url,
      ).pathname,
    });

    for (const [kind, label, brand] of [
      ['calendar.events.list', 'Reading your Google Calendar data', 'google-calendar'],
      ['gmail.messages.get', 'Reading your Gmail data', 'gmail'],
      ['drive.files.get', 'Reading your Google Drive data', 'google-drive'],
      ['sheets.values.get', 'Reading your Google Sheets data', 'google-sheets'],
      ['docs.documents.get', 'Reading your Google Docs data', 'google-docs'],
      ['slides.presentations.get', 'Reading your Google Slides data', 'google-slides'],
      ['unknown.read', 'Reading your Google data', 'google'],
    ]) {
      state.tools = [
        {
          id,
          tool: 'google.read',
          status: 'completed',
          presentation: toolPresentation('google.read', { tool: 'google.read', operation: { kind } }),
        },
      ];
      await page.goto(`${origin}/${fixture.workspace.slug}/chat/${id}`);
      await page.reload();
      const activity = page.locator('[data-slot="tool-activity"]');
      // Cloud 856d6a73 (#1026) titles finished transcript activity 'Tool activity · N tools' (tool-activity.tsx:153).
      await activity.getByRole('button', { name: 'Tool activity · 1 tool', exact: true }).click();
      await activity.getByText(label, { exact: true }).waitFor();
      assert.equal(await activity.locator(`[data-brand="${brand}"]`).count(), 1);
    }
    await page.goto(`${origin}/${fixture.workspace.slug}/integrations#gmail`);
    const sheet = page.getByRole('dialog', { name: 'Gmail', exact: true });
    const connect = sheet.getByRole('button', { name: 'Connect Gmail', exact: true });
    await connect.waitFor();
    assert.doesNotMatch(await sheet.innerText(), /tester-only|test-user list/);
    assert.equal(await connect.getAttribute('aria-describedby'), null);
    assert.equal(state.begins, 0);
    state.beginStatus = 503;
    await connect.press('Enter');
    assert.equal(await connect.getAttribute('aria-busy'), 'true');
    await sheet.getByText('Could not start Gmail. Try again.', { exact: true }).waitFor();
    state.beginStatus = 200;
    await page.screenshot({
      path: new URL(
        `../../../reports/check/welcome-google/connect-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
        import.meta.url,
      ).pathname,
    });
    await connect.evaluate(button => {
      button.click();
      button.click();
    });
    await page.waitForURL('https://accounts.google.com/**');
    assert.equal(state.begins, 2, 'one failed attempt and one successful double-click attempt');
    await page.goto(`${origin}/google-workspace/callback?outcome=consent-denied&workspaceId=${id}`);
    await page.getByRole('heading', { name: 'Google consent was not granted', exact: true }).waitFor();
    const denied = await page.locator('main').innerText();
    assert.match(denied, /If you cancelled consent, you can try again\./);
    assert.doesNotMatch(denied, /tester-only|test-user list/);
    await page.getByRole('link', { name: 'Return to Integrations', exact: true }).click();
    await connect.waitFor();
    state.google = {
      status: 'connected',
      integrationId: id,
      generation: 1,
      accountId: 'google-account',
      email: 'allowed@example.test',
      scopes: googleAppScopes.gmail,
    };
    await page.goto(`${origin}/google-workspace/callback?outcome=connected&workspaceId=${id}`);
    await sheet.getByText('Connected', { exact: true }).waitFor();
    assert.equal(await connect.count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'PASS welcome state/recovery, seven Google read labels, open Google connect, consent retry/denial/success on desktop light and mobile dark.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
