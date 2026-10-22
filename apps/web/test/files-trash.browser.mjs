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

test(
  'owners delete Trash items forever through failure and retry; folders holding others’ files are refused',
  { timeout: 180000 },
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
      const writes = [];
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
            ['/v1/feature-flags', {}],
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
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error));
      const text = (value, options = {}) => page.getByText(value, { exact: true, ...options });
      await mkdir(shots, { recursive: true });
      await page.goto(`${origin}/${workspace.slug}/files`);
      await text('No files yet').waitFor();

      const adminMembership = (
        await f.db.platform.query(`SELECT id FROM "${f.workspace.names.schema}".tf_memberships WHERE user_id=$1`, [
          f.signed.admin.id,
        ])
      ).rows[0].id;
      const ledger = randomUUID(),
        mixed = randomUUID(),
        theirs = randomUUID();
      assert.equal(
        (
          await f.call(
            `${base}/${ledger}/content?${new URLSearchParams({ name: 'Old ledger.csv', mediaType: 'text/csv', parentId: 'null' })}`,
            { method: 'PUT', body: Buffer.from('date,amount\n2026-01-01,40\n') },
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await f.call(`${base}/${mixed}/folder`, {
            method: 'PUT',
            body: { name: 'Supplier contracts', parentId: null },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.call(`${base}/${mixed}/sharing`, {
            method: 'PUT',
            body: { subject: { kind: 'individual', id: adminMembership }, role: 'editor' },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.call(
            `${base}/${theirs}/content?${new URLSearchParams({ name: 'Ada signed copy.pdf', mediaType: 'application/pdf', parentId: mixed })}`,
            { method: 'PUT', cookie: f.signed.admin.cookie, body: Buffer.from('%PDF-1.4 signed') },
          )
        ).status,
        200,
      );
      for (const id of [ledger, mixed])
        assert.equal((await f.call(`${base}/${id}/trash`, { method: 'PUT', body: { trashed: true } })).status, 200);
      await page.goto(`${origin}/${workspace.slug}/files?section=trash`);
      await page.getByRole('button', { name: 'Delete Old ledger.csv forever' }).waitFor();
      const storage = page.getByRole('region', { name: 'Storage' });
      await storage.getByText('1 KB', { exact: true }).waitFor();
      await storage.getByText('of 1 GB used, including Trash.').waitFor();
      await storage.getByText('Up to 10 MB per file.').waitFor();
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: width === 375 ? 760 : 850 });
        await page.screenshot({ path: `${shots}/trash-${width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1280, height: 850 });
      await page.getByRole('button', { name: 'Delete Supplier contracts forever' }).click();
      const confirm = page.getByRole('dialog');
      await confirm.getByText('“Supplier contracts” can’t be deleted forever yet').waitFor();
      const blockers = confirm.getByRole('list', { name: 'Items owned by other people' });
      assert.deepEqual(await blockers.getByRole('listitem').allTextContents(), ['Ada signed copy.pdfAda Admin']);
      assert.equal(
        await confirm.getByRole('button', { name: 'Delete forever' }).count(),
        0,
        'a folder holding another person’s file offers no permanent deletion',
      );
      await page.screenshot({ path: `${shots}/delete-forever-blocked-1280.png` });
      await confirm.getByRole('button', { name: 'Close' }).first().click();

      f.object.faults.remove = true;
      await page.getByRole('button', { name: 'Delete Old ledger.csv forever' }).click();
      await confirm.getByText('This can’t be undone.', { exact: false }).waitFor();
      await confirm.getByText('1 KB of storage will be freed.').waitFor();
      await page.screenshot({ path: `${shots}/delete-forever-confirm-1280.png` });
      const removals = () => writes.filter(write => write === `POST /${ledger}/delete-forever`).length;
      await confirm.getByRole('button', { name: 'Delete forever' }).dblclick();
      await text(
        '“Old ledger.csv” can’t be restored, but its deletion hasn’t finished. It still uses storage. Retry deletion from Trash, or it finishes automatically when storage is reachable.',
      ).waitFor();
      assert.equal(removals(), 1, 'a double click sends one permanent deletion');
      await text('Deletion didn’t finish').waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Restore Old ledger.csv' }).count(),
        0,
        'a deleting item cannot be restored',
      );
      assert.equal((await f.call(`${base}/${ledger}/content`)).status, 404, 'reads stop before bytes are removed');
      assert.ok([...f.object.objects.keys()].length >= 2, 'the failed removal kept the stored bytes');
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: width === 375 ? 760 : 850 });
        await page.screenshot({ path: `${shots}/trash-deletion-failed-${width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1280, height: 850 });
      const charged = (await f.call(`${base}/usage`)).json().usedBytes;
      f.object.faults.remove = false;
      await page.getByRole('button', { name: 'Retry deleting Old ledger.csv' }).click();
      await text('“Old ledger.csv” was deleted forever.').waitFor();
      await page.getByRole('button', { name: 'Delete Old ledger.csv forever' }).waitFor({ state: 'detached' });
      assert.equal(
        (await f.call(`${base}/usage`)).json().usedBytes,
        charged - 26,
        'storage is released once the bytes are gone',
      );
      assert.equal(await page.getByRole('button', { name: 'Restore Supplier contracts' }).count(), 1);
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser?.close();
      await server?.close();
      await f.close();
    }
  },
);
