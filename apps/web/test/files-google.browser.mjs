import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';
import { viewerPdf, assertRenderedPdf } from './pdf-viewer.fixture.mjs';
import { captureEvidence, evidenceBrowserArgs } from './browser-controls.mjs';

const shots = process.env.FILES_SCREENSHOTS ?? 'reports/check/files-browser';
const scope = name => `https://www.googleapis.com/auth/${name}`;
const pdf = viewerPdf;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==',
  'base64',
);
const markdown = Buffer.from('# Supplier notes\n\nDeliveries arrive every Tuesday before noon.');
const longName = '供应商价格表 Long supplier price list for every regional warehouse and returns desk.pdf';
const folderType = 'application/vnd.google-apps.folder';
const accounts = {
  a: { integrationId: '0a000000-0000-4000-8000-00000000000a', accountId: 'google-a', email: 'ada@example.test' },
  b: { integrationId: '0b000000-0000-4000-8000-00000000000b', accountId: 'google-b', email: 'bea@example.test' },
};
const file = (id, name, mimeType, extra = {}) => ({
  id,
  name,
  mimeType,
  modifiedTime: '2026-10-03T09:30:00.000Z',
  owners: [{ me: true, displayName: 'Ada' }],
  ...extra,
});
const drive = {
  a: {
    root: file('rootA', 'My Drive', folderType, { parents: undefined }),
    projA: file('projA', 'Projects', folderType, { parents: ['rootA'] }),
    yearA: file('yearA', '2026', folderType, { parents: ['projA'] }),
    docQ3: file('docQ3', 'Q3 plan', 'application/vnd.google-apps.document', {
      webViewLink: 'https://docs.google.com/document/d/docQ3/edit',
    }),
    deckA: file('deckA', 'Board deck', 'application/vnd.google-apps.presentation', {
      webViewLink: 'https://docs.google.com/presentation/d/deckA/edit',
    }),
    sheetA: file('sheetA', 'Budget 2026', 'application/vnd.google-apps.spreadsheet', {
      webViewLink: 'https://docs.google.com/spreadsheets/d/sheetA/edit',
    }),
    notesA: file('notesA', 'Supplier notes.md', 'text/markdown', {
      size: String(markdown.length),
      owners: [{ displayName: 'Sam Rivera', emailAddress: 'sam@example.test' }],
      shared: true,
      webViewLink: 'https://drive.google.com/file/d/notesA/view',
    }),
    longA: file('longA', longName, 'application/pdf', { size: String(pdf.length), webViewLink: 'javascript:alert(1)' }),
    photoA: file('photoA', 'Shelf photo.png', 'image/png', { size: String(png.length) }),
    hugeA: file('hugeA', 'Warehouse scan.pdf', 'application/pdf', {
      size: String(20 * 1024 * 1024),
      webViewLink: 'https://drive.google.com/file/d/hugeA/view',
    }),
    formA: file('formA', 'Intake form', 'application/vnd.google-apps.form', {
      webViewLink: 'https://docs.google.com/forms/d/formA/edit',
    }),
    lockedA: file('lockedA', 'Locked contract.pdf', 'application/pdf', {
      size: '100',
      capabilities: { canDownload: false },
      webViewLink: 'https://evil.example/drive/lockedA',
    }),
    heavyA: file('heavyA', 'Huge handbook', 'application/vnd.google-apps.document', {
      webViewLink: 'https://docs.google.com/document/d/heavyA/edit',
    }),
  },
  b: {
    root: file('rootB', 'My Drive', folderType),
    docB: file('docB', 'Bea roadmap', 'application/vnd.google-apps.document', {
      webViewLink: 'https://docs.google.com/document/d/docB/edit',
    }),
  },
};
const pages = {
  a: {
    root: [
      [
        drive.a.projA,
        drive.a.docQ3,
        drive.a.deckA,
        drive.a.sheetA,
        drive.a.notesA,
        drive.a.longA,
        { name: 'missing id' },
      ],
      [drive.a.photoA, drive.a.hugeA, drive.a.formA, drive.a.lockedA, drive.a.heavyA],
    ],
    projA: [[drive.a.yearA]],
    yearA: [[]],
  },
  b: { root: [[drive.b.docB]] },
};

