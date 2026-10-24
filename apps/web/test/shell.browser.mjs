import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { openChatList } from './browser-controls.mjs';

const port = Number(process.env.SHELL_BROWSER_PORT ?? 5295);
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-09-30T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const chatId = '22222222-2222-4222-8222-222222222222';
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(origin).then(
        response => response.ok,
        () => false,
      )
    )
      break;
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    let chatStatus = 200;
    let chatDelay = 0;
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let status = 200;
      let json;
      if (path === '/v1/auth/get-session')
        json = {
          session: { id: 'session-ada', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
        };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: workspace.id,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith('/credits'))
        json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
      else if (path.endsWith('/conversations')) {
        await delay(chatDelay);
        status = chatStatus;
        json = { chats: [], nextCursor: null };
      } else if (path.endsWith(`/conversations/${chatId}`)) {
        status = chatStatus;
        json = {
          id: chatId,
          title: 'Supplier follow-up',
          titleRevision: 0,
          archived: false,
          activityAt: workspace.createdAt,
          createdAt: workspace.createdAt,
        };
      } else if (path.endsWith(`/conversations/${chatId}/messages`)) {
        status = chatStatus;
        json = { messages: [], nextBefore: null };
      } else status = 503;
      await route.fulfill({ status, json: status === 200 ? json : { error: 'unavailable' } });
    });
    const shellHeader = page.locator('header[aria-label="Workspace header"]');
    const nav = page.getByRole('navigation', { name: 'Workspace navigation', exact: true });
    const toggle = page.getByRole('button', { name: 'Toggle Sidebar', exact: true });
    const openNavigation = async () => {
      if (mobile) await toggle.click();
    };
    for (const [path, title, active] of [
      ['/acme/agents/new', 'Agents / New agent', 'Agents'],
      [`/acme/agents/${chatId}`, 'Agents / Agent details', 'Agents'],
      ['/acme/tables/new', 'Tables / New table', 'Tables'],
      [`/acme/tables/${chatId}/edit`, 'Tables / Edit table', 'Tables'],
      ['/acme/settings/models', 'Settings / Models', null],
    ]) {
      await page.goto(`${origin}${path}`);
      await toggle.waitFor();
      assert.equal(await shellHeader.getByText(title).count(), 0, 'The page H1 carries the title, not the top bar');
      await openNavigation();
      assert.equal(await nav.locator('[aria-current="page"]').count(), active ? 1 : 0);
      if (active)
        assert.equal(await nav.getByRole('link', { name: active, exact: true }).getAttribute('aria-current'), 'page');
      assert.equal(await nav.getByRole('link', { name: 'Inbox', exact: true }).count(), 0);
      if (mobile) {
        for (const link of await nav.getByRole('link').all()) assert.ok((await link.boundingBox()).height >= 44);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-slot') === 'sidebar-trigger');
        assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
        assert.equal(await shellHeader.getByText('Acme', { exact: true }).isVisible(), true);
      }
    }
    await page.goto(`${origin}/acme`);
    await shellHeader.getByRole('heading', { name: 'New chat', exact: true }).waitFor();
    const heading = shellHeader.getByRole('heading', { name: 'New chat', exact: true });
    await heading.focus();
    assert.equal(await heading.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
    assert.match(await heading.evaluate(element => getComputedStyle(element).textDecorationLine), /underline/);
    assert.equal(await page.locator('main header[aria-label="Workspace header"]').count(), 1);
    await page.keyboard.press('Tab');
    await toggle.focus();
    const focus = await toggle.evaluate(element => ({
      focused: element === document.activeElement,
      visible: element.matches(':focus-visible'),
      outline: getComputedStyle(element).outline,
      shadow: getComputedStyle(element).boxShadow,
    }));
    assert.equal(
      focus.visible && (focus.outline.includes('solid') || focus.shadow !== 'none'),
      true,
      JSON.stringify(focus),
    );
    if (!mobile) {
      const identity = page.getByRole('button', { name: 'Workspace menu, Acme' });
      const a = await identity.boundingBox();
      const b = await toggle.boundingBox();
      assert.ok(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) <= 1, 'Header controls align');
      await toggle.click();
      await page.reload();
      await page.locator('[data-slot="sidebar"][data-state="collapsed"]').waitFor();
    } else await openNavigation();
    await page.getByRole('button', { name: 'Jump to…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Jump to…', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('group', { name: 'Filter by type' }).count(), 0);
    assert.equal(await dialog.getByRole('option', { name: 'Inbox', exact: true }).count(), 0);
    const input = dialog.getByPlaceholder('Find a page or action…');
    assert.ok((await input.getAttribute('aria-label')) || (await input.getAttribute('aria-labelledby')));
    if (process.env.SHELL_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.SHELL_SCREENSHOT_DIR}/shell-${mobile ? 'mobile' : 'desktop'}-search.png`,
      });
    await input.fill('no matching page');
    await dialog.getByText('No pages or actions found', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Clear search', exact: true }).click();
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    await input.fill('create agent');
    await dialog.getByRole('option', { name: 'Create agent', exact: true }).waitFor();
    await input.press('Enter');
    await page.waitForURL('**/acme/agents/new');
    await page.keyboard.press('Control+k');
    await dialog.waitFor();
    await input.fill('tables');
    await input.press('Escape');
    await page.keyboard.press('Control+k');
    await dialog.waitFor();
    assert.equal(await input.inputValue(), '', 'Escape clears the previous query');
    await input.press('Escape');
    await page.goto(`${origin}/acme/chat/${chatId}`);
    await shellHeader.getByRole('heading', { name: 'Supplier follow-up' }).waitFor();
    await shellHeader.getByRole('button', { name: 'Chat actions' }).waitFor();
    await openChatList(page);
    await page.getByRole('heading', { name: 'Chats', level: 1, exact: true }).waitFor();
    await page.getByText('No chats yet', { exact: true }).waitFor();
    chatStatus = 503;
    await page.reload();
    await page.getByText('Could not load chats', { exact: true }).waitFor();
    await toggle.waitFor();
    await page.getByRole('button', { name: 'Retry loading chats' }).click();
    await page.getByRole('status', { name: 'Loading chats' }).waitFor();
    await page.getByText('Could not load chats', { exact: true }).waitFor();
    chatStatus = 200;
    chatDelay = 500;
    await page.getByRole('button', { name: 'Retry loading chats' }).click();
    await page.getByRole('status', { name: 'Loading chats' }).waitFor();
    await page.getByText('No chats yet', { exact: true }).waitFor();
    chatStatus = 403;
    await page.goto(`${origin}/acme/chat/${chatId}`);
    await page.getByRole('heading', { name: 'Personal chats unavailable' }).waitFor();
    await toggle.waitFor();
    chatStatus = 200;
    await page.goto(`${origin}/acme`);
    await shellHeader.getByRole('heading', { name: 'New chat', exact: true }).waitFor();
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal((await shellHeader.boundingBox()).height, 44);
      if (process.env.SHELL_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.SHELL_SCREENSHOT_DIR}/shell-${mobile ? 'mobile' : 'desktop'}-${theme}.png`,
        });
    }
    if (mobile) {
      await openNavigation();
      await page.getByRole('dialog', { name: 'Workspace navigation' }).waitFor();
      await nav.getByRole('link', { name: 'Agents', exact: true }).waitFor();
      if (process.env.SHELL_SCREENSHOT_DIR)
        await page.screenshot({ path: `${process.env.SHELL_SCREENSHOT_DIR}/shell-mobile-drawer.png` });
      await nav.getByRole('link', { name: 'Agents', exact: true }).click();
      await page.waitForURL('**/acme/agents');
      await nav.waitFor({ state: 'hidden' });
    } else {
      await toggle.click();
      await page.reload();
      await page.locator('[data-slot="sidebar"][data-state="expanded"]').waitFor();
      if (process.env.SHELL_SCREENSHOT_DIR)
        await page.screenshot({ path: `${process.env.SHELL_SCREENSHOT_DIR}/shell-desktop-expanded.png` });
      await page.context().addCookies([{ name: 'sidebar_state', value: 'invalid', url: origin }]);
      await page.reload();
      await page.locator('[data-slot="sidebar"][data-state="expanded"]').waitFor();
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${mobile ? 'Mobile' : 'Desktop'} shell navigation, search, recovery, focus and themes passed`);
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
