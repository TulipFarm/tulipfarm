import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { chatCatalog } from './chat-catalog.fixture.mjs';

export async function proveBlockedTableBrowser(input) {
  const origin = 'http://localhost:5173';
  const api = await input.app.listen({ host: '127.0.0.1', port: 0 });
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(origin) },
    server: { host: 'localhost', port: 5173, strictPort: true, proxy: { '/v1': { target: api } } },
  });
  let browser;
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addCookies(
      input.cookie.split('; ').map(part => ({
        name: part.slice(0, part.indexOf('=')),
        value: part.slice(part.indexOf('=') + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax',
      })),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let outcomeState = 'slow';
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const workspace = {
        id: input.workspaceId,
        slug: 'blocked-proof',
        name: 'Blocked proof',
        status: 'ready',
        createdAt: new Date().toISOString(),
        soulCommit: 'a'.repeat(40),
      };
      if (path === '/v1/auth/get-session')
        return route.fulfill({
          json: {
            session: { id: 'fixture', userId: input.userId },
            user: { id: input.userId, name: 'Requester', email: 'requester@example.com' },
          },
        });
      if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
      if (path === '/v1/workspaces/blocked-proof') return route.fulfill({ json: workspace });
      if (path.endsWith('/governance/me'))
        return route.fulfill({
          json: {
            membershipId: input.membershipId,
            role: 'admin',
            teams: [],
            capabilities: { manageGovernance: true, canLeave: true },
          },
        });
      if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
      if (path.includes('/google/')) return route.fulfill({ json: { items: [], nextCursor: null } });
      if (path.endsWith('/outcome') && outcomeState === 'slow') await new Promise(resolve => setTimeout(resolve, 1000));
      if (path.endsWith('/outcome') && outcomeState === 'failed')
        return route.fulfill({ status: 503, json: { error: 'proposal-unavailable' } });
      return route.continue();
    });
    await page.goto(`${origin}/blocked-proof/chat/${input.chatId}`);
    await page.getByRole('status', { name: 'Loading tables' }).first().waitFor();
    const blocked = page.getByRole('region', { name: 'Blocked table changes', exact: true }).first();
    await blocked.getByText(input.recordId, { exact: true }).waitFor();
    await blocked.getByText(input.fieldId, { exact: true }).waitFor();
    await blocked.getByText('conversion-failed', { exact: true }).waitFor();
    assert.match(await blocked.innerText(), /1 invalid record\./);
    assert.equal(await blocked.getByRole('button', { name: /Approve/ }).count(), 0);
    assert.equal((await page.locator('body').innerText()).includes('private-invalid-number'), false);
    assert.equal(await blocked.locator('a').filter({ hasText: 'Open table' }).count(), 1);
    outcomeState = 'failed';
    await page.reload();
    await page.getByText('Could not load tables', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Try again', exact: true }).first().click();
    await page.getByRole('button', { name: 'Try again', exact: true }).first().waitFor();
    outcomeState = 'ready';
    await page.getByRole('button', { name: 'Try again', exact: true }).first().click();
    await blocked.waitFor();
    await input.deny(true);
    await blocked.getByRole('button', { name: 'Check report access' }).click();
    await page.getByText('Table unavailable', { exact: true }).first().waitFor();
    assert.equal(await page.getByText(input.recordId, { exact: true }).count(), 0);
    assert.equal(await page.locator('a').filter({ hasText: 'Open table' }).count(), 0);
    await input.deny(false);
    await page.getByRole('button', { name: 'Check access again' }).first().click();
    await blocked.waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => {
        document.documentElement.classList.remove('light', 'dark');
        document.documentElement.classList.add(theme);
      }, theme);
      await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await blocked.getByRole('button', { name: 'Continue in chat' }).click();
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Message', exact: true })
          .evaluate(element => element === document.activeElement),
        true,
      );
    }
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Use the numeric literal 42 for Amount and make a new proposal.');
    const sent = page.waitForResponse(
      response => response.request().method() === 'PUT' && /\/messages\//.test(response.url()),
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    assert.equal((await sent).status(), 200);
    await input.processReply();
    await page
      .getByRole('region', { name: 'Table change proposal', exact: true })
      .last()
      .getByText('Awaiting your review', { exact: true })
      .waitFor();
    await blocked.getByText('conversion-failed', { exact: true }).waitFor();
    await page.reload();
    await blocked.getByText(input.recordId, { exact: true }).waitFor();
    await page
      .getByRole('region', { name: 'Table change proposal', exact: true })
      .last()
      .getByText('Awaiting your review', { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    process.stdout.write(
      'Blocked report browser passed: persisted tool result, recovery, revocation, correction chat, new proposal, reload, mobile/dark.\n',
    );
  } finally {
    await browser?.close();
    await vite.close();
  }
}
