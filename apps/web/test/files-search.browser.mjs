import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

const shots = process.env.FILES_SCREENSHOTS ?? 'reports/check/files-browser';
const scope = name => `https://www.googleapis.com/auth/${name}`;
const integration = { integrationId: '0a000000-0000-4000-8000-00000000000a', accountId: 'google-a', generation: 1 };
const forecast = {
  id: 'forecastG',
  name: 'Q3 forecast',
  mimeType: 'application/vnd.google-apps.spreadsheet',
  modifiedTime: '2026-10-01T09:30:00.000Z',
  owners: [{ displayName: 'Sam Rivera' }],
  parents: ['rootG'],
};

test(
  'Files filters, sort, modified times, and All sources search with a failing Google source',
  { timeout: 240000 },
  async () => {
    const f = await knowledgeFixture();
    let server, browser;
    const errors = [],
      googleLists = [];
    const base = `/v1/workspaces/${f.workspace.id}/files`;
    try {
      const { workspace } = createWorkspaceFixture({
        id: f.workspace.id,
        userId: f.signed.owner.id,
        slug: 'files-search',
        name: 'Files search',
      });
      await f.db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [f.signed.owner.id, 'Files owner']);
      await f.db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [f.signed.admin.id, 'Ada Admin']);
      const admin = (
        await f.db.platform.query(`SELECT id FROM ${f.table('tf_memberships')} WHERE user_id=$1`, [f.signed.admin.id])
      ).rows[0].id;
      const ok = async (path, options) => {
        const result = await f.call(`${base}${path}`, options);
        assert.equal(result.status, 200, `${path}: ${result.bytes.toString()}`);
        return result.json();
      };
      const folder = async (name, parentId = null, cookie = f.signed.owner.cookie) =>
        (await ok(`/${randomUUID()}/folder`, { method: 'PUT', cookie, body: { name, parentId } })).id;
      const reports = await folder('Quarterly reports');
      await ok(`/${reports}/sharing`, {
        method: 'PUT',
        body: { subject: { kind: 'individual', id: admin }, role: 'editor' },
      });
      const supplier = await folder('Supplier Q3', null, f.signed.admin.cookie);
      await ok(`/${supplier}/sharing`, {
        method: 'PUT',
        cookie: f.signed.admin.cookie,
        body: { subject: { kind: 'individual', id: f.workspace.membershipId }, role: 'viewer' },
      });
      const files = [
        ['Q3 report.pdf', 'application/pdf', f.workspace.membershipId, reports, '2026-09-30T08:00:00Z'],
        [
          'Q3 budget.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          admin,
          reports,
          '2026-10-02T08:00:00Z',
        ],
        ['Q3 shelf photo.png', 'image/png', f.workspace.membershipId, reports, null],
        ['Q3 notes.docx', 'application/octet-stream', f.workspace.membershipId, null, '2026-09-12T08:00:00Z'],
        ['Q3 supplier list.csv', 'text/csv', admin, supplier, '2026-09-20T08:00:00Z'],
      ];
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready,object_key,media_type,size,sha256,modified_at)
      SELECT gen_random_uuid(),'file',r.owner,r.parent,r.name,true,gen_random_uuid(),r.media,1,repeat('a',64),r.modified
      FROM jsonb_to_recordset($1::jsonb) AS r(name text, media text, owner uuid, parent uuid, modified timestamptz)`,
        [
          JSON.stringify(
            files.map(([name, media, owner, parent, modified]) => ({ name, media, owner, parent, modified })),
          ),
        ],
      );

      const session = await f.signed.auth.api.getSession({ headers: new Headers({ cookie: f.signed.owner.cookie }) });
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
      browser = await chromium.launch();
      const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'UTC' });
      await context.addCookies(
        f.signed.owner.cookie.split('; ').map(cookie => {
          const at = cookie.indexOf('=');
          return {
            name: cookie.slice(0, at),
            value: cookie.slice(at + 1),
            url: origin,
            httpOnly: true,
            sameSite: 'Lax',
          };
        }),
      );
      const google = { hold: null, fail: 0 };
      const googleBase = `/v1/workspaces/${workspace.id}/google-workspace`;
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
                'access-control-allow-methods': 'GET,POST,PUT,PATCH,OPTIONS',
                'access-control-allow-headers': 'content-type',
              },
            });
          if (await serveWorkspaceShellEvent(route, workspace)) return;
          if (path.startsWith(base)) {
            const response = await fetch(`${f.origin}${path}${url.search}`, {
              method,
              headers: { cookie: f.signed.owner.cookie, origin: 'http://localhost:5173' },
            });
            return route.fulfill({
              status: response.status,
              body: Buffer.from(await response.arrayBuffer()),
              headers: { ...Object.fromEntries(response.headers), ...cors },
            });
          }
          if (path === `${googleBase}/operations/files/list`) {
            const body = request.postDataJSON();
            googleLists.push(body);
            assert.deepEqual(body.expectedIntegration, integration);
            if (google.hold) await google.hold;
            if (google.fail > 0) {
              google.fail--;
              return route.fulfill({ status: 503, json: { error: 'unavailable' }, headers: cors });
            }
            return route.fulfill({
              json: {
                files: body.name && 'q3 forecast'.includes(body.name.toLowerCase()) ? [forecast] : [],
                incompleteSearch: false,
              },
              headers: cors,
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
                membershipId: f.workspace.membershipId,
                role: 'member',
                teams: [],
                capabilities: { manageGovernance: false, canLeave: true },
              },
            ],
            [
              `/v1/workspaces/${workspace.id}/credits`,
              { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
            ],
            ['/v1/google-workspace/availability', { configured: true }],
            [
              googleBase,
              {
                status: 'connected',
                ...integration,
                email: 'owner@example.test',
                scopes: [scope('drive.readonly'), scope('drive')],
              },
            ],
          ]);
          assert.ok(shell.has(path), `Unexpected browser route ${method} ${path}`);
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
      // Cloud 95c3b7db (#837) replaced the native selects with listbox Selects (features/files/filters.tsx:30-74).
      const choose = async (scope, label, option) => {
        await scope.getByRole('combobox', { name: label, exact: true }).first().click();
        await page.getByRole('option', { name: option, exact: true }).click();
      };
      const names = async () =>
        (await main.getByRole('table').getByRole('link').allTextContents()).map(name => name.trim());
      async function settles(read, expected, message) {
        for (let at = Date.now(); Date.now() - at < 10000; await page.waitForTimeout(100)) {
          if (JSON.stringify(await read().catch(() => null)) === JSON.stringify(expected)) return;
        }
        assert.deepEqual(await read(), expected, message);
      }
      const listed = (expected, message) => settles(names, expected, message);
      const search = () => Object.fromEntries(new URL(page.url()).searchParams);
      await mkdir(shots, { recursive: true });

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${origin}/${workspace.slug}/files?q=Q3`);
      await main.getByRole('link', { name: 'Q3 report.pdf' }).waitFor();
      assert.deepEqual(
        await names(),
        ['Q3 budget.xlsx', 'Q3 notes.docx', 'Q3 report.pdf', 'Q3 shelf photo.png'],
        'My files search covers everything inside owned folders, by name',
      );
      const row = name => main.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
      assert.match(await row('Q3 report.pdf').innerText(), /In Quarterly reports/);
      assert.match(await row('Q3 budget.xlsx').innerText(), /Ada Admin · Can manage/);
      assert.match(await row('Q3 report.pdf').innerText(), /Sep 30, 2026/);
      assert.match(
        await row('Q3 shelf photo.png').innerText(),
        /—/,
        'a legacy row shows an unknown modified time, not its created time',
      );
      assert.match(await row('Q3 notes.docx').innerText(), /In My files/);

      await choose(main, 'Sort', 'Modified, newest first');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('sort') === 'modified');
      await listed(
        ['Q3 budget.xlsx', 'Q3 report.pdf', 'Q3 notes.docx', 'Q3 shelf photo.png'],
        'newest first, unknown modified time last',
      );

      await choose(main, 'Type', 'PDFs');
      await listed(['Q3 report.pdf']);
      assert.equal(search().type, 'pdf', 'filters live in the URL');
      await choose(main, 'Type', 'Documents');
      await listed(['Q3 notes.docx'], 'an octet-stream .docx is a document by its extension');

      await page.goto(`${origin}/${workspace.slug}/files?folder=${reports}`);
      await main.getByRole('link', { name: 'Q3 budget.xlsx' }).waitFor();
      await main.getByRole('combobox', { name: 'Owner', exact: true }).first().click();
      assert.deepEqual(await page.getByRole('listbox').getByRole('option').allTextContents(), [
        'Anyone',
        'Owned by me',
        'Owned by others',
        'Ada Admin',
      ]);
      await page.getByRole('option', { name: 'Ada Admin', exact: true }).click();
      await listed(['Q3 budget.xlsx'], 'a specific owner from the folder');
      await choose(main, 'Modified', 'Custom range');
      await main.getByLabel('From', { exact: true }).first().fill('2026-10-03');
      await main.getByText('No files match these filters').waitFor();
      await page.screenshot({ path: `${shots}/filters-empty-1280.png` });
      await main.getByRole('button', { name: 'Clear filters' }).first().click();
      await main.getByRole('link', { name: 'Q3 shelf photo.png' }).waitFor();
      assert.equal(search().owner, undefined);
      await page.screenshot({ path: `${shots}/filters-modified-1280.png` });

      let release;
      google.hold = new Promise(resolve => {
        release = resolve;
      });
      google.fail = 3;
      await page.goto(`${origin}/${workspace.slug}/files?q=Q3`);
      await main.getByRole('link', { name: 'Q3 report.pdf' }).waitFor();
      await main.getByRole('group', { name: 'Search in' }).getByRole('button', { name: 'All sources' }).click();
      const group = name => main.getByRole('region', { name, exact: true });
      await group('My files').getByRole('link', { name: 'Q3 notes.docx' }).waitFor();
      await group('Shared with me').getByRole('link', { name: 'Q3 supplier list.csv' }).waitFor();
      await group('Google Drive').getByRole('status', { name: 'Searching Google Drive' }).waitFor();
      assert.equal(search().scope, 'all');
      assert.match(
        await group('Shared with me').innerText(),
        /Shared with me · In Supplier Q3 · Ada Admin · Modified Sep 20, 2026/,
        'results show source, folder, owner, and modified time',
      );
      google.hold = null;
      release();
      await group('Google Drive').getByText('Couldn’t search Google Drive. Other results are still shown.').waitFor();
      assert.equal(
        await group('My files').getByRole('link', { name: 'Q3 report.pdf' }).count(),
        1,
        'a failed Google search keeps the TulipFarm results',
      );
      await page.screenshot({ path: `${shots}/all-sources-google-failed-1280.png` });
      await group('Google Drive').getByRole('button', { name: 'Retry' }).click();
      await group('Google Drive').getByRole('link', { name: 'Q3 forecast' }).waitFor();
      assert.match(await group('Google Drive').innerText(), /Google Drive · Sam Rivera · Modified Oct 1, 2026/);
      assert.deepEqual(
        googleLists.map(body => [body.name, body.pageSize]),
        Array(4).fill(['Q3', 20]),
        'three automatic attempts fail, then Retry succeeds',
      );

      await choose(main, 'Type', 'PDFs');
      await settles(
        () => group('My files').getByRole('list').getByRole('link').allTextContents(),
        ['Q3 report.pdf'],
        'filters apply to each TulipFarm source',
      );
      await group('Shared with me').getByText('No matches in Shared with me.').waitFor();
      await group('Google Drive')
        .getByText('Google Drive results match names only. Filters apply to TulipFarm files.')
        .waitFor();
      await main.getByRole('button', { name: 'Clear filters' }).first().click();
      await group('Shared with me').getByRole('link', { name: 'Q3 supplier list.csv' }).waitFor();

      await page.setViewportSize({ width: 375, height: 800 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        'All sources fits 375',
      );
      await page.screenshot({ path: `${shots}/all-sources-375.png`, fullPage: true });
      await main.getByRole('group', { name: 'Search in' }).getByRole('button', { name: 'My files' }).click();
      await main.getByRole('link', { name: 'Q3 report.pdf' }).waitFor();
      assert.equal(search().scope, undefined);
      await main.getByRole('button', { name: 'Filter and sort' }).click();
      const sheet = page.getByRole('dialog', { name: 'Filter and sort' });
      await choose(sheet, 'Type', 'Images');
      await sheet.getByRole('button', { name: 'Show results' }).waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/filters-sheet-375.png` });
      await sheet.getByRole('button', { name: 'Show results' }).click();
      await sheet.waitFor({ state: 'detached' });
      await main.getByRole('button', { name: 'Filters (1)' }).waitFor();
      await listed(['Q3 shelf photo.png']);
      assert.match(await row('Q3 shelf photo.png').innerText(), /Image · Modified unknown/);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        'filtered library fits 375',
      );
      await page.screenshot({ path: `${shots}/filters-375.png` });
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser?.close();
      await server?.close();
      await f.close();
    }
  },
);
