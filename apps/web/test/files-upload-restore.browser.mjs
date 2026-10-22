import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

const shots = process.env.FILES_SCREENSHOTS ?? 'reports/check/files-browser';

test(
  'Drag-and-drop upload, upload cancellation, restore to a chosen folder, and narrow viewer actions',
  { timeout: 240000 },
  async () => {
    const f = await knowledgeFixture();
    let server, browser, uploads;
    const errors = [];
    const base = `/v1/workspaces/${f.workspace.id}/files`;
    try {
      const { workspace } = createWorkspaceFixture({
        id: f.workspace.id,
        userId: f.signed.owner.id,
        slug: 'files-drop',
        name: 'Files drop',
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
      browser = await chromium.launch();
      const context = await browser.newContext({ serviceWorkers: 'block' });
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
      // A synthetic DataTransfer has no directory entries, so the suite marks the item named "Receipts" as a dropped folder.
      await context.addInitScript(() => {
        const entry = DataTransferItem.prototype.webkitGetAsEntry;
        DataTransferItem.prototype.webkitGetAsEntry = function () {
          return this.getAsFile()?.name === 'Receipts' ? { isDirectory: true } : entry.call(this);
        };
      });
      await context.addInitScript(() => {
        window.uploadProgress = [];
        window.progressValues = [];
        const send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) {
          this.upload.addEventListener('progress', event =>
            window.uploadProgress.push({ loaded: event.loaded, total: event.total }),
          );
          return send.call(this, body);
        };
        new MutationObserver(records => {
          for (const record of records)
            for (const node of [record.target, ...record.addedNodes]) {
              if (!(node instanceof Element)) continue;
              for (const bar of [node, ...node.querySelectorAll('[role="progressbar"]')])
                if (bar.getAttribute('role') === 'progressbar')
                  window.progressValues.push({
                    label: bar.getAttribute('aria-label'),
                    now: bar.getAttribute('aria-valuenow'),
                    text: bar.getAttribute('aria-valuetext'),
                  });
            }
        }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-valuenow'] });
      });
      const held = new Map();
      // Uploads reach a real socket so the browser reports upload progress, which it does not for intercepted bodies.
      // The relay holds named uploads after their bytes arrive, and a cancelled transfer closes the socket before it forwards anything.
      uploads = createHttpServer(async (request, response) => {
        const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const url = new URL(request.url, 'http://relay'),
            gate = held.get(url.searchParams.get('name'));
          if (gate) {
            held.delete(url.searchParams.get('name'));
            gate.resolve(url.pathname);
            await Promise.race([gate.released, once(response, 'close')]);
            if (!response.writableEnded) response.destroy();
            return;
          }
          if (response.destroyed) return;
          const forwarded = await fetch(`${f.origin}${url.pathname}${url.search}`, {
            method: 'PUT',
            headers: {
              cookie: f.signed.owner.cookie,
              origin: 'http://localhost:5173',
              'content-type': request.headers['content-type'],
            },
            body: Buffer.concat(chunks),
          });
          response.writeHead(forwarded.status, {
            'content-type': forwarded.headers.get('content-type') ?? 'application/json',
            ...cors,
          });
          response.end(Buffer.from(await forwarded.arrayBuffer()));
        } catch (error) {
          errors.push(error);
          response.destroy();
        }
      });
      await new Promise(resolve => uploads.listen(0, '127.0.0.1', resolve));
      const relay = `http://127.0.0.1:${uploads.address().port}`;
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
            if (method === 'PUT' && path.endsWith('/content'))
              return route.continue({ url: `${relay}${path}${url.search}` });
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
          return route.fulfill({ status: 200, json: shell.get(path), headers: cors });
        } catch (error) {
          errors.push(error);
          await route.abort().catch(() => {});
        }
      });
      const hold = name => {
        let resolve, release;
        const reached = new Promise(done => {
          resolve = done;
        });
        const released = new Promise(done => {
          release = done;
        });
        held.set(name, { resolve, released });
        return { reached, release };
      };
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error));
      const text = (value, options = {}) => page.getByText(value, { exact: true, ...options });
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
      const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      const mine = async () =>
        (await f.call(`${base}/library?${new URLSearchParams({ section: 'mine' })}`))
          .json()
          .items.map(item => [item.name, item.parentId]);
      const usage = async () => (await f.call(`${base}/usage`)).json().usedBytes;
      async function drag(target, files, { drop = true } = {}) {
        const transfer = await page.evaluateHandle(files => {
          const transfer = new DataTransfer();
          for (const file of files)
            transfer.items.add(new File([new Uint8Array(file.size)], file.name, { type: file.type }));
          return transfer;
        }, files);
        await target.dispatchEvent('dragenter', { dataTransfer: transfer });
        await target.dispatchEvent('dragover', { dataTransfer: transfer });
        if (drop) await target.dispatchEvent('drop', { dataTransfer: transfer });
        return transfer;
      }
      await mkdir(shots, { recursive: true });

      const contracts = randomUUID();
      assert.equal(
        (
          await f.call(`${base}/${contracts}/folder`, {
            method: 'PUT',
            body: { name: 'Supplier contracts', parentId: null },
          })
        ).status,
        200,
      );
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.goto(`${origin}/${workspace.slug}/files`);
      const list = page.getByRole('region', { name: 'My files' });
      const folderRow = page.getByRole('row').filter({ hasText: 'Supplier contracts' });
      await folderRow.waitFor();

      let transfer = await drag(list, [{ name: 'Price list.csv', size: 1200, type: 'text/csv' }], { drop: false });
      await text('Drop to upload to My files').waitFor();
      assert.equal(await list.getAttribute('data-drop-target'), 'true', 'the list shows it accepts the drop');
      await shot('drop-list-1280');
      await page.setViewportSize({ width: 375, height: 760 });
      await shot('drop-list-375');
      assert.equal(await fits(), true, 'the drop hint fits 375');
      await page.setViewportSize({ width: 1280, height: 850 });
      await list.dispatchEvent('drop', { dataTransfer: transfer });
      await text('Drop to upload to My files').waitFor({ state: 'detached' });
      await text('Uploaded · My files').waitFor();

      transfer = await drag(folderRow, [{ name: 'Signed terms.pdf', size: 2048, type: 'application/pdf' }], {
        drop: false,
      });
      await text('Drop to upload to Supplier contracts').waitFor();
      assert.equal(
        await folderRow.getAttribute('data-drop-target'),
        'true',
        'the folder row shows it receives the drop',
      );
      assert.equal(
        await list.getAttribute('data-drop-target'),
        null,
        'the list around the folder row is not the target',
      );
      await shot('drop-folder-row-1280');
      await folderRow.dispatchEvent('drop', { dataTransfer: transfer });
      await text('Uploaded · Supplier contracts').waitFor();
      assert.deepEqual(
        (await mine()).sort(),
        [
          ['Price list.csv', null],
          ['Supplier contracts', null],
        ].sort(),
        'only the list drop lands at the top level',
      );
      const inFolder = (await f.call(`${base}/library?${new URLSearchParams({ section: 'mine', folder: contracts })}`))
        .json()
        .items.map(item => item.name);
      assert.deepEqual(inFolder, ['Signed terms.pdf'], 'a drop onto a folder row uploads into that folder');

      await drag(list, [
        { name: 'Receipts', size: 0, type: '' },
        { name: 'Empty notes.txt', size: 0, type: 'text/plain' },
        { name: 'Warehouse scan.pdf', size: 11 * 1024 * 1024, type: 'application/pdf' },
      ]);
      await text(
        'Receipts: Folders can’t be uploaded. Open the folder on your device and upload the files inside it.',
      ).waitFor();
      await text('Empty notes.txt: This file is empty.').waitFor();
      await text('Warehouse scan.pdf: This file is 11.0 MB. The upload limit is 10 MB.').waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Retry uploading Receipts' }).count(),
        0,
        'a rejected item offers no retry',
      );
      await shot('drop-rejections-1280');
      for (const name of ['Receipts', 'Empty notes.txt', 'Warehouse scan.pdf'])
        await page.getByRole('button', { name: `Remove ${name} from uploads` }).click();
      await text(
        'Receipts: Folders can’t be uploaded. Open the folder on your device and upload the files inside it.',
      ).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Dismiss finished' }).click();
      await page.getByRole('region', { name: 'Uploads' }).waitFor({ state: 'detached' });

      const charged = await usage();
      const report = hold('Quarterly report.pdf');
      await drag(list, [
        { name: 'Quarterly report.pdf', size: 3000, type: 'application/pdf' },
        { name: 'Order form.csv', size: 900, type: 'text/csv' },
      ]);
      const uploadPath = await report.reached;
      const bar = page.getByRole('progressbar', { name: 'Uploading Quarterly report.pdf' });
      await page.waitForFunction(() =>
        window.uploadProgress.some(event => event.total === 3000 && event.loaded === 3000),
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector('[role="progressbar"][aria-label="Uploading Quarterly report.pdf"]')
            ?.getAttribute('aria-valuenow') === '100',
      );
      assert.equal(
        await bar.getAttribute('aria-valuetext'),
        'Saving…',
        'every byte sent waits on the server to save it',
      );
      await text('Saving… · My files').waitFor();
      const progress = await page.evaluate(() => ({ events: window.uploadProgress, values: window.progressValues }));
      assert.deepEqual(
        [1200, 2048, 3000].map(size => progress.events.some(event => event.total === size && event.loaded === size)),
        [true, true, true],
        'the browser reports each file’s upload progress',
      );
      const reported = progress.values
        .filter(value => value.label === 'Uploading Quarterly report.pdf')
        .map(value => Number(value.now));
      assert.equal(reported[0], 0, 'the bar starts empty');
      assert.equal(reported.at(-1), 100, 'progress events move the bar');
      assert.ok(
        reported.every((value, index) => index === 0 || value >= reported[index - 1]),
        'progress never moves backwards',
      );
      await text('Waiting · My files').waitFor();
      await page.getByRole('button', { name: 'Cancel uploading Order form.csv' }).click();
      await text('Cancelled · My files').waitFor();
      await page.getByRole('button', { name: 'Cancel uploading Quarterly report.pdf' }).click();
      await page.getByText('Cancelled · My files', { exact: true }).nth(1).waitFor();
      report.release();
      await text('0 uploaded, 2 cancelled').waitFor();
      assert.equal(
        (await f.call(uploadPath.replace(/\/content$/, ''))).status,
        404,
        'the cancelled transfer left no file',
      );
      assert.equal(await usage(), charged, 'cancelled uploads hold no quota');
      assert.equal(
        (await mine()).some(([name]) => name === 'Quarterly report.pdf' || name === 'Order form.csv'),
        false,
      );
      await shot('upload-cancelled-1280');
      await page.setViewportSize({ width: 375, height: 760 });
      assert.equal(await fits(), true, 'cancelled uploads fit 375');
      await shot('upload-cancelled-375');
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.getByRole('button', { name: 'Remove Order form.csv from uploads' }).click();
      await page.getByRole('button', { name: 'Retry uploading Quarterly report.pdf' }).click();
      await text('1 file uploaded').waitFor();
      assert.equal(
        (await f.call(uploadPath.replace(/\/content$/, ''))).json().name,
        'Quarterly report.pdf',
        'retry sends the same id again',
      );
      assert.equal(await usage(), charged + 3000);

      await page.goto(`${origin}/${workspace.slug}/files?section=shared`);
      const shared = page.getByRole('region', { name: 'Shared with me' });
      await text('Nothing shared with you yet').waitFor();
      await drag(shared, [{ name: 'Stray.csv', size: 10, type: 'text/csv' }], { drop: false });
      assert.equal(
        (await text('Drop to upload to Shared with me').count()) + (await page.getByText(/^Drop to upload/).count()),
        0,
        'a location the reader can’t add to offers no drop',
      );
      assert.equal(await shared.getAttribute('data-drop-target'), null);

      const drafts = randomUUID(),
        terms = randomUUID();
      assert.equal(
        (
          await f.call(`${base}/${drafts}/folder`, {
            method: 'PUT',
            cookie: f.signed.admin.cookie,
            body: { name: 'Ada drafts', parentId: null },
          })
        ).status,
        200,
      );
      const grant = role =>
        f.call(`${base}/${drafts}/sharing`, {
          method: 'PUT',
          cookie: f.signed.admin.cookie,
          body: { subject: { kind: 'individual', id: f.workspace.membershipId }, role },
        });
      assert.equal((await grant('editor')).status, 200);
      assert.equal(
        (
          await f.call(
            `${base}/${terms}/content?${new URLSearchParams({ name: 'Draft terms.txt', mediaType: 'text/plain', parentId: drafts })}`,
            { method: 'PUT', body: Buffer.from('Net 30 terms') },
          )
        ).status,
        200,
      );
      assert.equal((await f.call(`${base}/${terms}/trash`, { method: 'PUT', body: { trashed: true } })).status, 200);
      assert.equal((await grant(null)).status, 200);
      await page.goto(`${origin}/${workspace.slug}/files?section=trash`);
      await page.getByRole('button', { name: 'Restore Draft terms.txt' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', { name: 'Restore “Draft terms.txt”' }).waitFor();
      await dialog
        .getByText(
          'Its original folder is in Trash, or you can no longer add to it. Choose where to put it instead. Links stay the same.',
        )
        .waitFor();
      await dialog.getByRole('button', { name: 'Review restore to My files' }).click();
      await dialog.getByText('Loses access: Ada Admin.').waitFor();
      await shot('restore-destination-1280');
      await page.setViewportSize({ width: 375, height: 760 });
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 375, 'the restore review fits 375');
      await shot('restore-destination-375');
      await page.setViewportSize({ width: 1280, height: 850 });
      await dialog.getByRole('button', { name: 'Restore 1 item' }).click();
      await text('Restored “Draft terms.txt” to My files.').waitFor();
      const restored = (await f.call(`${base}/${terms}`)).json();
      assert.deepEqual(
        [restored.parentId, restored.trashed],
        [null, false],
        'the item left Trash for the chosen folder',
      );

      await page.goto(`${origin}/${workspace.slug}/files/${terms}`);
      await page.getByRole('heading', { name: 'Draft terms.txt', level: 1 }).waitFor({ state: 'attached' });
      await page.getByRole('button', { name: 'Use in chat' }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'File actions', exact: true }).count(),
        0,
        'wide screens keep the primary actions visible',
      );
      await shot('viewer-actions-1280');
      await page.setViewportSize({ width: 375, height: 760 });
      const actions = page.getByRole('button', { name: 'File actions', exact: true });
      await actions.waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Use in chat' }).count(),
        0,
        'narrow screens move every action into one menu',
      );
      const content = await page.getByRole('region', { name: 'File content' }).boundingBox();
      // The page scroller keeps a thin scrollbar gutter since cloud b774750f (src/index.css:193), so the full width is its client width.
      const scroller = await page
        .locator('[data-slot=page-content]')
        .evaluate(element => element.parentElement.clientWidth);
      assert.ok(
        content.width >= scroller - 48,
        `viewer content keeps the full width (${content.width} of ${scroller})`,
      );
      assert.equal(await fits(), true, 'the viewer fits 375');
      await actions.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Use in chat' }).waitFor();
      assert.deepEqual(await page.getByRole('menuitem').allTextContents(), [
        'Use in chat',
        'Download',
        'Add to Knowledge',
        'Add to project',
        'Details',
        'Copy link',
        'Share',
      ]);
      await shot('viewer-actions-375');
      await page.keyboard.press('Escape');
      await page.getByRole('menuitem', { name: 'Use in chat' }).waitFor({ state: 'detached' });
      assert.equal(
        await actions.evaluate(element => element === document.activeElement),
        true,
        'focus returns to the action menu',
      );
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser?.close();
      await server?.close();
      uploads?.closeAllConnections();
      uploads?.close();
      await f.close();
    }
  },
);
