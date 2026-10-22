import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { googleFixture } from '../../../packages/google-workspace/test/fixture.mjs';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createGoogleApproval } from '@tulipfarm/google-workspace/operation-approval';
import { authConfig } from '../../api/src/auth.ts';
import { registerGoogleWorkspace } from '../../api/src/google-workspace.ts';
import { registerGoogleOperations } from '../../api/src/google-operations.ts';
import { registerSecurity, securityServerOptions } from '../../api/src/security.ts';
import { registerFilesComposition } from '../../api/src/files-composition.ts';
import { registerFilesGoogleCopy } from '../../api/src/files-google-copy.ts';
import { filesObjectFixture } from '../../../packages/workspaces/test/files-object-fixture.mjs';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';
import { chooseOption, captureEvidence, evidenceBrowserArgs } from './browser-controls.mjs';
import { viewerPdf, assertRenderedPdf } from './pdf-viewer.fixture.mjs';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify');
const swagger = requireApi('@fastify/swagger');
const shots = process.env.FILES_SCREENSHOTS ?? 'reports/check/files-browser';
const pdf = viewerPdf;

test(
  'Google Drive browsing and viewing through the real API, PostgreSQL, and a local Google provider',
  { timeout: 240000 },
  async () => {
    const f = await googleFixture();
    let app, provider, server, browser, object;
    const errors = [],
      forwarded = [],
      providerCalls = [];
    const doc = {
      id: 'docR',
      name: 'Field report',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-10-02T08:00:00.000Z',
      owners: [{ me: true, displayName: 'Member' }],
      webViewLink: 'https://docs.google.com/document/d/docR/edit',
      parents: ['rootR'],
    };
    const sheet = {
      id: 'sheetR',
      name: 'Stock levels',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      modifiedTime: '2026-10-02T08:00:00.000Z',
      owners: [{ me: true }],
      webViewLink: 'https://docs.google.com/spreadsheets/d/sheetR/edit',
      parents: ['rootR'],
    };
    try {
      provider = createHttpServer((request, response) => {
        const url = new URL(request.url, 'http://provider');
        providerCalls.push(`${request.method} ${decodeURIComponent(url.pathname)}`);
        assert.equal(request.method, 'GET');
        assert.match(request.headers.authorization, /^Bearer (initial|refreshed)-private-access$/);
        const json = value => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(value));
        };
        if (url.pathname === '/drive/v3/files') {
          assert.equal(url.searchParams.get('q'), "trashed = false and 'root' in parents");
          return json({ files: [doc, sheet, { id: 'bad id', name: 'Broken' }] });
        }
        if (url.pathname === '/drive/v3/files/docR') return json(doc);
        if (url.pathname === '/drive/v3/files/sheetR') return json(sheet);
        if (url.pathname === '/drive/v3/files/docR/export') {
          assert.equal(url.searchParams.get('mimeType'), 'application/pdf');
          response.setHeader('content-type', 'application/pdf');
          return response.end(pdf);
        }
        if (url.pathname === '/v4/spreadsheets/sheetR')
          return json({
            spreadsheetId: 'sheetR',
            sheets: [
              {
                properties: {
                  sheetId: 0,
                  title: 'Warehouse',
                  sheetType: 'GRID',
                  gridProperties: { rowCount: 2, columnCount: 2 },
                },
              },
            ],
          });
        if (url.pathname.startsWith('/v4/spreadsheets/sheetR/values/')) {
          assert.equal(decodeURIComponent(url.pathname.split('/values/')[1]), "'Warehouse'!A1:B2");
          assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
          return json({
            range: "'Warehouse'!A1:B2",
            majorDimension: 'ROWS',
            values: [
              ['Item', 'On hand'],
              ['Crates', '42 crates'],
            ],
          });
        }
        response.statusCode = 404;
        json({ error: { errors: [{ reason: 'notFound' }] } });
      });
      provider.listen(0, '127.0.0.1');
      await once(provider, 'listening');
      const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
      const connected = await f.connect();
      const operations = createGoogleOperations({
        runtime: f.runtime,
        integrations: f.service,
        fetcher: (raw, init) => {
          const url = new URL(String(raw));
          assert.ok(
            ['https://www.googleapis.com', 'https://sheets.googleapis.com'].includes(url.origin),
            `provider origin ${url.origin}`,
          );
          return fetch(`${providerOrigin}${url.pathname}${url.search}`, init);
        },
      });
      const auth = {
        api: {
          getSession: async ({ headers }) =>
            headers.get('cookie') === 'session=member'
              ? { user: { id: f.member.userId }, session: { id: f.principal.sessionId } }
              : null,
        },
      };
      app = Fastify(securityServerOptions());
      registerSecurity(app, authConfig().webOrigin);
      await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'Files Google', version: '1' } } });
      object = await filesObjectFixture();
      await app.register(
        async routes => {
          registerGoogleWorkspace(routes, { auth, service: f.service });
          registerGoogleOperations(routes, {
            auth,
            runtime: f.runtime,
            operations,
            approve: createGoogleApproval({
              runtime: f.runtime,
              resolveConfirmationCredential: async () => f.db.login(f.workspace, 'confirmation'),
            }),
          });
          const files = registerFilesComposition(routes, { runtime: f.runtime, auth, objects: object.adapter });
          registerFilesGoogleCopy(routes, { auth, files, google: operations });
        },
        { prefix: '/v1' },
      );
      await app.listen({ host: '127.0.0.1', port: 0 });

      const { workspace, session } = createWorkspaceFixture({
        id: f.workspace.id,
        userId: f.member.userId,
        slug: 'drive-live',
        name: 'Drive live',
      });
      const root = fileURLToPath(new URL('..', import.meta.url));
      server = await createServer({
        root,
        configFile: `${root}/vite.config.ts`,
        envDir: false,
        logLevel: 'error',
        server: { host: '127.0.0.1', port: 0 },
      });
      await server.listen();
      const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
      browser = await chromium.launch({ channel: 'chromium', args: evidenceBrowserArgs() });
      const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
      await context.route('**/v1/**', async route => {
        try {
          const request = route.request(),
            url = new URL(request.url()),
            path = url.pathname,
            method = request.method();
          const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
          if (method === 'OPTIONS')
            return route.fulfill({
              status: 204,
              headers: {
                ...cors,
                'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
                'access-control-allow-headers': 'content-type',
              },
            });
          if (await serveWorkspaceShellEvent(route, workspace)) return;
          if (
            path === '/v1/google-workspace/availability' ||
            path.startsWith(`/v1/workspaces/${workspace.id}/google-workspace`) ||
            path.startsWith(`/v1/workspaces/${workspace.id}/files`)
          ) {
            forwarded.push(
              `${method} ${path.replace(`/v1/workspaces/${workspace.id}`, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ':id')}`,
            );
            const body = request.postDataBuffer();
            const response = await fetch(`${app.listeningOrigin}${path}${url.search}`, {
              method,
              headers: {
                cookie: 'session=member',
                origin: authConfig().webOrigin,
                ...(body === null ? {} : { 'content-type': 'application/json' }),
              },
              ...(body === null ? {} : { body }),
            });
            assert.equal(response.headers.get('cache-control'), 'no-store');
            return route.fulfill({
              status: response.status,
              body: Buffer.from(await response.arrayBuffer()),
              headers: { ...Object.fromEntries(response.headers), ...cors },
            });
          }
          const shell = new Map([
            ...workspaceShellReads(workspace.id),
            ['/v1/auth/get-session', session],
            ['/v1/user/visit', { firstSession: false }],
            ['/v1/workspaces', [workspace]],
            [`/v1/workspaces/${workspace.slug}`, workspace],
            [
              `/v1/workspaces/${workspace.id}/governance/me`,
              {
                membershipId: f.member.membershipId,
                role: 'member',
                teams: [],
                capabilities: { manageGovernance: false, canLeave: true },
              },
            ],
            [
              `/v1/workspaces/${workspace.id}/credits`,
              { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
            ],
          ]);
          assert.ok(shell.has(path), `Unexpected browser route ${method} ${path}`);
          assert.equal(method, path === '/v1/user/visit' ? 'POST' : 'GET', `Unexpected shell method: ${path}`);
          return route.fulfill({ status: 200, json: shell.get(path), headers: cors });
        } catch (error) {
          errors.push(error);
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error));
      const main = page.getByRole('main');
      await mkdir(shots, { recursive: true });

      await page.goto(`${origin}/${workspace.slug}/files?section=google`);
      await main.getByRole('link', { name: 'Field report', exact: true }).waitFor();
      await main.getByText('member@example.com', { exact: true }).waitFor();
      await main
        .getByText('1 item on this page couldn’t be shown because Google returned incomplete details.', { exact: true })
        .waitFor();
      assert.equal(await main.getByRole('list', { name: 'Google Drive files' }).getByRole('listitem').count(), 2);
      await page.screenshot({ path: `${shots}/google-live-list-1280.png` });

      await main.getByRole('link', { name: 'Field report', exact: true }).click();
      await page.getByRole('heading', { name: 'Field report', level: 1 }).waitFor();
      assert.match(
        await main.getByRole('region', { name: 'File content' }).locator('iframe').getAttribute('src'),
        /^blob:/,
      );
      await assertRenderedPdf(page);
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await assertRenderedPdf(page);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await captureEvidence(page, `${shots}/google-live-doc-${width}.png`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      assert.equal(await main.getByRole('link', { name: 'Open in Google' }).getAttribute('href'), doc.webViewLink);
      const download = page.waitForEvent('download');
      await main.getByRole('button', { name: 'Download PDF' }).click();
      const saved = await download;
      assert.equal(saved.suggestedFilename(), 'Field report.pdf');
      assert.deepEqual(
        await readFile(await saved.path()),
        pdf,
        'the delivered PDF is the provider export, byte for byte',
      );

      await main.getByRole('button', { name: 'Save a copy' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('Saving to My files').waitFor();
      await chooseOption(page, dialog.getByLabel('Format'), 'PDF (.pdf)');
      assert.equal(await dialog.getByLabel('Name').inputValue(), 'Field report.pdf');
      await dialog.getByRole('button', { name: 'Save copy' }).click();
      await dialog.getByRole('heading', { name: 'Copy saved to TulipFarm' }).waitFor();
      const copyId = (await dialog.getByRole('link', { name: 'Open copy' }).getAttribute('href')).split('/').at(-1);
      const stored = await fetch(`${app.listeningOrigin}/v1/workspaces/${f.workspace.id}/files/${copyId}/content`, {
        headers: { cookie: 'session=member' },
      });
      assert.deepEqual(
        Buffer.from(await stored.arrayBuffer()),
        pdf,
        'the saved TulipFarm copy is the Google export, byte for byte',
      );
      assert.equal(object.objects.size, 1);
      await page.screenshot({ path: `${shots}/google-live-copy-1280.png` });
      const recentUse = page.waitForResponse(
        response => response.url().endsWith(`/files/${copyId}/recent-use`) && response.request().method() === 'POST',
      );
      await dialog.getByRole('link', { name: 'Open copy' }).click();
      await page.getByRole('heading', { name: 'Field report.pdf', level: 1 }).waitFor();
      assert.equal((await recentUse).ok(), true, 'opening the copy records its recent use before navigation');
      await page.goto(`${origin}/${workspace.slug}/files/google/docR`);
      await page.getByRole('heading', { name: 'Field report', level: 1 }).waitFor();

      await main.getByRole('link', { name: 'Google Drive', exact: true }).first().click();
      await main.getByRole('link', { name: 'Stock levels', exact: true }).click();
      const grid = main.getByRole('region', { name: 'Warehouse, rows 1 to 2' });
      await grid.getByText('42 crates', { exact: true }).waitFor();
      await page.screenshot({ path: `${shots}/google-live-sheet-1280.png` });

      await f.service.disconnect(f.workspace.id, f.member.userId);
      await main.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('heading', { name: 'Connect Google Drive' }).waitFor();
      assert.equal(await page.getByText('42 crates').count(), 0, 'disconnect clears source content');
      assert.equal(await page.getByText('Stock levels').count(), 0, 'disconnect hides source metadata');

      assert.deepEqual(
        [...new Set(forwarded)].sort(),
        [
          'GET /files/:id',
          'GET /files/:id/content',
          'GET /files/library',
          'GET /files/usage',
          'GET /google-workspace',
          'GET /v1/google-workspace/availability',
          'POST /files/:id/recent-use',
          'POST /google-workspace/operations/files/content',
          'POST /google-workspace/operations/files/list',
          'POST /google-workspace/operations/files/metadata',
          'POST /google-workspace/operations/read',
          'PUT /files/:id/google-copy',
        ],
        'browsing, viewing, and copying use only Files and Google file routes',
      );
      assert.deepEqual(
        [...new Set(providerCalls)].sort(),
        [
          'GET /drive/v3/files',
          'GET /drive/v3/files/docR',
          'GET /drive/v3/files/docR/export',
          'GET /drive/v3/files/sheetR',
          'GET /v4/spreadsheets/sheetR',
          "GET /v4/spreadsheets/sheetR/values/'Warehouse'!A1:B2",
        ].sort(),
      );
      assert.ok(connected.integrationId);
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser?.close();
      await server?.close();
      await app?.close();
      await object?.close();
      if (provider) await new Promise(resolve => provider.close(resolve));
      await f.close();
    }
  },
);
