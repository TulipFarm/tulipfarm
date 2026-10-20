import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';
import { chooseOption, assertVisibleFocus, captureEvidence, evidenceBrowserArgs } from './browser-controls.mjs';

const shots = process.env.FILES_SCREENSHOTS ?? 'reports/check/files-browser';

test(
  'Files library and viewer over authenticated HTTP with injected transport faults',
  { timeout: 240000 },
  async () => {
    const f = await knowledgeFixture();
    let server, browser;
    const errors = [];
    const base = `/v1/workspaces/${f.workspace.id}/files`;
    try {
      const { workspace } = createWorkspaceFixture({
        id: f.workspace.id,
        userId: f.signed.owner.id,
        slug: 'files-live',
        name: 'Files live',
      });
      await f.db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [f.signed.owner.id, 'Files owner']);
      await f.db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [f.signed.admin.id, 'Ada Admin']);
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
      browser = await chromium.launch({ args: evidenceBrowserArgs() });
      const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
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
      const faults = { reads: false, uploads: 0, delay: undefined, upload: undefined, writes: new Set() };
      const contentReads = [],
        writes = [];
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
            if (faults.delay && !path.endsWith('/usage')) {
              const wait = faults.delay;
              faults.delay = undefined;
              await wait;
            }
            if (method === 'PUT' && path.endsWith('/content') && faults.upload) {
              const wait = faults.upload;
              faults.upload = undefined;
              await wait;
            }
            if (method === 'GET' && faults.reads && !path.endsWith('/usage'))
              return route.fulfill({ status: 503, json: { error: 'files-unavailable' }, headers: cors });
            if (method === 'PUT' && path.endsWith('/content') && faults.uploads > 0) {
              faults.uploads--;
              return route.fulfill({ status: 503, json: { error: 'files-unavailable' }, headers: cors });
            }
            if (faults.writes.delete(`${method} ${path.slice(base.length)}`))
              return route.fulfill({ status: 503, json: { error: 'files-unavailable' }, headers: cors });
            if (method === 'GET' && path.endsWith('/content')) contentReads.push(path);
            if (method !== 'GET') writes.push(`${method} ${path.slice(base.length)}`);
            const body = request.postDataBuffer();
            const response = await fetch(`${f.origin}${path}${url.search}`, {
              method,
              headers: {
                cookie: f.signed.owner.cookie,
                origin: 'http://localhost:5173',
                ...(request.headers()['content-type'] ? { 'content-type': request.headers()['content-type'] } : {}),
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
            [`/v1/workspaces/${workspace.id}/google-workspace`, { status: 'disconnected' }],
          ]);
          assert.ok(shell.has(path), `Unexpected browser route ${method} ${path}`);
          assert.equal(method, path === '/v1/user/visit' ? 'POST' : 'GET', `Unexpected shell method: ${path}`);
          return route.fulfill({ status: 200, json: shell.get(path), headers: cors });
        } catch (error) {
          errors.push(error);
          await route.abort().catch(() => {});
        }
      });
      await context.addInitScript(() => {
        window.fileUrls = new Set();
        const create = URL.createObjectURL.bind(URL),
          revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => {
          const url = create(blob);
          window.fileUrls.add(url);
          return url;
        };
        URL.revokeObjectURL = url => {
          window.fileUrls.delete(url);
          revoke(url);
        };
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error));
      const text = (value, options = {}) => page.getByText(value, { exact: true, ...options });
      const focusSettles = async (label, message) => {
        await page
          .waitForFunction(expected => document.activeElement?.getAttribute('aria-label') === expected, label, {
            timeout: 2000,
          })
          .catch(() => {});
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), label, message);
      };
      const main = page.getByRole('main');
      const focused = () => page.evaluate(() => document.activeElement?.textContent ?? '');
      const unloadBlocked = () =>
        page.evaluate(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        });

      let release;
      faults.delay = new Promise(resolve => {
        release = resolve;
      });
      await page.goto(`${origin}/${workspace.slug}/files`);
      await page.getByRole('status', { name: 'Loading files' }).waitFor();
      assert.equal(await text('No files yet').count(), 0, 'empty state never flashes before the first response');
      release();
      await text('No files yet').waitFor();
      await mkdir(shots, { recursive: true });
      await page.screenshot({ path: `${shots}/empty-1280.png` });
      assert.equal(await main.getByRole('button', { name: 'Upload' }).count(), 2, 'first use offers the page actions');

      faults.reads = true;
      await page.getByRole('link', { name: 'Shared with me' }).click();
      await text('Couldn’t load files').waitFor();
      assert.equal(await text('Nothing shared with you yet').count(), 0, 'a failed read is never labelled empty');
      let hold;
      faults.delay = new Promise(resolve => {
        hold = resolve;
      });
      await page.getByRole('button', { name: 'Retry loading files' }).click();
      await page.getByRole('status', { name: 'Loading files' }).waitFor();
      hold();
      await page.getByRole('button', { name: 'Retry loading files' }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Retry loading files' }).isEnabled(),
        true,
        'a failed retry returns to an actionable error',
      );
      faults.reads = false;
      await page.getByRole('button', { name: 'Retry loading files' }).click();
      await text('Nothing shared with you yet').waitFor();
      assert.equal(
        await main.getByRole('button', { name: 'Upload' }).count(),
        0,
        'Shared with me root is not a write destination',
      );
      await page.getByRole('link', { name: 'Trash', exact: true }).click();
      await text('Trash is empty').waitFor();
      await page.getByRole('link', { name: 'Google Drive' }).click();
      await page.getByRole('heading', { name: 'Connect Google Drive' }).waitFor();
      assert.equal(
        await page.getByRole('table', { name: 'Files and folders' }).count(),
        0,
        'a disconnected Google source is not an empty list',
      );
      await page.getByRole('link', { name: 'My files' }).click();
      await text('No files yet').waitFor();

      await main.getByRole('button', { name: 'New folder' }).last().click();
      await page.getByLabel('Folder name').fill('Operations');
      await page.getByRole('button', { name: 'Create folder' }).click();
      await text('Folder “Operations” created.').waitFor();
      await page
        .waitForFunction(() => document.activeElement?.textContent?.includes('Folder “Operations” created.'), null, {
          timeout: 2000,
        })
        .catch(() => {});
      assert.match(
        await focused(),
        /Folder “Operations” created\./,
        'focus moves to the outcome after the empty state that held New folder unmounts',
      );

      let finish;
      faults.upload = new Promise(resolve => {
        finish = resolve;
      });
      assert.equal(await unloadBlocked(), false, 'an idle queue never blocks leaving');
      await page.locator('input[type=file]').setInputFiles({
        name: 'queued-notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Queued while browsing.'),
      });
      await text('Uploading 1 of 1…').waitFor();
      assert.equal(await unloadBlocked(), true, 'leaving the tab warns while a transfer is active');
      await page.getByRole('link', { name: 'Trash', exact: true }).click();
      await text('Trash is empty').waitFor();
      await text('Uploading 1 of 1…').waitFor();
      await page.getByRole('link', { name: 'Operations', exact: true }).waitFor({ state: 'detached' });
      finish();
      await text('1 file uploaded').waitFor();
      assert.equal(await unloadBlocked(), false, 'the warning ends with the transfer');
      await page.getByRole('link', { name: 'My files' }).click();
      await page.getByRole('link', { name: 'queued-notes.txt', exact: true }).waitFor();
      await text('1 file uploaded').waitFor();
      await page.getByRole('button', { name: 'Dismiss finished' }).click();
      await page.getByRole('link', { name: 'Operations', exact: true }).click();
      await text('This folder is empty').waitFor();
      await page.getByRole('navigation', { name: 'Folder path' }).getByText('Operations', { exact: true }).waitFor();

      const name = '供应商手册-Long supplier handbook and returns policy for every regional warehouse.md';
      const body = Buffer.from('# Supplier policy\n\nReturn unopened supplies within thirty days.');
      const writesBefore = writes.length;
      faults.uploads = 1;
      await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/markdown', buffer: body });
      await text('0 uploaded, 1 failed').waitFor();
      await page.screenshot({ path: `${shots}/upload-failed-1280.png` });
      await page.getByRole('button', { name: `Retry uploading ${name}` }).click();
      await text('1 file uploaded').waitFor();
      await page.getByRole('link', { name, exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('table', { name: 'Files and folders' })
          .getByRole('row')
          .filter({ has: page.getByRole('cell') })
          .count(),
        1,
        'a retried upload creates one file',
      );
      const uploadsSent = writes
        .slice(writesBefore)
        .filter(write => write.startsWith('PUT') && write.endsWith('/content'));
      assert.equal(new Set(uploadsSent).size, 1, 'retry reuses the same file id');
      await page.getByRole('button', { name: 'Dismiss finished' }).click();

      await page.getByRole('button', { name: `More actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      const renamed = `${name.replace('.md', '')} v2.md`;
      await page.getByLabel('Name', { exact: true }).fill(renamed);
      await page.getByRole('button', { name: 'Rename', exact: true }).click();
      await text(`Renamed to “${renamed}”.`).waitFor();
      await page.getByRole('link', { name: renamed, exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        `More actions for ${renamed}`,
        'focus returns to the item menu after the dialog',
      );

      const libraryUrl = page.url();
      await page.getByRole('link', { name: renamed, exact: true }).click();
      await text('Return unopened supplies within thirty days.').waitFor();
      await page.getByRole('heading', { name: renamed, level: 1 }).waitFor();
      const before = contentReads.length;
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download' }).click();
      const saved = await download;
      assert.equal(saved.suggestedFilename(), renamed);
      assert.deepEqual(await readFile(await saved.path()), body);
      assert.equal(contentReads.length, before + 1, 'download authorizes and fetches fresh content');
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.screenshot({ path: `${shots}/viewer-1280.png` });
      await page.getByRole('button', { name: 'More file actions' }).click();
      await page.getByRole('menuitem', { name: 'Details' }).click();
      await page.getByRole('dialog').getByText('My files / Operations').waitFor();
      await page.getByRole('dialog').getByText('Markdown', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await focusSettles('More file actions', 'focus returns to the viewer menu');
      await main.getByRole('link', { name: 'Files', exact: true }).click();
      await page.getByRole('link', { name: renamed, exact: true }).waitFor();
      assert.equal(page.url(), libraryUrl, 'returning from the viewer restores the folder');
      await page.waitForFunction(() => window.fileUrls.size === 0);
      await page.goBack();
      await text('Return unopened supplies within thirty days.').waitFor();
      await page.goBack();
      await page.getByRole('link', { name: renamed, exact: true }).waitFor();

      for (let index = 0; index < 30; index++)
        assert.equal(
          (
            await f.call(`${base}/${randomUUID()}/folder`, {
              method: 'PUT',
              body: { name: `Region ${String(index).padStart(2, '0')}`, parentId: null },
            })
          ).status,
          200,
        );
      await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'My files' }).click();
      await page.getByRole('link', { name: 'Region 29' }).scrollIntoViewIfNeeded();
      const scroller = page.locator('[data-scroll-restoration-id="files-library"]');
      const offset = await scroller.evaluate(element => element.scrollTop);
      assert.ok(offset > 100, `list scrolled (${offset})`);
      await page.getByRole('link', { name: 'Region 29' }).click();
      await text('This folder is empty').waitFor();
      await page.goBack();
      await page.getByRole('link', { name: 'Region 29' }).waitFor();
      await page.waitForFunction(
        expected =>
          Math.abs(document.querySelector('[data-scroll-restoration-id="files-library"]').scrollTop - expected) < 20,
        offset,
      );

      for (const cursor of ['not-a-cursor', randomUUID()]) {
        await page.goto(`${origin}/${workspace.slug}/files?after=${cursor}`);
        await text('This page link no longer works. Showing the first page.').waitFor();
        await page.getByRole('link', { name: 'Operations', exact: true }).waitFor();
        assert.equal(
          new URL(page.url()).searchParams.has('after'),
          false,
          `an unusable cursor (${cursor}) resets to the first page`,
        );
        assert.equal(
          await page.getByRole('button', { name: 'Retry loading files' }).count(),
          0,
          'no retry is offered for a link that can never load',
        );
      }

      await page.getByRole('link', { name: 'Trash', exact: true }).click();
      await text('Trash is empty').waitFor();
      faults.reads = true;
      await page.getByRole('link', { name: 'My files' }).click();
      await text('Couldn’t refresh files. The last loaded list is still shown.').waitFor();
      await page.getByRole('link', { name: 'Operations', exact: true }).waitFor();
      faults.reads = false;
      await page.getByRole('button', { name: 'Retry loading files' }).click();
      await text('Couldn’t refresh files. The last loaded list is still shown.').waitFor({ state: 'detached' });

      await page.getByRole('searchbox', { name: 'Search My files' }).fill('供应商');
      await page.getByRole('link', { name: renamed, exact: true }).waitFor();
      assert.match(page.url(), /q=/);
      await page.getByRole('searchbox', { name: 'Search My files' }).fill('no-such-file');
      await text('No files match “no-such-file”').waitFor();
      assert.equal(
        await page.getByRole('searchbox', { name: 'Search My files' }).inputValue(),
        'no-such-file',
        'the query stays editable',
      );
      await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
      await page.getByRole('link', { name: 'Operations', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Operations', exact: true }).click();
      await page.getByRole('link', { name: renamed, exact: true }).waitFor();
      await page.getByRole('searchbox', { name: 'Search My files' }).fill('no-such-file');
      await text('No files match “no-such-file”').waitFor();
      await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
      await page.getByRole('navigation', { name: 'Folder path' }).getByText('Operations', { exact: true }).waitFor();
      await page.getByRole('link', { name: renamed, exact: true }).waitFor();
      await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'My files' }).click();
      await page.getByRole('link', { name: 'Region 00' }).waitFor();

      await page.getByRole('button', { name: 'More actions for Region 00' }).click();
      await page.getByRole('menuitem', { name: 'Move to trash' }).click();
      await text('“Region 00” moved to Trash.').waitFor();
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent),
        'Undo',
        'focus moves to Undo after the row leaves',
      );
      await page.getByRole('button', { name: 'Undo' }).click();
      await text('“Region 00” restored to its original location.').waitFor();
      await page
        .waitForFunction(
          () => document.activeElement?.textContent?.includes('restored to its original location'),
          null,
          { timeout: 2000 },
        )
        .catch(() => {});
      assert.match(await focused(), /“Region 00” restored/, 'focus moves to the outcome after Undo unmounts');
      await page.getByRole('link', { name: 'Region 00' }).waitFor();
      await page.getByRole('button', { name: 'More actions for Region 01' }).click();
      await page.getByRole('menuitem', { name: 'Move to trash' }).click();
      await page.getByRole('link', { name: 'Trash', exact: true }).click();
      await page.getByRole('button', { name: 'Restore Region 01' }).click();
      await text('“Region 01” restored to its original location.').waitFor();
      await page
        .waitForFunction(
          () => document.activeElement?.textContent?.includes('restored to its original location'),
          null,
          { timeout: 2000 },
        )
        .catch(() => {});
      assert.match(
        await focused(),
        /“Region 01” restored/,
        'focus moves to the outcome after the restored row leaves Trash',
      );
      await text('Trash is empty').waitFor();

      const shared = (
        await f.call(`${base}/${randomUUID()}/folder`, {
          method: 'PUT',
          cookie: f.signed.admin.cookie,
          body: { name: 'Purchasing (read only)', parentId: null },
        })
      ).json().id;
      assert.equal(
        (
          await f.call(`${base}/${shared}/sharing`, {
            method: 'PUT',
            cookie: f.signed.admin.cookie,
            body: { subject: { kind: 'individual', id: f.workspace.membershipId }, role: 'viewer' },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.call(`${base}/${randomUUID()}/folder`, {
            method: 'PUT',
            cookie: f.signed.admin.cookie,
            body: { name: 'Admin private', parentId: null },
          })
        ).status,
        200,
      );
      await page.getByRole('link', { name: 'Shared with me' }).click();
      await page.getByRole('link', { name: 'Purchasing (read only)' }).waitFor();
      assert.equal(await text('Admin private').count(), 0, "a workspace admin's unshared folder stays hidden");
      await text('Ada Admin · Can view').first().waitFor();
      await page.getByRole('link', { name: 'Purchasing (read only)' }).click();
      await text('Nothing has been added here yet. You can view this folder but not add to it.').waitFor();
      assert.equal(await main.getByRole('button', { name: 'Upload' }).count(), 0, 'a viewer folder offers no upload');
      assert.equal(await page.getByRole('checkbox').count(), 0, 'a viewer folder offers nothing to select');

      await page.getByRole('link', { name: 'My files' }).click();
      await page.getByRole('link', { name: 'Operations', exact: true }).waitFor();
      for (const width of [1280, 1024, 768, 414, 375, 320]) {
        await page.setViewportSize({ width, height: 850 });
        await page.emulateMedia({ colorScheme: width === 375 ? 'dark' : 'light', reducedMotion: 'reduce' });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
          `no horizontal page scroll at ${width}`,
        );
        const named = await page.getByRole('link', { name: 'Operations', exact: true }).boundingBox();
        assert.ok(named && named.width >= 60, `item names keep their width at ${width} (${named?.width})`);
        await page.screenshot({ path: `${shots}/library-${width}.png` });
      }
      await chooseOption(page, page.getByLabel('Section', { exact: true }), 'Trash');
      await text('Trash is empty').waitFor();
      await chooseOption(page, page.getByLabel('Section', { exact: true }), 'My files');
      await page.getByRole('link', { name: 'Operations', exact: true }).click();
      await page.getByRole('link', { name: renamed, exact: true }).click();
      await text('Return unopened supplies within thirty days.').waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        'viewer has no horizontal page scroll at 320',
      );
      await page.screenshot({ path: `${shots}/viewer-320.png` });
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.emulateMedia({ colorScheme: 'light' });
      await main.getByRole('link', { name: 'Files', exact: true }).focus();
      let reached = false;
      for (let step = 0; step < 40 && !reached; step++) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => document.activeElement?.textContent === 'Download');
      }
      assert.equal(reached, true, 'keyboard reaches the viewer action');

      const fileId = new URL(page.url()).pathname.split('/').at(-1);
      assert.equal((await f.call(`${base}/${fileId}/trash`, { method: 'PUT', body: { trashed: true } })).status, 200);
      await page.getByRole('button', { name: 'Download' }).click();
      await text('You can’t open this file').waitFor();
      assert.equal(await text('Return unopened supplies within thirty days.').count(), 0);
      assert.equal(await page.getByText(renamed).count(), 0, 'denial shows no file metadata');
      await page.waitForFunction(() => window.fileUrls.size === 0);
      await page.getByRole('link', { name: 'Back to Files' }).click();
      await text('This folder is empty').waitFor();
      assert.equal(await page.getByText(renamed).count(), 0, 'the trashed file leaves the cached folder listing');

      const milo = await f.signed.signIn(),
        miloMembership = randomUUID(),
        team = randomUUID();
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        miloMembership,
        milo.id,
      ]);
      await f.db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [milo.id, 'Milo Member']);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Purchasing team')`, [team]);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        miloMembership,
        team,
      ]);
      const miloEmail = (await f.db.platform.query('SELECT email FROM app.users WHERE id=$1', [milo.id])).rows[0].email;
      const named = async (name, query = 'section=mine') =>
        (await f.call(`${base}/library?${query}&query=${encodeURIComponent(name)}`))
          .json()
          .items.find(item => item.name === name);
      const miloShared = async () =>
        (await f.call(`${base}/library?section=shared`, { cookie: milo.cookie })).json().items.map(item => item.name);
      const dialog = page.getByRole('dialog');
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });

      await page.getByRole('navigation', { name: 'Files sections' }).getByRole('link', { name: 'My files' }).click();
      await page.getByRole('button', { name: 'More actions for Region 02' }).click();
      await page.getByRole('menuitem', { name: 'Share' }).click();
      await dialog.getByText('Files owner (you)', { exact: true }).waitFor();
      await chooseOption(page, dialog.getByLabel('Person or team'), `Milo Member (${miloEmail})`);
      await chooseOption(page, dialog.getByLabel('Access', { exact: true }), 'Can edit');
      await dialog.getByRole('button', { name: 'Share', exact: true }).click();
      await dialog.getByText('Shared with Milo Member.').waitFor();
      assert.deepEqual(
        await miloShared(),
        ['Region 02'],
        "a grant made in the dialog appears in the other member's Shared with me",
      );
      const region02 = await named('Region 02');
      faults.writes.add(`PUT /${region02.id}/sharing`);
      await chooseOption(page, dialog.getByLabel('Access for Milo Member', { exact: true }), 'Can manage');
      await dialog.getByText('We couldn’t confirm this change. The list shows the last confirmed access.').waitFor();
      await dialog
        .getByRole('combobox', { name: 'Access for Milo Member', exact: true })
        .getByText('Can edit', { exact: true })
        .waitFor();
      await chooseOption(page, dialog.getByLabel('Access for Milo Member', { exact: true }), 'Can manage');
      await dialog.getByText('Milo Member can now manage.').waitFor();
      await page.screenshot({ path: `${shots}/sharing-1280.png` });
      await dialog.getByRole('button', { name: 'Remove access for Milo Member' }).click();
      await dialog.getByText('Removed access for Milo Member.').waitFor();
      assert.deepEqual(
        await miloShared(),
        [],
        "removing the grant removes the item from the other member's Shared with me",
      );
      await dialog.getByRole('button', { name: 'Done' }).click();
      await dialog.waitFor({ state: 'detached' });
      await focusSettles('More actions for Region 02', 'focus returns to the item menu after sharing');

      const operations = await named('Operations');
      assert.equal(
        (
          await f.call(`${base}/${operations.id}/sharing`, {
            method: 'PUT',
            body: { subject: { kind: 'team', id: team }, role: 'viewer' },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.call(`${base}/${randomUUID()}/folder`, {
            method: 'PUT',
            body: { name: 'Contracts', parentId: operations.id },
          })
        ).status,
        200,
      );
      await page.getByRole('link', { name: 'Operations', exact: true }).click();
      await page.getByRole('button', { name: 'More actions for Contracts' }).click();
      await page.getByRole('menuitem', { name: 'Share' }).click();
      await dialog.getByText('From “Operations”').waitFor();
      await dialog.getByText('Purchasing team (team)').waitFor();
      assert.equal(
        await dialog.getByRole('button', { name: /Remove access for Purchasing team/ }).count(),
        0,
        'inherited access cannot be removed on the child',
      );
      await dialog.getByRole('button', { name: 'Copy link' }).click();
      await dialog.getByText('Link copied. Copying a link doesn’t give anyone access.').waitFor();
      const contracts = await named('Contracts');
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        `${origin}/${workspace.slug}/files?folder=${contracts.id}`,
      );
      await page.setViewportSize({ width: 375, height: 760 });
      await page.screenshot({ path: `${shots}/sharing-inherited-375.png` });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        'sharing dialog fits 375',
      );
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'More actions for Contracts' }).click();
      await page.getByRole('menuitem', { name: 'Details' }).click();
      await dialog.getByText('My files / Operations').waitFor();
      await dialog.getByText('2 people, counting teams and folders').waitFor();
      await page.screenshot({ path: `${shots}/details-1280.png` });
      await dialog.getByRole('button', { name: 'Done' }).click();

      await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'My files' }).click();
      await page.getByRole('button', { name: 'More actions for Region 03' }).click();
      await page.getByRole('menuitem', { name: 'Move', exact: true }).click();
      await dialog.getByRole('button', { name: 'Operations', exact: true }).click();
      await dialog.getByRole('button', { name: 'Review move to “Operations”' }).click();
      await dialog.getByText('Gains access: Milo Member.').waitFor();
      await page.screenshot({ path: `${shots}/move-review-1280.png` });
      assert.equal(
        (
          await f.call(`${base}/${operations.id}/sharing`, {
            method: 'PUT',
            body: { subject: { kind: 'individual', id: f.adminMembership }, role: 'viewer' },
          })
        ).status,
        200,
      );
      await dialog.getByRole('button', { name: 'Move 1 item', exact: true }).click();
      await dialog
        .getByText('Access changed since you reviewed it. Check the update below, then move again.')
        .waitFor();
      await dialog.getByText('Gains access: Ada Admin, Milo Member.').waitFor();
      assert.equal((await named('Region 03')).parentId, null, 'a stale review moves nothing');
      await dialog.getByRole('button', { name: 'Move 1 item with updated access' }).click();
      await text('Moved “Region 03” to “Operations”.').waitFor();
      assert.equal((await named('Region 03')).parentId, operations.id);
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent?.includes('Moved “Region 03”')),
        true,
        'focus moves to the outcome after the moved row leaves',
      );

      const [r05, r07] = await Promise.all(['Region 05', 'Region 07'].map(name => named(name)));
      const fileTable = page.getByRole('table', { name: 'Files and folders', exact: true });
      const firstSelected = page.getByRole('checkbox', { name: 'Select Region 04', exact: true });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await firstSelected.scrollIntoViewIfNeeded();
        await firstSelected.focus();
        const geometry = async () => ({
          list: await fileTable.evaluate(node => node.getBoundingClientRect().top),
          row: await firstSelected.evaluate(
            node => node.closest('[data-slot="data-list-row"]').getBoundingClientRect().top,
          ),
        });
        const before = await geometry();
        await page.keyboard.press('Space');
        await page.getByRole('toolbar', { name: 'Selected items' }).waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const selectedGeometry = await geometry();
        for (const key of Object.keys(before))
          assert.ok(
            Math.abs(before[key] - selectedGeometry[key]) <= 1,
            `${width}px file selection keeps ${key} stable`,
          );
        const clear = page.getByRole('button', { name: 'Clear selection', exact: true });
        await clear.focus();
        await page.keyboard.press('Enter');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const clearedGeometry = await geometry();
        for (const key of Object.keys(before))
          assert.ok(
            Math.abs(before[key] - clearedGeometry[key]) <= 1,
            `${width}px clearing file selection keeps ${key} stable`,
          );
        assert.equal(
          await firstSelected.evaluate(node => node === document.activeElement),
          true,
          'Clearing file selection restores checkbox focus',
        );
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      for (const name of ['Region 04', 'Region 05', 'Region 06'])
        await page.getByRole('checkbox', { name: `Select ${name}` }).check();
      const toolbar = page.getByRole('toolbar', { name: 'Selected items' });
      const selectedAction = async name => {
        const direct = toolbar.getByRole('button', { name, exact: true });
        if (await direct.isVisible()) return direct;
        await toolbar.getByRole('button', { name: 'Selected actions', exact: true }).click();
        return page.getByRole('menuitem', { name, exact: true });
      };
      await toolbar.getByText('3 items selected').waitFor();
      faults.writes.add(`PUT /${r05.id}/trash`);
      await (await selectedAction('Move to trash')).focus();
      await page.keyboard.press('Enter');
      await text('2 items moved to Trash. 1 item needs attention.').waitFor();
      await page.waitForFunction(
        () => document.activeElement?.textContent?.includes('2 items moved to Trash. 1 item needs attention.'),
        null,
        { timeout: 2000 },
      );
      await assertVisibleFocus(page);
      assert.equal(
        await page.getByRole('alert').getByRole('status').count(),
        0,
        'the partial outcome is announced once, as an alert',
      );
      await page
        .getByText('“Region 05”: We couldn’t confirm whether it moved to Trash. Refresh the list to check.')
        .waitFor();
      assert.equal(
        await page.getByRole('checkbox', { name: 'Select Region 05' }).isChecked(),
        true,
        'the failed item stays selected',
      );
      await page.getByRole('link', { name: 'Region 04', exact: true }).waitFor({ state: 'detached' });
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await captureEvidence(page, `${shots}/bulk-partial-${width}.png`);
      }
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.getByRole('checkbox', { name: 'Select Region 07' }).check();
      faults.writes.add(`PUT /${r07.id}/parent`);
      await (await selectedAction('Move')).click();
      await dialog.getByRole('button', { name: 'Operations', exact: true }).click();
      await dialog.getByRole('button', { name: 'Review move to “Operations”' }).click();
      await dialog.getByRole('button', { name: 'Move 2 items', exact: true }).click();
      await dialog
        .getByText('We couldn’t confirm this move. Check where the item is before moving it again.')
        .waitFor();
      await dialog.getByText('Moved', { exact: true }).waitFor();
      await page.setViewportSize({ width: 375, height: 760 });
      await page.screenshot({ path: `${shots}/move-partial-375.png` });
      await page.setViewportSize({ width: 1280, height: 850 });
      await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
      await text('1 item moved to “Operations”. 1 item needs attention.').waitFor();
      assert.equal(await page.getByRole('checkbox', { name: 'Select Region 07' }).isChecked(), true);
      assert.deepEqual(
        [
          (await named('Region 05')).parentId,
          (await named('Region 06', 'section=trash'))?.trashed,
          (await named('Region 07')).parentId,
        ],
        [operations.id, true, null],
      );

      const drop = (
        await f.call(`${base}/${randomUUID()}/folder`, {
          method: 'PUT',
          cookie: f.signed.admin.cookie,
          body: { name: 'Team drop', parentId: null },
        })
      ).json().id;
      assert.equal(
        (
          await f.call(`${base}/${drop}/sharing`, {
            method: 'PUT',
            cookie: f.signed.admin.cookie,
            body: { subject: { kind: 'individual', id: f.workspace.membershipId }, role: 'editor' },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.call(`${base}/${randomUUID()}/folder`, {
            method: 'PUT',
            body: { name: 'My supplier notes', parentId: drop },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.call(`${base}/${drop}/trash`, {
            method: 'PUT',
            cookie: f.signed.admin.cookie,
            body: { trashed: true },
          })
        ).status,
        200,
      );
      await page.getByRole('navigation', { name: 'Files sections' }).getByRole('link', { name: 'Trash' }).click();
      await text('Its folder was moved to Trash by its owner').waitFor();
      await page.screenshot({ path: `${shots}/trash-stranded-1280.png` });
      await page.setViewportSize({ width: 375, height: 760 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        'stranded Trash row fits 375',
      );
      await page.screenshot({ path: `${shots}/trash-stranded-375.png` });
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.getByRole('button', { name: 'Restore My supplier notes to a folder you choose' }).click();
      await dialog
        .getByText(
          'Its original folder is in Trash, or you can no longer add to it. Choose where to put it instead. Links stay the same.',
        )
        .waitFor();
      await dialog.getByRole('button', { name: 'Review restore to My files' }).click();
      await dialog.getByRole('button', { name: 'Restore 1 item', exact: true }).waitFor();
      await page.screenshot({ path: `${shots}/restore-review-1280.png` });
      await dialog.getByRole('button', { name: 'Restore 1 item', exact: true }).click();
      await text('Restored “My supplier notes” to My files.').waitFor();
      await page
        .waitForFunction(() => document.activeElement?.textContent?.includes('Restored “My supplier notes”'), null, {
          timeout: 2000,
        })
        .catch(() => {});
      assert.match(
        await focused(),
        /Restored “My supplier notes”/,
        'focus moves to the outcome after the restored row leaves Trash',
      );
      assert.equal((await named('My supplier notes')).parentId, null, 'the stranded folder now sits in My files');

      await page.getByRole('link', { name: 'Shared with me' }).click();
      await page.getByRole('button', { name: 'More actions for Purchasing (read only)' }).click();
      await page.getByRole('menuitem', { name: 'Details' }).waitFor();
      assert.deepEqual(
        await page.getByRole('menuitem').allTextContents(),
        ['Details', 'Copy link'],
        'a viewer gets read-only actions',
      );
      await page.keyboard.press('Escape');
      assert.equal(
        await page.getByRole('checkbox').count(),
        0,
        'a viewer cannot select shared items for move or trash',
      );
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser?.close();
      await server?.close();
      await f.close();
    }
  },
);
