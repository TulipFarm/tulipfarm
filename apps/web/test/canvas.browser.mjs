import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const port = Number(process.env.CANVAS_BROWSER_PORT ?? 5243);
const origin = `http://127.0.0.1:${port}`;
const id = '11111111-1111-4111-8111-111111111111';
const { workspace, session } = createWorkspaceFixture({ slug: 'canvas-qa', name: 'Canvas QA' });
const file = {
  id: '44444444-4444-4444-8444-444444444444',
  kind: 'file',
  name: 'follow-ups.txt',
  parentId: null,
  creatorMembershipId: id,
  mediaType: 'text/plain',
  size: 64,
  trashed: false,
  role: 'manager',
};
const chat = {
  id,
  title: 'Customer follow-ups',
  titleRevision: 1,
  archived: false,
  activityAt: workspace.createdAt,
  createdAt: workspace.createdAt,
};

test(
  'chat canvas opens a file reference, closes, reopens, and becomes a sheet on small screens',
  { timeout: 120000 },
  async () => {
    const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
      detached: true,
    });
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
        assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      page.on('console', message => {
        if (message.type() === 'error' && message.text().includes('same key')) errors.push(message.text());
      });
      await context.route('**/v1/**', route => {
        const path = new URL(route.request().url()).pathname;
        let json;
        if (path === '/v1/user/visit') json = { firstSession: false };
        else if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me'))
          json = {
            membershipId: id,
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          };
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path === `/v1/workspaces/${workspace.id}/files/${file.id}/content`)
          return route.fulfill({ contentType: 'text/plain', body: 'Northstar: call back on Monday.' });
        else if (path === `/v1/workspaces/${workspace.id}/files/${file.id}`) json = file;
        else if (path.endsWith('/messages'))
          json = {
            messages: [
              {
                id,
                sequence: 1,
                author: 'human',
                createdAt: workspace.createdAt,
                parts: [
                  { kind: 'text', text: 'Which customers need a follow-up?' },
                  { kind: 'file', fileId: file.id },
                ],
                turn: { id, status: 'completed', generation: 0 },
                tools: [],
              },
            ],
            nextBefore: null,
            hasGitHubProposals: false,
          };
        else if (/\/conversations\/[\w-]+$/.test(path)) json = chat;
        else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });
      await page.goto(`${origin}/${workspace.slug}/chat/${id}`);
      await page.getByText('Which customers need a follow-up?').waitFor();
      const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
      const chip = page.getByRole('button', { name: /follow-ups\.txt/ });

      assert.equal(await canvas.count(), 0);
      await chip.click();
      await canvas.getByText('Northstar: call back on Monday.').waitFor();
      await page
        .getByRole('button', { name: 'Hide canvas', exact: true })
        .getByText('Hide canvas', { exact: true })
        .waitFor();
      assert.equal(await canvas.getByRole('tab', { name: 'follow-ups.txt' }).getAttribute('aria-selected'), 'true');
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
        true,
      );

      await canvas.getByRole('tab', { name: 'follow-ups.txt' }).press('Escape');
      await canvas.waitFor({ state: 'detached' });
      const showCanvas = page.getByRole('button', { name: 'Show canvas, 1 open' });
      await showCanvas.getByText('Show canvas', { exact: true }).waitFor();
      await showCanvas.click();
      await canvas.waitFor();
      await canvas.getByRole('button', { name: 'Close follow-ups.txt' }).click();
      await canvas.waitFor({ state: 'detached' });

      await page.setViewportSize({ width: 375, height: 812 });
      await chip.click();
      const sheet = page.getByRole('dialog', { name: 'Canvas' });
      await sheet.getByText('Northstar: call back on Monday.').waitFor();
      await sheet.getByRole('button', { name: 'Back to chat' }).click();
      await sheet.waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
  },
);
