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
  'Confluence and Jira Knowledge selection and management in the Atlassian integration settings in Chromium',
  { timeout: 300_000 },
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
    const screenshots = fileURLToPath(new URL('../../../reports/knowledge-atlassian-ui/', import.meta.url));
    await mkdir(screenshots, { recursive: true });
    const { workspace, session } = createWorkspaceFixture({
      slug: 'atlassian-knowledge-qa',
      name: 'Atlassian Knowledge QA',
    });
    const readerId = randomUUID();
    const cloudId = randomUUID();
    const binding = { accountId: randomUUID(), atlassianAccountId: 'owner-aaid', cloudId };
    const confluenceTargets = [
      { kind: 'page', id: '201', key: null, title: 'Roadmap', descendants: true, state: 'active', failure: null },
      {
        kind: 'space',
        id: '9001',
        key: 'SUP',
        title: 'Suppliers',
        descendants: false,
        state: 'unavailable',
        failure: 'forbidden',
      },
    ];
    const source = (overrides = {}) => ({
      sourceId: randomUUID(),
      product: 'confluence',
      selection: {
        product: 'confluence',
        cloudId,
        targets: [
          { kind: 'page', id: '201', descendants: true },
          { kind: 'space', id: '9001', descendants: false },
        ],
      },
      memberIds: [workspace.id, readerId],
      title: 'Roadmap and 1 more',
      canManage: true,
      state: 'active',
      syncState: 'ready',
      failure: null,
      nextAttemptAt: new Date().toISOString(),
      targets: confluenceTargets,
      counts: { total: 4, ready: 3, failed: 1 },
      ...overrides,
    });

    async function fixture(run, mobile = false) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 },
        isMobile: mobile,
        hasTouch: mobile,
        reducedMotion: 'reduce',
        colorScheme: mobile ? 'dark' : 'light',
        serviceWorkers: 'block',
        acceptDownloads: true,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const sources = new Map(),
        documents = new Map(),
        failures = new Map();
      const faults = {
        sites: 200,
        sitesError: null,
        discovery: 200,
        discoveryError: null,
        discoveryDelay: 0,
        empty: false,
        list: 200,
        save: 200,
        saveDelay: 0,
        manage: 200,
        refresh: 200,
        members: 200,
        longName: false,
      };
      const writes = [],
        reads = [],
        unknown = [],
        errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/v1/**', async route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname,
          method = request.method();
        const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
        if (method === 'OPTIONS')
          return route.fulfill({
            status: 204,
            headers: {
              ...headers,
              'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
              'access-control-allow-headers': 'content-type',
            },
          });
        reads.push({ path, query: Object.fromEntries(url.searchParams), method });
        let status = 200,
          json,
          wait = 0,
          error;
        const knowledge = `/v1/workspaces/${workspace.id}/knowledge/atlassian`;
        if (path.endsWith('/auth/get-session')) json = session;
        else if (path === '/v1/user/visit' && method === 'POST') json = { firstSession: false };
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
        else if (path === `${knowledge}/members`) {
          status = faults.members;
          json = {
            members: [
              { id: workspace.id, name: 'You', email: session.user.email },
              { id: readerId, name: 'Casey Reader', email: 'casey@example.test' },
            ],
          };
        } else if (path === `${knowledge}/sites`) {
          status = faults.sites;
          error = faults.sitesError;
          json = { items: [{ cloudId, name: 'acme', url: 'https://acme.atlassian.net' }] };
        } else if (path === `${knowledge}/discover`) {
          status = faults.discovery;
          wait = faults.discoveryDelay;
          error = faults.discoveryError;
          const kind = url.searchParams.get('kind'),
            page2 = url.searchParams.has('cursor');
          const items =
            kind === 'projects'
              ? [{ kind: 'project', id: '7001', key: 'OPS', title: 'Operations' }]
              : kind === 'pages'
                ? [
                    { kind: 'page', id: '201', key: null, title: 'Roadmap' },
                    { kind: 'page', id: '202', key: null, title: 'Release notes' },
                  ]
                : page2
                  ? [{ kind: 'space', id: '9003', key: 'ARC', title: 'Archive' }]
                  : [
                      { kind: 'space', id: '9001', key: 'SUP', title: 'Suppliers' },
                      { kind: 'space', id: '9002', key: 'ENG', title: 'Engineering' },
                    ];
          json = {
            binding,
            items: faults.empty
              ? []
              : faults.longName
                ? items.map(item => ({
                    ...item,
                    title: `${item.title}-${'international-supplier-operations-'.repeat(5)}`,
                  }))
                : items,
            nextCursor: !faults.empty && kind === 'spaces' && !page2 ? 'page-2' : null,
          };
        } else if (path === `${knowledge}/sources` && method === 'GET') {
          status = faults.list;
          json = { items: [...sources.values()] };
        } else if (path === `${knowledge}/sources` && method === 'POST') {
          const body = request.postDataJSON();
          writes.push({ kind: 'save', body });
          status = faults.save;
          wait = faults.saveDelay;
          json =
            sources.get(body.commandId) ??
            source({
              sourceId: body.commandId,
              product: body.selection.product,
              selection: body.selection,
              memberIds: [workspace.id, ...body.memberIds],
              title: body.selection.product === 'jira' ? 'Operations' : 'Suppliers',
              targets: [],
              counts: { total: 0, ready: 0, failed: 0 },
              syncState: 'queued',
            });
          if (status === 200) sources.set(body.commandId, json);
        } else if (path.startsWith(`${knowledge}/sources/`) && path.endsWith('/manage')) {
          const id = path.split('/sources/')[1].split('/')[0],
            body = request.postDataJSON();
          writes.push({ kind: 'manage', id, body });
          status = faults.manage;
          const old = sources.get(id);
          json = {
            ...old,
            state: body.action === 'pause' ? 'paused' : body.action === 'remove' ? 'removed' : 'active',
            syncState: body.action === 'retry' ? 'queued' : old.syncState,
          };
          if (status === 200) sources.set(id, json);
        } else if (path.startsWith(`${knowledge}/sources/`) && path.endsWith('/refresh')) {
          writes.push({ kind: 'refresh', path });
          status = faults.refresh;
          json = { refreshed: 3, unavailable: 1, bounded: true };
        } else if (/\/knowledge\/sources\/[^/]+\/failures$/.test(path)) {
          const sourceId = path.split('/sources/')[1].split('/')[0];
          json = failures.get(sourceId) ?? { sourceId, syncedAt: null, items: [], truncated: false };
        } else if (path.startsWith(`${knowledge}/sources/`) && path.endsWith('/documents')) {
          const pages = documents.get(path.split('/sources/')[1].split('/')[0]) ?? [];
          const index = Number(url.searchParams.get('cursor') ?? 0);
          json = { items: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null };
        } else if (path.startsWith(`${knowledge}/documents/`) && path.endsWith('/original'))
          return route.fulfill({
            status: 200,
            body: '# Page',
            headers: {
              ...headers,
              'access-control-expose-headers': 'Content-Disposition',
              'content-type': 'application/octet-stream',
              'content-disposition': "attachment; filename*=UTF-8''confluence-item.md",
            },
          });
        else if (path.endsWith('/atlassian/accounts'))
          json = {
            accounts: [],
            providers: [
              { protocol: 'atlassian-mcp', configured: true },
              { protocol: 'atlassian-rest', configured: true },
              { protocol: 'trello', configured: false },
            ],
          };
        else if (path.endsWith('/atlassian/sources'))
          json = { sources: [], mcp: { enabled: false, explanation: 'MCP operations are disabled.' } };
        else if (path.endsWith('/integrations/creation-context')) json = { teams: [] };
        else if (path.endsWith('/integrations')) json = { integrations: [] };
        else if (path.endsWith('/knowledge/defaults')) json = { enabled: true, items: [] };
        else {
          if (path.includes('/knowledge/')) unknown.push(`${method} ${path}`);
          status = 404;
          json = { error: 'unknown-fixture-route' };
        }
        await delay(wait);
        await route
          .fulfill({
            status,
            json:
              status === 200
                ? json
                : { error: error ?? (status === 404 ? 'knowledge-not-found' : 'knowledge-unavailable') },
            headers,
          })
          .catch(() => {});
      });
      const open = async (product = 'Confluence') => {
        await page.goto(`${origin}/${workspace.slug}/integrations`);
        await page
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: product, exact: true }) })
          .getByRole('button', { name: product, exact: true })
          .first()
          .click();
        const toggle = page.getByRole('dialog').getByRole('button', { name: 'Your account', exact: true });
        if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await page.getByRole('heading', { name: `${product} knowledge sources`, exact: true }).waitFor();
      };
      const select = async (product = 'Confluence') => {
        await page.getByRole('button', { name: `Select ${product} content`, exact: true }).click();
        await page.getByRole('region', { name: `Select ${product} content`, exact: true }).waitFor();
      };
      try {
        await run({ page, context, faults, sources, documents, failures, writes, reads, open, select });
        assert.deepEqual(errors, []);
        assert.deepEqual(unknown, []);
      } finally {
        await context.close();
      }
    }

    try {
      await t.test('unlinked explanation, failed and empty discovery, pagination and uncertain save replay', () =>
        fixture(async f => {
          f.faults.sites = 409;
          f.faults.sitesError = 'atlassian-not-linked';
          await f.open();
          await f.page.getByText('No Confluence sources selected', { exact: true }).waitFor();
          await f.select();
          await f.page
            .getByText('Connect your own Atlassian account with the REST sign-in under Advanced setup', {
              exact: false,
            })
            .first()
            .waitFor();
          assert.equal(
            await f.page.getByRole('button', { name: 'Save Confluence source', exact: true }).isDisabled(),
            true,
          );
          f.faults.sites = 200;
          f.faults.sitesError = null;
          f.faults.discovery = 503;
          f.faults.discoveryDelay = 500;
          await f.page.getByRole('button', { name: 'Check Atlassian sites again' }).click();
          await f.page.getByRole('status', { name: 'Loading Spaces' }).waitFor();
          await f.page.getByRole('button', { name: 'Retry loading Spaces' }).waitFor();
          f.faults.discovery = 200;
          f.faults.discoveryDelay = 0;
          f.faults.empty = true;
          await f.page.getByRole('button', { name: 'Retry loading Spaces' }).click();
          await f.page.getByText('No spaces on this page', { exact: true }).waitFor();
          f.faults.empty = false;
          await f.page.getByRole('button', { name: 'Check spaces again' }).click();
          await f.page.getByRole('button', { name: 'Save Confluence source', exact: true }).click();
          await f.page.getByText('Choose at least one space or page before saving.').waitFor();
          assert.equal(f.writes.filter(write => write.kind === 'save').length, 0);
          await f.page.getByRole('checkbox', { name: 'Suppliers (SUP)' }).click();
          await f.page.getByRole('button', { name: 'Next spaces' }).click();
          await f.page.getByRole('checkbox', { name: 'Archive (ARC)' }).click();
          assert.ok(f.reads.some(read => read.query.cursor === 'page-2'));
          await f.page.getByText('2 items selected.').waitFor();
          f.faults.save = 503;
          f.faults.saveDelay = 500;
          await f.page.getByRole('button', { name: 'Save Confluence source', exact: true }).dblclick();
          await f.page.getByRole('button', { name: 'Saving Confluence source…' }).waitFor();
          await f.page.getByRole('button', { name: 'Retry same operation' }).waitFor();
          assert.equal(f.writes.filter(write => write.kind === 'save').length, 1);
          assert.equal(await f.page.getByLabel('Atlassian site').isDisabled(), true);
          const original = f.writes.find(write => write.kind === 'save').body;
          assert.deepEqual(original.selection, {
            product: 'confluence',
            cloudId,
            targets: [
              { kind: 'space', id: '9001', descendants: false },
              { kind: 'space', id: '9003', descendants: false },
            ],
          });
          assert.deepEqual(original.memberIds, []);
          f.faults.save = 200;
          f.faults.saveDelay = 0;
          await f.page.getByRole('button', { name: 'Retry same operation' }).click();
          await f.page.getByText('Suppliers was saved.', { exact: false }).waitFor();
          assert.deepEqual(f.writes.filter(write => write.kind === 'save').at(-1).body, original);
        }),
      );

      await t.test('specific pages include child pages and the shared audience is validated', () =>
        fixture(async f => {
          await f.open();
          await f.select();
          await f.page.getByLabel('Import', { exact: true }).click();
          await f.page.getByRole('option', { name: 'Specific pages', exact: true }).click();
          await f.page.getByLabel('Browse pages in space').click();
          await f.page.getByRole('option', { name: 'Engineering', exact: true }).click();
          assert.ok(f.reads.some(read => read.query.kind === 'pages' && read.query.within === '9002'));
          await f.page.getByRole('checkbox', { name: 'Release notes' }).click();
          await f.page.getByRole('checkbox', { name: 'Roadmap' }).click();
          f.faults.members = 503;
          await f.page.getByRole('checkbox', { name: 'Share with selected workspace members' }).click();
          await f.page.getByRole('button', { name: 'Retry loading workspace members' }).waitFor();
          await f.page.getByRole('button', { name: 'Save Confluence source', exact: true }).click();
          await f.page
            .getByText('Load the current workspace members and select at least one reader', { exact: false })
            .waitFor();
          assert.equal(f.writes.filter(write => write.kind === 'save').length, 0);
          f.faults.members = 200;
          await f.page.getByRole('button', { name: 'Retry loading workspace members' }).click();
          await f.page.getByRole('checkbox', { name: 'Casey Reader (casey@example.test)' }).click();
          await f.page.getByRole('button', { name: 'Save Confluence source', exact: true }).click();
          await f.page.getByText('Suppliers was saved.', { exact: false }).waitFor();
          const body = f.writes.find(write => write.kind === 'save').body;
          assert.deepEqual(body.selection.targets, [
            { kind: 'page', id: '201', descendants: true },
            { kind: 'page', id: '202', descendants: true },
          ]);
          assert.deepEqual(body.memberIds, [readerId]);
        }),
      );

      await t.test(
        'Jira projects save; blocked selections explain themselves; owner management and access refresh recover',
        () =>
          fixture(async f => {
            const item = source();
            f.sources.set(item.sourceId, item);
            const jira = source({
              product: 'jira',
              title: 'Operations',
              selection: { product: 'jira', cloudId, targets: [{ kind: 'project', id: '7001', descendants: false }] },
              targets: [
                {
                  kind: 'project',
                  id: '7001',
                  key: 'OPS',
                  title: 'Operations',
                  descendants: false,
                  state: 'active',
                  failure: null,
                },
              ],
            });
            f.sources.set(jira.sourceId, jira);
            await f.open('Jira');
            assert.equal(
              await f.page.getByRole('listitem', { name: item.title, exact: true }).count(),
              0,
              'Confluence sources stay in the Confluence sheet',
            );
            await f.page
              .getByRole('listitem', { name: 'Operations', exact: true })
              .getByText('Project: Operations (OPS)')
              .waitFor();
            await f.select('Jira');
            await f.page.getByRole('checkbox', { name: 'Operations (OPS)' }).click();
            await f.page.getByRole('button', { name: 'Save Jira source', exact: true }).click();
            await f.page.getByText('Operations was saved.', { exact: false }).waitFor();
            assert.deepEqual(f.writes.find(write => write.kind === 'save').body.selection, {
              product: 'jira',
              cloudId,
              targets: [{ kind: 'project', id: '7001', descendants: false }],
            });
            await f.open();
            const row = () => f.page.getByRole('listitem', { name: item.title, exact: true });
            await row().getByText('The source owner can no longer view this in Atlassian.', { exact: false }).waitFor();
            await row().getByText('Blocked', { exact: true }).waitFor();
            await row().getByText('Page: Roadmap and child pages').waitFor();
            await row().getByText('3 ready · 1 failed · 4 pages discovered').waitFor();
            f.faults.refresh = 503;
            await row().getByRole('button', { name: 'Refresh my access' }).click();
            await row()
              .getByText('Could not refresh your access. No current authorization is confirmed.', { exact: false })
              .waitFor();
            f.faults.refresh = 200;
            await row().getByRole('button', { name: 'Retry access refresh' }).click();
            await row().getByText('Checked 4 pages: 3 confirmed, 1 unavailable to you.', { exact: false }).waitFor();
            await row().getByRole('button', { name: 'Pause source' }).click();
            await row().getByRole('button', { name: 'Resume source' }).click();
            await row().getByRole('button', { name: 'Retry source' }).click();
            await row().getByText('Queued', { exact: true }).waitFor();
            f.faults.manage = 409;
            await row().getByRole('button', { name: 'Pause source' }).click();
            await row().getByRole('button', { name: 'Check source status' }).waitFor();
            f.faults.manage = 200;
            await row().getByRole('button', { name: 'Remove source' }).click();
            await row().getByText('The content stays in Confluence.', { exact: false }).waitFor();
            await row().getByRole('button', { name: 'Confirm remove source' }).click();
            await f.page.getByText('No Confluence sources selected', { exact: true }).waitFor();
            assert.deepEqual(
              f.writes.filter(write => write.kind === 'manage').map(write => write.body.action),
              ['pause', 'resume', 'retry', 'pause', 'remove'],
            );
            assert.equal(
              new Set(f.writes.filter(write => write.kind === 'manage').map(write => write.body.commandId)).size,
              5,
            );
          }),
      );

      await t.test('shared readers see no selection or management; import details download and expire', () =>
        fixture(async f => {
          const shared = source({
            title: 'Shared Confluence source',
            canManage: false,
            selection: null,
            targets: null,
            counts: null,
            memberIds: [],
          });
          f.sources.set(shared.sourceId, shared);
          f.documents.set(shared.sourceId, [
            [
              {
                documentId: randomUUID(),
                revisionId: randomUUID(),
                title: 'Huge page',
                publicationId: null,
                parsing: 'failed',
                embedding: 'pending',
                failure: 'item-too-large',
                validUntil: new Date(Date.now() + 60_000).toISOString(),
                canRetry: false,
              },
              {
                documentId: workspace.id,
                revisionId: workspace.id,
                title: 'Supplier handbook',
                publicationId: workspace.id,
                parsing: 'ready',
                embedding: 'ready',
                failure: null,
                validUntil: new Date(Date.now() + 60_000).toISOString(),
                canRetry: false,
              },
              {
                documentId: readerId,
                revisionId: readerId,
                title: 'Expiring page',
                publicationId: readerId,
                parsing: 'ready',
                embedding: 'ready',
                failure: null,
                validUntil: new Date(Date.now() + 2500).toISOString(),
                canRetry: false,
              },
            ],
            [],
          ]);
          await f.open();
          const row = f.page.getByRole('listitem', { name: 'Shared Confluence source', exact: true });
          await row.getByText('Only the source owner can pause, resume, retry, or remove it.').waitFor();
          assert.equal(await row.getByRole('button', { name: 'Pause source' }).count(), 0);
          assert.equal(await row.getByRole('list', { name: 'Selected content' }).count(), 0);
          await row.getByRole('button', { name: 'View import details' }).click();
          await f.page.getByText('This item exceeds the 1 MB or 1,000-comment limit and is not searchable.').waitFor();
          const download = f.page.waitForEvent('download');
          await f.page
            .getByRole('listitem', { name: 'Supplier handbook', exact: true })
            .getByRole('button', { name: 'Download page' })
            .click();
          assert.equal((await download).suggestedFilename(), 'confluence-item.md');
          assert.ok(
            f.reads.some(
              read => read.path.includes('/knowledge/atlassian/documents/') && read.path.endsWith('/original'),
            ),
          );
          await f.page.getByText('Page access check expired', { exact: true }).waitFor({ timeout: 10_000 });
          assert.equal(await f.page.getByText('Expiring page', { exact: true }).count(), 0);
          await f.page.getByRole('button', { name: 'Next pages' }).click();
          await f.page.getByText('No authorized pages on this page').waitFor();
        }),
      );

      await t.test(
        'an oversized page replacement shows its failure instead of Searchable and labels the retained download as an earlier version',
        () =>
          fixture(async f => {
            const item = source();
            f.sources.set(item.sourceId, item);
            const validUntil = new Date(Date.now() + 60_000).toISOString();
            f.documents.set(item.sourceId, [
              [
                {
                  documentId: randomUUID(),
                  revisionId: randomUUID(),
                  title: 'Roadmap root',
                  publicationId: null,
                  parsing: 'failed',
                  embedding: 'pending',
                  failure: 'item-too-large',
                  historical: true,
                  validUntil,
                  canRetry: false,
                },
                {
                  documentId: workspace.id,
                  revisionId: workspace.id,
                  title: 'Supplier handbook',
                  publicationId: workspace.id,
                  parsing: 'ready',
                  embedding: 'ready',
                  failure: null,
                  historical: false,
                  validUntil,
                  canRetry: false,
                },
              ],
            ]);
            await f.open();
            await f.page
              .getByRole('listitem', { name: item.title, exact: true })
              .getByRole('button', { name: 'View import details' })
              .click();
            const replaced = f.page.getByRole('listitem', { name: 'Roadmap root', exact: true });
            await replaced.getByText('Import failed', { exact: true }).waitFor();
            assert.equal(await replaced.getByText('Searchable', { exact: true }).count(), 0);
            await replaced
              .getByText('This item exceeds the 1 MB or 1,000-comment limit and is not searchable.')
              .waitFor();
            await replaced
              .getByText(
                'This page changed in Confluence. Knowledge has not imported the current version, so this download is the earlier version.',
              )
              .waitFor();
            assert.equal(await replaced.getByRole('button', { name: 'Download page' }).count(), 0);
            const download = f.page.waitForEvent('download');
            await replaced.getByRole('button', { name: 'Download earlier version' }).click();
            assert.equal((await download).suggestedFilename(), 'confluence-item.md');
            const current = f.page.getByRole('listitem', { name: 'Supplier handbook', exact: true });
            await current.getByText('Searchable', { exact: true }).waitFor();
            await current.getByRole('button', { name: 'Download page' }).waitFor();
            assert.equal(await current.getByText('this download is the earlier version', { exact: false }).count(), 0);
          }),
      );

      for (const mobile of [false, true])
        await t.test(
          `${mobile ? 'mobile dark' : 'desktop light'} long names, keyboard selection and focus return`,
          () =>
            fixture(async f => {
              f.faults.longName = true;
              const item = source({ title: 'Roadmap and international supplier operations '.repeat(4) });
              f.sources.set(item.sourceId, item);
              await f.open();
              await f.select();
              await f.page.getByRole('checkbox', { name: /^Suppliers-international/ }).focus();
              await f.page.keyboard.press('Space');
              await f.page.getByText('1 item selected.').waitFor();
              await f.page.getByRole('checkbox', { name: 'Share with selected workspace members' }).focus();
              await f.page.keyboard.press('Space');
              await f.page.getByRole('checkbox', { name: 'Casey Reader (casey@example.test)' }).waitFor();
              assert.equal(
                await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
                true,
              );
              await f.page
                .getByRole('region', { name: 'Confluence knowledge sources', exact: true })
                .scrollIntoViewIfNeeded();
              await f.page.screenshot({
                path: `${screenshots}/${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
                fullPage: true,
              });
              await f.page.getByRole('button', { name: 'Cancel selection' }).click();
              assert.equal(
                await f.page
                  .getByRole('heading', { name: 'Confluence knowledge sources', exact: true })
                  .evaluate(element => element === document.activeElement),
                true,
              );
            }, mobile),
        );
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
