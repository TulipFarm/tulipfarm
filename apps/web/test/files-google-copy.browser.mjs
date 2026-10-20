import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';
import { chooseOption } from './browser-controls.mjs';
import { libraryItem } from './files-library.fixture.mjs';

const shots = process.env.FILES_SCREENSHOTS ?? 'reports/check/files-browser';
const scope = name => `https://www.googleapis.com/auth/${name}`;
const binding = { integrationId: '0a000000-0000-4000-8000-00000000000a', accountId: 'google-a', generation: 3 };
const membershipId = '22222222-2222-4222-8222-222222222222',
  otherMember = '33333333-3333-4333-8333-333333333333';
const google = (id, name, mimeType, extra = {}) => ({
  id,
  name,
  mimeType,
  modifiedTime: '2026-10-03T09:30:00.000Z',
  owners: [{ me: true }],
  ...extra,
});
const drive = {
  root: google('rootA', 'My Drive', 'application/vnd.google-apps.folder'),
  projA: google('projA', 'Projects', 'application/vnd.google-apps.folder', { parents: ['rootA'] }),
  docQ3: google('docQ3', 'Q3 plan', 'application/vnd.google-apps.document', {
    webViewLink: 'https://docs.google.com/document/d/docQ3/edit',
  }),
  sheetA: google('sheetA', 'Budget 2026', 'application/vnd.google-apps.spreadsheet'),
  formA: google('formA', 'Intake form', 'application/vnd.google-apps.form'),
  hugeA: google('hugeA', 'Warehouse scan.pdf', 'application/pdf', { size: String(20 * 1024 * 1024) }),
};
const folder = (id, name, role, parentId = null, creator = membershipId) =>
  libraryItem({ id, kind: 'folder', name, parentId, creatorMembershipId: creator, role });
const folders = {
  contracts: folder('c0000000-0000-4000-8000-000000000001', 'Contracts', 'manager'),
  empty: folder('c0000000-0000-4000-8000-000000000002', 'Empty folder', 'manager'),
  readOnly: folder('c0000000-0000-4000-8000-000000000003', 'Finance reference', 'viewer', null, otherMember),
  drop: folder(
    'c0000000-0000-4000-8000-000000000004',
    'Team drop with a long name for supplier paperwork and returns',
    'editor',
    null,
    otherMember,
  ),
};
const children = {
  root: { mine: [folders.contracts, folders.empty], shared: [folders.readOnly, folders.drop] },
  [folders.contracts.id]: [],
  [folders.empty.id]: [],
  [folders.readOnly.id]: [],
  [folders.drop.id]: [],
};