test('Google Drive browsing and viewing over mocked Google file routes', { timeout: 240000 }, async () => {
  const { workspace, session } = createWorkspaceFixture({ slug: 'drive-qa', name: 'Drive QA' });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    envDir: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser, page;
  const errors = [],
    requests = [],
    begins = [],
    bodies = [];
  const google = `/v1/workspaces/${workspace.id}/google-workspace`;
  const state = {
    configured: true,
    status: 'connected',
    account: 'a',
    generation: 1,
    scopes: [scope('drive'), scope('spreadsheets')],
  };
  const failures = new Map(),
    holds = new Map();
  const fail = (kind, status, error, times = 1) => failures.set(kind, { status, error, times });
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
  const binding = () => ({ ...accounts[state.account], generation: state.generation });
  try {
    await server.listen();
    const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
    browser = await chromium.launch({ channel: 'chromium', args: evidenceBrowserArgs() });
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
    await context.route('https://accounts.google.com/**', route => {
      begins.push(new URL(route.request().url()).searchParams.get('app'));
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Google consent</title>' });
    });
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
              'access-control-allow-methods': 'GET,POST,OPTIONS',
              'access-control-allow-headers': 'content-type',
            },
          });
        requests.push(`${method} ${path}`);
        if (await serveWorkspaceShellEvent(route, workspace)) return;
        const kind =
          path === google
            ? 'status'
            : path.startsWith(`${google}/operations/files/`)
              ? path.split('/').at(-1)
              : path === `${google}/operations/read`
                ? 'read'
                : null;
        if (kind && holds.has(kind)) await holds.get(kind);
        const failure = kind && failures.get(kind);
        if (failure) {
          if (--failure.times <= 0) failures.delete(kind);
          return route.fulfill({ status: failure.status, json: { error: failure.error }, headers: cors });
        }
        if (path === '/v1/google-workspace/availability')
          return route.fulfill({ json: { configured: state.configured }, headers: cors });
        if (path === google && method === 'GET') {
          const status =
            state.status === 'disconnected'
              ? { status: 'disconnected' }
              : { status: state.status, ...binding(), email: accounts[state.account].email, scopes: state.scopes };
          return route.fulfill({ json: status, headers: cors });
        }
        if (path === `${google}/begin`)
          return route.fulfill({
            json: {
              authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?app=${url.searchParams.get('app')}`,
            },
            headers: cors,
          });
        if (kind) {
          assert.equal(method, 'POST');
          const body = request.postDataJSON();
          bodies.push({ kind, body, at: Date.now() });
          const expected = body.expectedIntegration;
          if (
            state.status !== 'connected' ||
            expected.integrationId !== binding().integrationId ||
            expected.accountId !== binding().accountId ||
            expected.generation !== binding().generation
          )
            return route.fulfill({ status: 409, json: { error: 'stale-integration' }, headers: cors });
          const files = drive[state.account];
          if (kind === 'read') {
            assert.deepEqual(body.operation, { kind: 'sheets.spreadsheets.get', spreadsheetId: 'sheetA' });
            if (!state.scopes.includes(scope('spreadsheets')))
              return route.fulfill({ status: 409, json: { error: 'insufficient-scope' }, headers: cors });
            return route.fulfill({
              json: {
                untrusted: true,
                data: {
                  spreadsheetId: 'sheetA',
                  sheets: [
                    {
                      properties: {
                        sheetId: 1,
                        title: 'Summary',
                        sheetType: 'GRID',
                        gridProperties: { rowCount: 250, columnCount: 3 },
                      },
                    },
                    ...(state.dataTab === false
                      ? []
                      : [
                          {
                            properties: {
                              sheetId: 2,
                              title: 'Data',
                              sheetType: 'GRID',
                              gridProperties: { rowCount: 2, columnCount: 2 },
                            },
                          },
                        ]),
                    {
                      properties: {
                        sheetId: 3,
                        title: 'Secret tab',
                        hidden: true,
                        gridProperties: { rowCount: 1, columnCount: 1 },
                      },
                    },
                  ],
                },
              },
              headers: cors,
            });
          }
          if (kind === 'list') {
            if (body.parentId === 'goneA')
              return route.fulfill({ status: 409, json: { error: 'source-not-found' }, headers: cors });
            if (body.parentId === 'privA')
              return route.fulfill({ status: 409, json: { error: 'source-access-denied' }, headers: cors });
            if (body.sharedWithMe)
              return route.fulfill({ json: { files: [], incompleteSearch: false }, headers: cors });
            if (body.name !== undefined)
              return route.fulfill({
                json: {
                  files: Object.values(files).filter(
                    item => item.mimeType !== folderType && item.name.toLowerCase().includes(body.name.toLowerCase()),
                  ),
                  incompleteSearch: true,
                },
                headers: cors,
              });
            const list = pages[state.account][body.parentId === 'root' ? 'root' : body.parentId] ?? [[]];
            const index = body.pageToken ? Number(body.pageToken.slice(4)) : 0;
            const entries = list[index] ?? [],
              valid = entries.filter(item => item.id);
            return route.fulfill({
              json: {
                files: valid,
                ...(index + 1 < list.length ? { nextPageToken: `page${index + 1}` } : {}),
                incompleteSearch: false,
                skipped: entries.length - valid.length,
              },
              headers: cors,
            });
          }
          const target = body.fileId === 'root' ? files.root : files[body.fileId];
          if (!target)
            return route.fulfill({
              status: 409,
              json: { error: body.fileId === 'privA' ? 'source-access-denied' : 'source-not-found' },
              headers: cors,
            });
          if (kind === 'metadata') return route.fulfill({ json: target, headers: cors });
          assert.equal(kind, 'content');
          if (body.kind === 'sheet-range') {
            assert.equal(body.startColumn, 1);
            const columns = body.sheetName === 'Summary' ? 3 : 2;
            assert.equal(body.columnCount, columns, 'column window follows the tab width');
            const values = Array.from({ length: body.rowCount }, (_, row) =>
              Array.from({ length: columns }, (_, column) => `${body.sheetName} R${body.startRow + row}C${column + 1}`),
            );
            return route.fulfill({
              json: {
                kind: 'sheet-range',
                data: { range: `${body.sheetName}!A${body.startRow}`, majorDimension: 'ROWS', values },
              },
              headers: cors,
            });
          }
          if (body.fileId === 'heavyA')
            return route.fulfill({ status: 409, json: { error: 'export-rejected' }, headers: cors });
          assert.ok(
            !['hugeA', 'lockedA'].includes(body.fileId),
            'oversized and download-disabled files are never fetched',
          );
          const bytes =
            body.kind === 'pdf' || body.fileId === 'longA' ? pdf : body.fileId === 'photoA' ? png : markdown;
          return route.fulfill({
            status: 200,
            body: bytes,
            headers: {
              ...cors,
              'content-type': body.kind === 'pdf' ? 'application/pdf' : target.mimeType,
              'content-disposition': 'attachment',
            },
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
              membershipId: '22222222-2222-4222-8222-222222222222',
              role: 'member',
              teams: [],
              capabilities: { manageGovernance: false, canLeave: true },
            },
          ],
          [
            `/v1/workspaces/${workspace.id}/credits`,
            { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
          ],
          [
            `/v1/workspaces/${workspace.id}/files/usage`,
            { usedBytes: 0, quotaBytes: 1073741824, maxFileBytes: 10485760 },
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
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error));
    const main = page.getByRole('main');
    const text = (value, options = {}) => main.getByText(value, { exact: true, ...options });
    const heading = name => main.getByRole('heading', { name, exact: true });
    const button = name => main.getByRole('button', { name, exact: true });
    const link = name => main.getByRole('link', { name, exact: true });
    const files = `${origin}/${workspace.slug}/files`;
    const shot = async name => {
      await captureEvidence(page, `${shots}/${name}.png`);
    };
    await mkdir(shots, { recursive: true });

    state.status = 'disconnected';
    state.configured = false;
    await page.goto(`${files}?section=google`);
    await heading('Google isn’t set up on this server').waitFor();
    state.configured = true;
    await page.reload();
    await heading('Connect Google Drive').waitFor();
    assert.equal(
      await main.getByRole('list', { name: 'Google Drive files' }).count(),
      0,
      'a disconnected source is not an empty Drive',
    );
    await shot('google-connect-1280');
    await button('Connect Google Drive').click();
    await page.waitForURL(/accounts\.google\.com/);
    assert.deepEqual(begins, ['drive'], 'Connect asks Google for Drive consent through the integrations flow');

    state.status = 'connected';
    state.scopes = [scope('documents')];
    await page.goto(`${files}?section=google`);
    await heading('Allow Google Drive access').waitFor();
    await text(
      'Your Google integration for ada@example.test doesn’t include Drive. Access to Docs or Sheets alone can’t list Drive files.',
    ).waitFor();
    await button('Grant Drive access').click();
    await page.waitForURL(/accounts\.google\.com/);
    assert.deepEqual(begins, ['drive', 'drive']);

    state.status = 'reconnect-required';
    state.scopes = [scope('drive'), scope('spreadsheets')];
    await page.goto(`${files}?section=google`);
    await heading('Reconnect Google Drive').waitFor();
    assert.equal(await button('Reconnect Google').isEnabled(), true);

    state.status = 'connected';
    fail('status', 503, 'integrations-unavailable', 3);
    await page.goto(`${files}?section=google`);
    await heading('Couldn’t check your Google integration').waitFor();
    await button('Check integration again').click();
    await main.getByRole('list', { name: 'Google Drive files' }).waitFor();

    const release = hold('list');
    fail('list', 503, 'provider-unavailable', 3);
    await page.goto(`${files}?section=google`);
    await main.getByRole('status', { name: 'Loading Google Drive files' }).waitFor();
    assert.equal(await text('Your Google Drive is empty').count(), 0, 'Drive never looks empty before Google answers');
    release();
    await heading('Couldn’t load Google Drive').waitFor();
    await button('Retry loading Google Drive').click();
    await link('Q3 plan').waitFor();
    await text('ada@example.test').waitFor();
    await text('1 item on this page couldn’t be shown because Google returned incomplete details.').waitFor();
    assert.equal(
      await main.getByRole('list', { name: 'Google Drive files' }).getByRole('listitem').count(),
      6,
      'one malformed item does not hide the page',
    );
    assert.equal(
      (await button('Upload').count()) + (await button('New folder').count()),
      0,
      'Google folders are read-only',
    );
    assert.equal(
      await main.getByRole('button', { name: /More actions/ }).count(),
      5,
      'each copyable Google file has a menu; folders have none',
    );
    await main.getByRole('button', { name: 'More actions for Q3 plan' }).click();
    assert.deepEqual(
      await page.getByRole('menuitem').allTextContents(),
      ['Use in chat', 'Save a copy to TulipFarm'],
      'Google rows offer no rename, move, or trash',
    );
    await page.keyboard.press('Escape');
    await text(/^Read at /).waitFor();
    await shot('google-list-1280');

    await link('Next page').click();
    await link('Shelf photo.png').waitFor();
    assert.match(page.url(), /after=page1/);
    assert.equal(await link('Q3 plan').count(), 0);
    await link('First page').click();
    await link('Q3 plan').waitFor();

    await link('Projects').click();
    await link('2026').waitFor();
    await link('2026').click();
    await heading('This Google folder is empty').waitFor();
    const path = main.getByRole('navigation', { name: 'Folder path' });
    await path.getByRole('link', { name: 'Projects' }).waitFor();
    await path.getByText('2026', { exact: true }).waitFor();
    assert.equal(
      await path.getByText('My Drive', { exact: true }).count(),
      0,
      'the Drive root folder is not repeated in the path',
    );
    await path.getByRole('link', { name: 'Projects' }).click();
    await link('2026').waitFor();

    await page.goto(`${files}?section=google&drive=goneA`);
    await heading('This Google folder isn’t available').waitFor();
    await page.goto(`${files}?section=google&drive=privA`);
    await heading('Google denied access to this folder').waitFor();
    await link('Back to Google Drive').click();
    await link('Q3 plan').waitFor();

    const locations = main.getByRole('navigation', { name: 'Google Drive locations' });
    await locations.getByRole('link', { name: 'Shared with me' }).click();
    await heading('Nothing shared with you in Google Drive').waitFor();
    assert.equal(await locations.getByRole('link', { name: 'Shared with me' }).getAttribute('aria-current'), 'page');
    await locations.getByRole('link', { name: 'My Drive' }).click();
    await link('Q3 plan').waitFor();

    await main.getByRole('searchbox', { name: 'Search Google Drive' }).fill('budget');
    await link('Budget 2026').waitFor();
    await text('Google searched only part of your Drive. Some matching files may be missing.').waitFor();
    assert.match(page.url(), /q=budget/);
    await main.getByRole('searchbox', { name: 'Search Google Drive' }).fill('no-such-file');
    await heading('No Google Drive files match “no-such-file”').waitFor();
    await button('Clear search').last().click();
    await link('Q3 plan').waitFor();
    assert.equal(await main.getByRole('searchbox', { name: 'Search Google Drive' }).inputValue(), '');

    fail('list', 429, 'transfer-busy', 3);
    await page.goto(`${files}?section=google&drive=projA`);
    await heading('Google is busy right now').waitFor();
    assert.equal(
      await heading('Couldn’t load Google Drive').count(),
      0,
      'a capacity refusal is not reported as a Google failure',
    );
    await shot('google-busy-1280');
    await page.setViewportSize({ width: 375, height: 760 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      'busy state fits 375',
    );
    await shot('google-busy-375');
    await page.setViewportSize({ width: 1280, height: 850 });
    await button('Try again').click();
    await link('2026').waitFor();
    fail('list', 409, 'source-access-denied', 1);
    await page.goto(`${files}?section=google&shared=true`);
    await heading('Google denied access to files shared with you').waitFor();
    assert.equal(
      await heading('Google denied access to this folder').count(),
      0,
      'a section listing is not called a folder',
    );
    await page.goto(`${files}?section=google`);
    await link('Q3 plan').waitFor();

    fail('list', 503, 'provider-unavailable', 3);
    await button('Refresh').click();
    await text(/^Couldn’t refresh Google Drive\. The list read at .+ is still shown\.$/).waitFor();
    await link('Q3 plan').waitFor();
    await button('Retry loading Google Drive').click();
    await text(/^Couldn’t refresh Google Drive/).waitFor({ state: 'detached' });

    const listUrl = page.url();
    await link('Q3 plan').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Q3 plan', level: 1 }).waitFor({ state: 'attached' });
    const content = main.getByRole('region', { name: 'File content' });
    assert.match(await content.locator('iframe').getAttribute('src'), /^blob:/, 'the Doc renders as its PDF export');
    await assertRenderedPdf(page);
    await text(/^Google Doc · Owned by you · Modified .+ · Read from Google at .+$/).waitFor();
    const open = link('Open in Google');
    assert.equal(await open.getAttribute('href'), 'https://docs.google.com/document/d/docQ3/edit');
    assert.equal(await open.getAttribute('target'), '_blank');
    const pdfReads = () => bodies.filter(item => item.kind === 'content' && item.body.fileId === 'docQ3').length;
    const before = pdfReads();
    const download = page.waitForEvent('download');
    await button('Download PDF').click();
    const saved = await download;
    assert.equal(saved.suggestedFilename(), 'Q3 plan.pdf');
    assert.deepEqual(await readFile(await saved.path()), pdf);
    assert.equal(pdfReads(), before + 1, 'download re-reads the export under current authorization');
    await page.setViewportSize({ width: 1280, height: 850 });
    await assertRenderedPdf(page);
    await shot('google-doc-1280');
    fail('content', 503, 'provider-unavailable', 3);
    await page.reload();
    await heading('Couldn’t open this Google file').waitFor();
    await shot('google-doc-error-1280');
    await page.setViewportSize({ width: 320, height: 850 });
    await shot('google-doc-error-320');
    await button('Retry opening file').focus();
    await page.keyboard.press('Enter');
    await assertRenderedPdf(page);
    await shot('google-doc-recovered-320');
    await page.setViewportSize({ width: 1280, height: 850 });
    await shot('google-doc-recovered-1280');
    await main.getByRole('link', { name: 'Google Drive', exact: true }).first().click();
    await link('Q3 plan').waitFor();
    assert.equal(page.url(), listUrl, 'returning from the viewer restores the Drive location');

    await page.goto(`${files}/google/deckA?section=google`);
    await page.getByRole('heading', { name: 'Board deck', level: 1 }).waitFor({ state: 'attached' });
    assert.match(await content.locator('iframe').getAttribute('src'), /^blob:/, 'Slides render as their PDF export');

    await page.goto(`${files}/google/notesA?section=google`);
    await text('Deliveries arrive every Tuesday before noon.').waitFor();
    await text(/^Markdown · Sam Rivera · 1 KB · Modified/).waitFor();
    assert.equal(await link('Open in Google').getAttribute('href'), 'https://drive.google.com/file/d/notesA/view');
    fail('metadata', 503, 'provider-unavailable', 3);
    await button('Refresh').click();
    await text(/^Couldn’t refresh from Google\. The copy read at .+ is still shown\.$/).waitFor();
    await text('Deliveries arrive every Tuesday before noon.').waitFor();
    fail('metadata', 409, 'source-access-denied', 1);
    await button('Refresh').click();
    await heading('Google denied access to this file').waitFor();
    assert.equal(
      await page.getByText('Deliveries arrive every Tuesday before noon.').count(),
      0,
      'denial clears cached content',
    );
    assert.equal(await page.getByText('Supplier notes.md').count(), 0, 'denial shows no file metadata');
    await page.waitForFunction(() => window.fileUrls.size === 0);
    await button('Check access again').click();
    await text('Deliveries arrive every Tuesday before noon.').waitFor();

    await page.goto(`${files}/google/photoA?section=google`);
    await main.getByRole('img', { name: 'Shelf photo.png' }).waitFor();
    await page.goto(`${files}/google/longA?section=google`);
    await page.getByRole('heading', { name: longName, level: 1 }).waitFor({ state: 'attached' });
    assert.equal(await link('Open in Google').count(), 0, 'a non-https provider link is never rendered');
    await page.goto(`${files}/google/hugeA?section=google`);
    await heading('This file is too large to view here').waitFor();
    assert.equal(await link('Open in Google').getAttribute('href'), 'https://drive.google.com/file/d/hugeA/view');
    await page.goto(`${files}/google/formA?section=google`);
    await heading('Open this file in Google').waitFor();
    await page.goto(`${files}/google/lockedA?section=google`);
    await heading('Downloading is turned off for this file').waitFor();
    assert.equal(await link('Open in Google').count(), 0, 'a non-Google host is never rendered');
    await link('Back to Google Drive').waitFor();
    await page.goto(`${files}/google/heavyA?section=google`);
    await heading('Google couldn’t export this file').waitFor();
    await page.goto(`${files}/google/goneA?section=google`);
    await heading('This Google file isn’t available').waitFor();
    await page.goto(`${files}/google/projA?section=google`);
    await heading('This link opens a Google folder').waitFor();
    await link('Open folder').click();
    await link('2026').waitFor();

    await page.goto(`${files}/google/sheetA?section=google`);
    await page.getByRole('heading', { name: 'Budget 2026', level: 1 }).waitFor({ state: 'attached' });
    const grid = main.getByRole('region', { name: 'Summary, rows 1 to 100' });
    await grid.getByText('Summary R1C1', { exact: true }).waitFor();
    await text('Rows 1–100 of 250 · Columns A–C of 3. Charts, pivot tables, and editing stay in Google.').waitFor();
    assert.equal(await main.getByRole('button', { name: 'Secret tab' }).count(), 0, 'hidden tabs stay hidden');
    await button('Next 100 rows').click();
    await main
      .getByRole('region', { name: 'Summary, rows 101 to 200' })
      .getByText('Summary R101C3', { exact: true })
      .waitFor();
    await button('Next 100 rows').click();
    await main.getByRole('region', { name: 'Summary, rows 201 to 250' }).waitFor();
    assert.equal(await button('Next 100 rows').count(), 0, 'paging stops at the last row');
    await shot('google-sheet-1280');
    await main.getByRole('button', { name: 'Data', pressed: false }).click();
    await main.getByRole('region', { name: 'Data, rows 1 to 2' }).getByText('Data R2C2', { exact: true }).waitFor();
    state.dataTab = false;
    await button('Refresh').click();
    await main
      .getByRole('region', { name: 'Summary, rows 1 to 100' })
      .getByText('Summary R1C1', { exact: true })
      .waitFor();
    assert.equal(
      await main.getByRole('group', { name: 'Sheet tabs' }).count(),
      0,
      'a refresh that removes the open tab falls back to the first tab at row 1',
    );
    state.dataTab = true;
    assert.equal(
      (await button('Download').count()) + (await button('Download PDF').count()),
      0,
      'Sheets offer no download placeholder',
    );

    state.scopes = [scope('drive')];
    await page.goto(`${files}/google/sheetA?section=google`);
    await heading('Allow Google Sheets access').waitFor();
    await button('Grant Sheets access').click();
    await page.waitForURL(/accounts\.google\.com/);
    assert.deepEqual(begins, ['drive', 'drive', 'sheets']);
    state.scopes = [scope('drive'), scope('spreadsheets')];

    await page.goto(`${files}?section=google`);
    await link('Q3 plan').waitFor();
    await page.goto(`${files}/google/notesA?section=google`);
    await text('Deliveries arrive every Tuesday before noon.').waitFor();
    state.account = 'b';
    state.generation = 2;
    const switched = Date.now();
    await button('Refresh').click();
    await heading('This Google file isn’t available').waitFor();
    assert.equal(
      await page.getByText('Deliveries arrive every Tuesday before noon.').count(),
      0,
      'account B never sees account A content',
    );
    await link('Back to Google Drive').click();
    await link('Bea roadmap').waitFor();
    await text('bea@example.test').waitFor();
    for (const name of ['Q3 plan', 'Supplier notes.md', 'Projects'])
      assert.equal(await main.getByText(name, { exact: true }).count(), 0, `${name} from account A stays hidden`);
    const late = bodies.filter(item => item.at > switched && item.kind !== 'read');
    const firstB = late.findIndex(item => item.body.expectedIntegration.accountId === 'google-b');
    assert.ok(firstB > 0, 'the old binding is rejected before account B is read');
    assert.deepEqual(
      [
        ...new Set(
          late
            .slice(firstB)
            .map(item => `${item.body.expectedIntegration.accountId}:${item.body.expectedIntegration.generation}`),
        ),
      ],
      ['google-b:2'],
      'once account B is known, no request carries account A',
    );
    await page.goBack();
    await heading('This Google file isn’t available').waitFor();
    assert.equal(
      await page.getByText('Deliveries arrive every Tuesday before noon.').count(),
      0,
      'history never restores account A content',
    );

    state.account = 'a';
    state.generation = 3;
    await page.goto(`${files}?section=google`);
    await link('Q3 plan').waitFor();
    for (const width of [1280, 768, 414, 375, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ colorScheme: width === 375 ? 'dark' : 'light', reducedMotion: 'reduce' });
      await link('Q3 plan').waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        `no horizontal page scroll in Drive at ${width}`,
      );
      const named = await link(longName).boundingBox();
      assert.ok(named && named.width >= 60, `long names keep their width at ${width}`);
      await shot(`google-list-${width}`);
    }
    await page.setViewportSize({ width: 320, height: 850 });
    await page.goto(`${files}/google/sheetA?section=google`);
    const narrow = main.getByRole('region', { name: 'Summary, rows 1 to 100' });
    await narrow.getByText('Summary R1C1', { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      'the sheet scrolls inside its own region at 320',
    );
    assert.ok(
      await narrow.evaluate(element => element.scrollWidth > element.clientWidth),
      'wide sheet content scrolls within the grid',
    );
    await shot('google-sheet-320');
    await page.goto(`${files}/google/docQ3?section=google`);
    await page.getByRole('heading', { name: 'Q3 plan', level: 1 }).waitFor({ state: 'attached' });
    await assertRenderedPdf(page);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      'the viewer has no horizontal page scroll at 320',
    );
    await shot('google-doc-320');

    const shellReads = new Set(workspaceShellReads(workspace.id).map(([path]) => `GET ${path}`));
    const forbidden = requests.filter(
      item =>
        !shellReads.has(item) &&
        /\/(agents?|agent-tasks|models?|mcp|workspace-mcp|chats?|conversations|tasks|knowledge)(\/|$)/.test(
          item.split(' ')[1],
        ),
    );
    assert.deepEqual(forbidden, [], 'browsing and viewing never call model, agent, chat, or MCP routes');
    assert.deepEqual(errors, []);
    await context.close();
  } catch (error) {
    if (process.env.FILES_DEBUG)
      console.log(
        await page
          ?.locator('body')
          .innerText()
          .catch(() => ''),
        requests.slice(-12),
        errors,
      );
    throw error;
  } finally {
    await browser?.close();
    await server.close();
  }
});
