import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createAttachments } from '@tulipfarm/conversations/attachments';
import { createConversations } from '@tulipfarm/conversations';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

const shots = process.env.FILES_SCREENSHOTS ?? 'reports/check/files-browser';

test(
  'the Files viewer opens a sent chat upload and downloads a format it cannot display',
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
        slug: 'files-viewer',
        name: 'Files viewer',
      });
      await f.db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [f.signed.owner.id, 'Files owner']);
      const session = await f.signed.auth.api.getSession({ headers: new Headers({ cookie: f.signed.owner.cookie }) });

      const conversations = createConversations(f.runtime);
      const attachments = createAttachments(f.runtime, f.object.adapter, { files: f.files });
      const chatId = randomUUID(),
        attachmentId = randomUUID(),
        messageId = randomUUID();
      const notes = Buffer.from('Deliver the orchids to the north greenhouse on Friday.\n');
      await conversations.create(f.workspace.id, f.signed.owner.id, { chatId, commandId: randomUUID() });
      await attachments.reserve(f.workspace.id, f.signed.owner.id, chatId, attachmentId, {
        filename: 'Delivery notes.txt',
        mediaType: 'text/plain',
        size: notes.length,
        sha256: createHash('sha256').update(notes).digest('hex'),
      });
      await attachments.upload(f.workspace.id, f.signed.owner.id, chatId, attachmentId, notes);
      await conversations.send(f.workspace.id, f.signed.owner.id, chatId, {
        commandId: randomUUID(),
        messageId,
        parts: [
          { kind: 'text', text: 'Here are the delivery notes' },
          { kind: 'attachment', attachmentId },
        ],
      });
      assert.deepEqual(await attachments.publishSent(f.workspace.id, f.signed.owner.id, chatId, messageId), [
        attachmentId,
      ]);

      const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
      const archiveId = randomUUID();
      assert.equal((await f.upload(archiveId, archive, 'Greenhouse photos.zip', 'application/zip')).status, 200);

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
      const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
      const contentReads = [];
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
            if (method === 'GET' && path.endsWith('/content')) contentReads.push(path);
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
            ['/v1/google-workspace/availability', { configured: false }],
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
      await mkdir(shots, { recursive: true });

      await page.goto(`${origin}/${workspace.slug}/files`);
      await page.getByRole('link', { name: 'Delivery notes.txt', exact: true }).click();
      await page.waitForURL(new RegExp(`/files/${attachmentId}$`));
      await page.getByRole('heading', { name: 'Delivery notes.txt', level: 1 }).waitFor();
      await page.getByText('Deliver the orchids to the north greenhouse on Friday.').waitFor();
      await page.getByText('Owned by you').waitFor();
      await page.screenshot({ path: `${shots}/viewer-sent-upload-1280.png` });

      await page.goto(`${origin}/${workspace.slug}/files/${archiveId}`);
      await page.getByRole('heading', { name: 'Greenhouse photos.zip', level: 1 }).waitFor();
      const content = page.getByRole('region', { name: 'File content' });
      await content.getByText('This format cannot be displayed locally').waitFor();
      await content.getByText('Download the original file to open it in a compatible application.').waitFor();
      await page.screenshot({ path: `${shots}/viewer-unsupported-1280.png` });
      const before = contentReads.length;
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download' }).click();
      const saved = await download;
      assert.equal(saved.suggestedFilename(), 'Greenhouse photos.zip');
      assert.deepEqual(await readFile(await saved.path()), archive, 'the download is the original bytes');
      assert.equal(contentReads.length, before + 1, 'download fetches fresh content');
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server?.close();
      await f.close();
    }
  },
);
