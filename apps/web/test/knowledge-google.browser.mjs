import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

test(
  'Google Drive and Gmail Knowledge selection in the Google integration settings in Chromium',
  { timeout: 240_000 },
  async t => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const server = await createServer({
      root,
      configFile: `${root}/vite.config.ts`,
      envDir: false,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
    const browser = await chromium.launch();
    const screenshots = fileURLToPath(new URL('../../../reports/knowledge-google-ui/', import.meta.url));
    await mkdir(screenshots, { recursive: true });
    const { workspace, session } = createWorkspaceFixture({ slug: 'google-knowledge-qa', name: 'Google Knowledge QA' });
    const integrationId = randomUUID();
    const binding = {
      integrationId,
      accountId: 'owner-account',
      generation: 1,
      requiredScopes: ['https://www.googleapis.com/auth/drive'],
    };
    const connected = {
      status: 'connected',
      integrationId,
      generation: 1,
      accountId: 'owner-account',
      email: session.user.email,
      scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.modify'],
    };

    async function fixture(run) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const sources = new Map();
      const faults = { google: connected, discovery: 200, discoveryError: null, save: 200 };
      const writes = [],
        unknown = [],
        errors = [],
        discovered = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/v1/**', async route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
        if (request.method() === 'OPTIONS')
          return route.fulfill({
            status: 204,
            headers: {
              ...headers,
              'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
              'access-control-allow-headers': 'content-type',
            },
          });
        let status = 200,
          json,
          error;
        if (path.endsWith('/auth/get-session')) json = session;
        else if (path === '/v1/user/visit' && request.method() === 'POST') json = { firstSession: false };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me'))
          json = {
            membershipId: workspace.id,
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          };
        else if (path.endsWith('/credits'))
          json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
        else if (path === '/v1/google-workspace/availability') json = { configured: true };
        else if (path === `/v1/workspaces/${workspace.id}/google-workspace`) json = faults.google;
        else if (path.endsWith('/knowledge/google/discover')) {
          const kind = url.searchParams.get('kind');
          discovered.push(kind);
          status = faults.discovery;
          error = faults.discoveryError;
          json = {
            binding,
            nextCursor: null,
            items:
              kind === 'gmail'
                ? [{ nativeId: 'INBOX', title: 'Inbox', kind }]
                : [
                    { nativeId: 'my-drive-real-id', title: 'My Drive (all files)', kind },
                    { nativeId: 'f-handbook', title: 'Handbook', kind },
                  ],
          };
        } else if (path.endsWith('/knowledge/google/sources') && request.method() === 'GET')
          json = { items: [...sources.values()] };
        else if (path.endsWith('/knowledge/google/sources') && request.method() === 'POST') {
          const body = request.postDataJSON();
          writes.push(body);
          status = faults.save;
          json = sources.get(body.commandId) ?? {
            sourceId: body.commandId,
            selection: body.selection,
            memberIds: [workspace.id, ...body.memberIds],
            canManage: true,
            title: body.selection.kind === 'gmail' ? 'Inbox' : 'My Drive (all files)',
            state: 'active',
            syncState: 'queued',
            failure: null,
            nextAttemptAt: new Date().toISOString(),
            counts: { total: 0, ready: 0, failed: 0 },
          };
          if (status === 200) sources.set(body.commandId, json);
        } else if (path.endsWith('/knowledge/defaults')) json = { enabled: true, items: [] };
        else {
          if (path.includes('/knowledge/')) unknown.push(`${request.method()} ${path}`);
          status = 404;
          json = { error: 'not-found' };
        }
        await delay(0);
        await route
          .fulfill({ status, json: status === 200 ? json : { error: error ?? 'knowledge-unavailable' }, headers })
          .catch(() => {});
      });
      const open = async name => {
        await page.goto(`${origin}/${workspace.slug}/integrations`);
        await page
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name, exact: true }) })
          .getByRole('button', { name, exact: true })
          .click();
        const toggle = page.getByRole('dialog').getByRole('button', { name: 'Your account', exact: true });
        if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      };
      try {
        await run({ page, faults, sources, writes, discovered, open });
        assert.deepEqual(errors, []);
        assert.deepEqual(unknown, []);
      } finally {
        await context.close();
      }
    }

    try {
      await t.test('Google Drive offers My Drive, saves a private source, and replays an uncertain save', () =>
        fixture(async f => {
          await f.open('Google Drive');
          await f.page.getByRole('heading', { name: 'Google Drive knowledge', exact: true }).waitFor();
          await f.page.getByText('No Google Drive sources yet', { exact: true }).waitFor();
          await f.page.getByRole('button', { name: 'Index Google Drive', exact: true }).click();
          await f.page.getByLabel('Source type', { exact: true }).waitFor();
          await f.page.getByLabel('Source type', { exact: true }).click();
          await f.page.getByRole('option', { name: 'My Drive or a folder', exact: true }).waitFor();
          assert.deepEqual(await f.page.getByRole('option').allTextContents(), [
            'My Drive or a folder',
            'Shared drive',
          ]);
          await f.page.getByRole('option', { name: 'My Drive or a folder', exact: true }).click();
          await f.page.getByLabel('Folder', { exact: true }).click();
          await f.page.getByRole('option', { name: 'My Drive (all files)', exact: true }).click();
          f.faults.save = 503;
          await f.page.getByRole('button', { name: 'Save Google source', exact: true }).click();
          await f.page.getByRole('button', { name: 'Retry same operation', exact: true }).waitFor();
          f.faults.save = 200;
          await f.page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
          await f.page.getByText('My Drive (all files) was saved.', { exact: false }).waitFor();
          await f.page
            .getByRole('listitem', { name: 'My Drive (all files)' })
            .getByText('Queued', { exact: true })
            .waitFor();
          assert.equal(f.writes.length, 2);
          assert.equal(f.writes[0].commandId, f.writes[1].commandId, 'retry replays the same command');
          assert.deepEqual(f.writes[1].selection, { kind: 'drive-folder', folderId: 'my-drive-real-id' });
          assert.deepEqual(f.writes[1].memberIds, []);
          await f.page.screenshot({ path: `${screenshots}drive-saved.png`, fullPage: true });
        }),
      );

      await t.test('missing Drive scope explains how to recover before any save', () =>
        fixture(async f => {
          f.faults.discovery = 409;
          f.faults.discoveryError = 'google-insufficient-scope';
          await f.open('Google Drive');
          await f.page.getByRole('button', { name: 'Index Google Drive', exact: true }).click();
          await f.page.getByText('Connect Google Drive or Gmail in Integrations', { exact: false }).waitFor();
          assert.equal(
            await f.page.getByRole('button', { name: 'Save Google source', exact: true }).isDisabled(),
            true,
          );
          assert.equal(f.writes.length, 0);
        }),
      );

      await t.test('Gmail indexes a dated label and stays private', () =>
        fixture(async f => {
          await f.open('Gmail');
          await f.page.getByRole('heading', { name: 'Gmail knowledge', exact: true }).waitFor();
          await f.page.getByRole('button', { name: 'Index Gmail', exact: true }).click();
          await f.page.getByLabel('Gmail scope', { exact: true }).click();
          await f.page.getByRole('option', { name: 'Inbox', exact: true }).click();
          assert.equal(await f.page.getByLabel('Share with selected workspace members').count(), 0);
          await f.page.getByRole('button', { name: 'Save Google source', exact: true }).click();
          await f.page.getByText('Inbox was saved.', { exact: false }).waitFor();
          assert.equal(f.writes[0].selection.kind, 'gmail');
          assert.equal(f.writes[0].selection.labelId, 'INBOX');
          assert.deepEqual(f.discovered, ['gmail']);
        }),
      );

      await t.test('disconnected Google shows no knowledge section', () =>
        fixture(async f => {
          f.faults.google = { status: 'disconnected' };
          await f.open('Google Drive');
          await f.page.getByRole('dialog').waitFor();
          await delay(500);
          assert.equal(await f.page.getByRole('heading', { name: 'Google Drive knowledge', exact: true }).count(), 0);
        }),
      );
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
