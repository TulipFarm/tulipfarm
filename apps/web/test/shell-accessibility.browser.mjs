import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';

const require = createRequire(import.meta.url);
const chatId = '22222222-2222-4222-8222-222222222222';
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=';
let server, browser, origin;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    args: process.env.SHELL_ACCESSIBILITY_CDP_PORT
      ? [`--remote-debugging-port=${process.env.SHELL_ACCESSIBILITY_CDP_PORT}`]
      : [],
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function accessible(page) {
  const violations = await page.evaluate(async () =>
    (await window.axe.run(document, { runOnly: ['label-content-name-mismatch'] })).violations.map(item => ({
      id: item.id,
      nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })),
    })),
  );
  assert.deepEqual(violations, []);
}

for (const mobile of [false, true])
  for (const avatar of ['initial', 'image', 'failed-image'])
    test(`${mobile ? 'mobile' : 'desktop'} shell names match visible labels with ${avatar} avatars`, async () => {
      const { workspace, session } = createWorkspaceFixture({ slug: 'acme', name: 'Acme' });
      if (avatar === 'image') {
        workspace.icon = image;
        session.user.image = image;
      } else if (avatar === 'failed-image') {
        workspace.icon = 'data:image/png;base64,YnJva2Vu';
        session.user.image = workspace.icon;
      }
      const name = session.user.name || session.user.email;
      const reads = new Map([
        ...workspaceShellReads(workspace.id),
        ['/v1/auth/get-session', session],
        ['/v1/workspaces', [workspace]],
        ['/v1/workspaces/acme', workspace],
        [
          `/v1/workspaces/${workspace.id}/governance/me`,
          {
            membershipId: workspace.id,
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          },
        ],
        [
          `/v1/workspaces/${workspace.id}/bud`,
          {
            conversationId: chatId,
            onboarding: 'skipped',
            bubblesEnabled: false,
            snoozedUntil: null,
            nudge: null,
            preferences: [],
          },
        ],
        [
          `/v1/workspaces/${workspace.id}/conversations/${chatId}`,
          {
            id: chatId,
            title: 'Bud',
            titleRevision: 0,
            archived: false,
            activityAt: workspace.createdAt,
            createdAt: workspace.createdAt,
          },
        ],
        [`/v1/workspaces/${workspace.id}/conversations/${chatId}/messages`, { messages: [], nextBefore: null }],
      ]);
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        isMobile: mobile,
        hasTouch: mobile,
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith('/v1/')) return url.origin === origin ? route.continue() : route.abort();
          if (await serveWorkspaceShellEvent(route, workspace)) return;
          if (reads.has(url.pathname)) return route.fulfill({ json: reads.get(url.pathname) });
          return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        });
        await page.goto(`${origin}/acme/help`);
        const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
        await toggle.waitFor();
        const launcher = page.locator('aside[aria-label="Bud assistant"] button[data-slot="popover-trigger"]');
        await launcher.waitFor();
        await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
        if (mobile) await toggle.click();
        await accessible(page);
        const workspaceMenu = page.getByRole('button', { name: 'Acme, workspace menu', exact: true });
        const accountMenu = page.getByRole('button', { name: `${name}, account menu`, exact: true });
        await workspaceMenu.waitFor();
        await accountMenu.waitFor();
        if (avatar === 'image') assert.equal(await page.locator('[data-slot="entity-avatar"] img').count(), 2);
        if (mobile) await page.getByRole('button', { name: 'Close', exact: true }).click();
        else {
          await toggle.click();
          await page.locator('[data-sprout-sidebar][data-state="collapsed"]').waitFor();
          await accessible(page);
          await workspaceMenu.waitFor();
          await accountMenu.waitFor();
          await toggle.click();
        }
        assert.equal(
          await launcher.getAttribute('aria-label'),
          'Bud quick chat. Separate private chat. Open quick chat',
        );
        await accessible(page);
        if (process.env.SHELL_ACCESSIBILITY_SCREENSHOT && !mobile && avatar === 'initial')
          execFileSync('agent-browser', [
            '--session',
            'shell-visible-names',
            '--cdp',
            process.env.SHELL_ACCESSIBILITY_CDP_PORT,
            'screenshot',
            process.env.SHELL_ACCESSIBILITY_SCREENSHOT,
          ]);
        await launcher.click();
        await page.getByRole('dialog', { name: 'Bud quick chat', exact: true }).waitFor();
        assert.equal(await launcher.getAttribute('aria-label'), 'Minimize quick chat. Separate private chat');
        await accessible(page);
        await launcher.click();
        await page.goto(`${origin}/acme/chat/33333333-3333-4333-8333-333333333333`);
        await page.locator('aside[data-corner="header"]').waitFor();
        await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
        assert.equal(await launcher.getAttribute('aria-label'), 'Bud. Open quick chat');
        await accessible(page);
        await launcher.click();
        await page.getByRole('dialog', { name: 'Bud quick chat', exact: true }).waitFor();
        assert.equal(await launcher.getAttribute('aria-label'), 'Bud. Minimize quick chat');
        await accessible(page);
      } finally {
        await context.close();
      }
    });