test(
  'Save a copy dialog covers destination, format, progress, failure, retry, and success states',
  { timeout: 240000 },
  async () => {
    const { workspace, session } = createWorkspaceFixture({ slug: 'copy-qa', name: 'Copy QA' });
    const root = fileURLToPath(new URL('..', import.meta.url));
    const server = await createServer({
      root,
      configFile: `${root}/vite.config.ts`,
      envDir: false,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
    });
    const base = `/v1/workspaces/${workspace.id}`;
    const errors = [],
      copies = [],
      respond = [];
    const holds = new Map(),
      failures = new Map();
    const hold = kind => {
      let release;
      holds.set(
        kind,
        new Promise(resolve => {
          release = resolve;
        }),
      );
      return () => {
        holds.delete(kind);
        release();
      };
    };
    let browser;
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
      browser = await chromium.launch();
      const context = await browser.newContext({ serviceWorkers: 'block' });
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
          const json = (value, status = 200) => route.fulfill({ status, json: value, headers: cors });
          if (path === '/v1/google-workspace/availability') return json({ configured: true });
          if (path === `${base}/google-workspace`)
            return json({
              status: 'connected',
              ...binding,
              email: 'ada@example.test',
              scopes: [scope('drive'), scope('spreadsheets')],
            });
          if (path.startsWith(`${base}/google-workspace/operations/files/`)) {
            const body = request.postDataJSON(),
              kind = path.split('/').at(-1);
            assert.deepEqual(body.expectedIntegration, binding);
            if (kind === 'list')
              return json({
                files: [drive.projA, drive.docQ3, drive.sheetA, drive.formA, drive.hugeA],
                incompleteSearch: false,
                skipped: 0,
              });
            if (kind === 'metadata') return json(drive[body.fileId === 'root' ? 'root' : body.fileId]);
            assert.equal(body.kind, 'pdf');
            return route.fulfill({
              status: 200,
              body: Buffer.from('%PDF-1.4\n%%EOF\n'),
              headers: { ...cors, 'content-type': 'application/pdf' },
            });
          }
          if (path === `${base}/files/library`) {
            if (holds.has('library')) await holds.get('library');
            const failure = failures.get('library');
            if (failure) {
              if (--failure.times <= 0) failures.delete('library');
              return json({ error: 'files-unavailable' }, failure.status);
            }
            const section = url.searchParams.get('section'),
              at = url.searchParams.get('folder');
            const items = at ? children[at] : children.root[section];
            const crumbs = at ? [Object.values(folders).find(item => item.id === at)] : [];
            return json({ items, next: null, breadcrumbs: crumbs, owners: [] });
          }
          const copy = path.match(/\/files\/([0-9a-f-]{36})\/google-copy$/);
          if (copy) {
            assert.equal(method, 'PUT');
            const body = request.postDataJSON();
            copies.push({ id: copy[1], body });
            if (holds.has('copy')) await holds.get('copy');
            const [status, value] = respond.shift() ?? [200, null];
            if (status !== 200) return json(value, status);
            const format =
              body.format === 'original'
                ? 'application/pdf'
                : {
                    pdf: 'application/pdf',
                    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  }[body.format];
            return json({
              id: copy[1],
              kind: 'file',
              name: body.name,
              parentId: body.parentId,
              creatorMembershipId: membershipId,
              mediaType: format,
              size: 48213,
              trashed: false,
              role: 'manager',
            });
          }
          const shell = new Map([
            ...workspaceShellReads(workspace.id),
            ['/v1/auth/get-session', session],
            ['/v1/user/visit', { firstSession: false }],
            ['/v1/workspaces', [workspace]],
            [`/v1/workspaces/${workspace.slug}`, workspace],
            [
              `${base}/governance/me`,
              { membershipId, role: 'member', teams: [], capabilities: { manageGovernance: false, canLeave: true } },
            ],
            [
              `${base}/credits`,
              { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
            ],
            [`${base}/files/usage`, { usedBytes: 48213, quotaBytes: 1073741824, maxFileBytes: 10485760 }],
          ]);
          assert.ok(shell.has(path), `Unexpected browser route ${method} ${path}`);
          assert.equal(method, path === '/v1/user/visit' ? 'POST' : 'GET', `Unexpected shell method: ${path}`);
          return json(shell.get(path));
        } catch (error) {
          errors.push(error);
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error));
      await mkdir(shots, { recursive: true });
      const shot = async name => {
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity)
              .map(animation => animation.finished.catch(() => {})),
          ),
        );
        await page.screenshot({ path: `${shots}/${name}.png` });
      };
      const main = page.getByRole('main');
      const dialog = page.getByRole('dialog');
      const save = dialog.getByRole('button', { name: /^(Save copy|Retry copy|Saving copy…)$/ });

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${origin}/${workspace.slug}/files?section=google`);
      await main.getByRole('link', { name: 'Q3 plan', exact: true }).waitFor();
      assert.equal(
        await main.getByRole('button', { name: 'More actions for Projects' }).count(),
        0,
        'folders have no copy action',
      );
      assert.equal(
        await main.getByRole('button', { name: 'More actions for Intake form' }).count(),
        0,
        'forms cannot be exported, so they have no copy action',
      );
      const menu = main.getByRole('button', { name: 'More actions for Q3 plan' });
      const release = hold('library');
      await menu.click();
      await page.getByRole('menuitem', { name: 'Save a copy to TulipFarm' }).click();
      await dialog.getByRole('heading', { name: 'Save a copy of “Q3 plan”' }).waitFor();
      await dialog.getByRole('status', { name: 'Loading folders' }).waitFor();
      await dialog
        .getByText('It won’t change when the Google file changes, and the original stays in Google unchanged.', {
          exact: false,
        })
        .waitFor();
      release();
      await dialog.getByRole('button', { name: 'Contracts' }).waitFor();
      assert.equal(await dialog.getByLabel('Name').inputValue(), 'Q3 plan.docx');
      await dialog.getByLabel('Format').click();
      assert.deepEqual(await page.getByRole('option').allTextContents(), ['Word document (.docx)', 'PDF (.pdf)']);
      await page.keyboard.press('Escape');
      await dialog.getByText('Saving to My files').waitFor();
      await shot('google-copy-dialog-1280');

      await chooseOption(page, dialog.getByLabel('Format'), 'PDF (.pdf)');
      assert.equal(await dialog.getByLabel('Name').inputValue(), 'Q3 plan.pdf', 'an untouched name follows the format');
      await dialog.getByRole('group', { name: 'Location' }).getByRole('button', { name: 'Shared with me' }).click();
      await dialog.getByText('Open a shared folder to save into it.').waitFor();
      assert.equal(await save.isDisabled(), true, 'the shared root is not a destination');
      await dialog.getByRole('button', { name: /Finance reference/ }).click();
      await dialog.getByText('You can view this folder but can’t add to it.').waitFor();
      assert.equal(await save.isDisabled(), true, 'a view-only folder is not a destination');
      await dialog.getByRole('group', { name: 'Location' }).getByRole('button', { name: 'Shared with me' }).click();
      failures.set('library', { status: 503, times: 3 });
      await dialog.getByRole('button', { name: /Team drop/ }).click();
      await dialog.getByRole('heading', { name: 'Couldn’t load folders' }).waitFor();
      await dialog.getByRole('button', { name: 'Retry loading folders' }).click();
      await dialog.getByText('No folders here.').waitFor();
      await dialog.getByText(/^Saving to “Team drop/).waitFor();

      respond.push([409, { error: 'file-quota' }]);
      await save.click();
      await dialog.getByText('Workspace storage is full. Files in Trash still use storage.').waitFor();
      assert.equal(
        await dialog.getByLabel('Name').isDisabled(),
        false,
        'a confirmed rejection keeps the form editable',
      );
      await shot('google-copy-failed-1280');

      respond.push([500, { error: 'file-operation-failed' }]);
      const releaseCopy = hold('copy');
      await save.click();
      await dialog.getByRole('button', { name: 'Saving copy…' }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Saving copy…' }).getAttribute('aria-busy'), 'true');
      await dialog.getByText('Copying from Google Drive to “Team drop', { exact: false }).waitFor();
      await dialog.getByRole('button', { name: 'Saving copy…' }).evaluate(element => {
        element.click();
        element.click();
      });
      await shot('google-copy-progress-1280');
      releaseCopy();
      await dialog
        .getByText('We couldn’t confirm the copy. Retrying checks for it first and won’t create a second copy.')
        .waitFor();
      assert.equal(
        await dialog.getByLabel('Name').isDisabled(),
        true,
        'an unconfirmed copy locks its request until retried',
      );
      await dialog.getByRole('button', { name: 'Retry copy' }).click();
      await dialog.getByRole('heading', { name: 'Copy saved to TulipFarm' }).waitFor();
      const open = dialog.getByRole('link', { name: 'Open copy' });
      assert.equal(copies.length, 3, 'double-clicking a pending copy sends one request');
      assert.equal(new Set(copies.map(item => item.id)).size, 1, 'every retry keeps the command id');
      assert.equal(await open.getAttribute('href'), `/${workspace.slug}/files/${copies[0].id}`);
      assert.deepEqual(copies[2].body, {
        name: 'Q3 plan.pdf',
        parentId: folders.drop.id,
        format: 'pdf',
        source: { fileId: 'docQ3', expectedIntegration: binding },
      });
      await dialog.getByText(/^“Q3 plan\.pdf” is in “Team drop .*” · 47 KB\.$/).waitFor();
      await shot('google-copy-success-1280');
      await dialog.getByRole('button', { name: 'Done' }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(
        await menu.evaluate(element => element === document.activeElement),
        true,
        'focus returns to the row menu',
      );

      await menu.click();
      await page.getByRole('menuitem', { name: 'Save a copy to TulipFarm' }).click();
      await dialog.getByRole('button', { name: 'Contracts' }).waitFor();
      respond.push([409, { error: 'file-conflict' }]);
      await dialog.getByLabel('Name').fill('Q3 plan final.docx');
      await save.click();
      await dialog
        .getByText('An earlier attempt saved a different copy under this request.', { exact: false })
        .waitFor();
      await save.click();
      await dialog.getByRole('heading', { name: 'Copy saved to TulipFarm' }).waitFor();
      assert.notEqual(copies.at(-1).id, copies.at(-2).id, 'a conflicting command id is replaced');
      assert.notEqual(copies.at(-2).id, copies[0].id, 'a new dialog starts a new command');
      assert.equal(copies.at(-1).body.name, 'Q3 plan final.docx');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });

      await main.getByRole('button', { name: 'More actions for Warehouse scan.pdf' }).click();
      await page.getByRole('menuitem', { name: 'Save a copy to TulipFarm' }).click();
      await dialog.getByText('This file is 20.0 MB. Copies are limited to 10 MB.').waitFor();
      assert.equal(await dialog.getByLabel('Format').count(), 0, 'an ordinary Drive file copies as it is');
      assert.equal(await save.isDisabled(), true);
      await dialog.getByRole('button', { name: 'Cancel' }).click();

      await main.getByRole('link', { name: 'Q3 plan', exact: true }).click();
      const viewerAction = main.getByRole('button', { name: 'Save a copy' });
      await viewerAction.click();
      await dialog.getByRole('button', { name: 'Contracts' }).waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(
        await viewerAction.evaluate(element => element === document.activeElement),
        true,
        'focus returns to the viewer action',
      );

      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 800 });
        const menu = main.getByRole('button', { name: 'File actions', exact: true });
        await menu.click();
        await page.getByRole('menuitem', { name: 'Save a copy' }).waitFor();
        assert.deepEqual(
          await page.getByRole('menuitem').allTextContents(),
          ['Use in chat', 'Download PDF', 'Save a copy', 'Open in Google', 'Refresh'],
          `viewer actions collapse into one menu at ${width}`,
        );
        if (width === 320) await shot('google-viewer-actions-320');
        await page.getByRole('menuitem', { name: 'Save a copy' }).click();
        await dialog.getByRole('button', { name: 'Contracts' }).waitFor();
        const box = await dialog.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, `the dialog fits at ${width}`);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
          `no horizontal page scroll at ${width}`,
        );
        await shot(`google-copy-dialog-${width}`);
        await dialog.getByRole('group', { name: 'Location' }).getByRole('button', { name: 'Shared with me' }).click();
        await dialog.getByRole('button', { name: /Team drop/ }).click();
        await dialog.getByText(/^Saving to “Team drop/).waitFor();
        await save.click();
        await dialog.getByRole('heading', { name: 'Copy saved to TulipFarm' }).waitFor();
        await shot(`google-copy-success-${width}`);
        await dialog.getByRole('button', { name: 'Done' }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.equal(
          await menu.evaluate(element => element === document.activeElement),
          true,
          `focus returns to the action menu at ${width}`,
        );
      }
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
