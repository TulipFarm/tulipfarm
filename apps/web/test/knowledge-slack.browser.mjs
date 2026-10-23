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
  'Slack Knowledge selection and management in the Slack integration settings in Chromium',
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
    const screenshots = fileURLToPath(new URL('../../../reports/knowledge-slack-ui/', import.meta.url));
    await mkdir(screenshots, { recursive: true });
    const { workspace, session } = createWorkspaceFixture({ slug: 'slack-knowledge-qa', name: 'Slack Knowledge QA' });
    const readerId = randomUUID();
    const binding = {
      installationId: randomUUID(),
      installationGeneration: 1,
      identityId: randomUUID(),
      slackUserId: 'UOWNER',
      teamId: 'TTEAM',
    };
    const after = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const conversations = [
      { conversationId: 'CGENERAL', kind: 'public', title: '#general', state: 'active', failure: null },
      { conversationId: 'GLEADS', kind: 'private', title: '#leadership', state: 'unavailable', failure: 'archived' },
    ];
    const source = (overrides = {}) => ({
      sourceId: randomUUID(),
      selection: { kind: 'channels', conversationIds: ['CGENERAL', 'GLEADS'], after },
      memberIds: [workspace.id, readerId],
      title: '#general and 1 more',
      canManage: true,
      state: 'active',
      syncState: 'ready',
      failure: null,
      nextAttemptAt: new Date().toISOString(),
      conversations,
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
        slackState: 'active',
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
        expiryMs: 60_000,
        longName: false,
        role: 'member',
      };
      const writes = [],
        reads = [],
        unknown = [],
        errors = [];
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
        reads.push({ path, query: Object.fromEntries(url.searchParams), method: request.method() });
        let status = 200,
          json,
          wait = 0,
          error;
        if (path.endsWith('/auth/get-session')) json = session;
        else if (path === '/v1/user/visit' && request.method() === 'POST') json = { firstSession: false };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me'))
          json = {
            membershipId: workspace.id,
            role: faults.role,
            teams: [],
            capabilities: { manageGovernance: faults.role === 'admin', canLeave: true },
          };
        else if (path.endsWith('/credits'))
          json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
        else if (path.endsWith('/slack/status'))
          json = { state: faults.slackState, teamId: 'TTEAM', canManage: false, linked: true, scopes: [] };
        else if (path.endsWith('/knowledge/slack/members')) {
          status = faults.members;
          json = {
            members: [
              { id: workspace.id, name: 'You', email: session.user.email },
              { id: readerId, name: 'Casey Reader', email: 'casey@example.test' },
            ],
          };
        } else if (path.endsWith('/knowledge/slack/discover')) {
          status = faults.discovery;
          wait = faults.discoveryDelay;
          error = faults.discoveryError;
          const kind = url.searchParams.get('kind');
          const page2 = url.searchParams.has('cursor');
          const items =
            kind === 'personal'
              ? [{ conversationId: 'DFRIEND', kind: 'im', title: 'Direct message with UFRIEND' }]
              : page2
                ? [{ conversationId: 'CARCHIVE', kind: 'public', title: '#archive-2025' }]
                : [
                    { conversationId: 'CGENERAL', kind: 'public', title: '#general' },
                    { conversationId: 'GLEADS', kind: 'private', title: '#leadership' },
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
            nextCursor: !faults.empty && kind === 'channels' && !page2 ? 'page-2' : null,
          };
        } else if (path.endsWith('/knowledge/slack/sources') && request.method() === 'GET') {
          status = faults.list;
          json = { items: [...sources.values()] };
        } else if (path.endsWith('/knowledge/slack/sources') && request.method() === 'POST') {
          const body = request.postDataJSON();
          writes.push({ kind: 'save', body });
          status = faults.save;
          wait = faults.saveDelay;
          json =
            sources.get(body.commandId) ??
            source({
              sourceId: body.commandId,
              selection: body.selection,
              memberIds: [workspace.id, ...body.memberIds],
              title: body.selection.kind === 'personal' ? 'Direct message with UFRIEND' : '#general',
              conversations: conversations.slice(0, 1),
              counts: { total: 0, ready: 0, failed: 0 },
              syncState: 'queued',
            });
          if (status === 200) sources.set(body.commandId, json);
        } else if (path.includes('/knowledge/slack/sources/') && path.endsWith('/manage')) {
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
        } else if (path.includes('/knowledge/slack/sources/') && path.endsWith('/refresh')) {
          writes.push({ kind: 'refresh', path });
          status = faults.refresh;
          json = { refreshed: 1, unavailable: 1, bounded: true };
        } else if (/\/knowledge\/sources\/[^/]+\/failures$/.test(path)) {
          const sourceId = path.split('/sources/')[1].split('/')[0];
          json = failures.get(sourceId) ?? { sourceId, syncedAt: null, items: [], truncated: false };
        } else if (path.includes('/knowledge/slack/sources/') && path.endsWith('/documents')) {
          const pages = documents.get(path.split('/sources/')[1].split('/')[0]) ?? [];
          const index = Number(url.searchParams.get('cursor') ?? 0);
          json = { items: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null };
        } else if (
          path.startsWith(`/v1/workspaces/${workspace.id}/knowledge/slack/documents/`) &&
          path.endsWith('/original')
        )
          return route.fulfill({
            status: 200,
            body: '# Thread',
            headers: {
              ...headers,
              'access-control-expose-headers': 'Content-Disposition',
              'content-type': 'application/octet-stream',
              'content-disposition': "attachment; filename*=UTF-8''slack-thread.md",
            },
          });
        else if (path.endsWith('/knowledge/defaults')) json = { enabled: true, items: [] };
        else {
          if (path.includes('/knowledge/')) unknown.push(`${request.method()} ${path}`);
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
      const open = async () => {
        await page.goto(`${origin}/${workspace.slug}/integrations`);
        await page
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: 'Slack', exact: true }) })
          .getByRole('button', { name: 'Slack', exact: true })
          .click();
        const toggle = page.getByRole('dialog').getByRole('button', { name: 'Your account', exact: true });
        if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await page.getByRole('heading', { name: 'Slack knowledge sources', exact: true }).waitFor();
      };
      const select = async () => {
        await page.getByRole('button', { name: 'Select Slack conversations', exact: true }).click();
        await page.getByLabel('Conversation type', { exact: true }).waitFor();
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
      await t.test(
        'delayed discovery, retry after failure, unlinked explanation, empty state, pagination and uncertain save replay',
        () =>
          fixture(async f => {
            f.faults.discoveryDelay = 700;
            f.faults.discovery = 503;
            await f.open();
            await f.page.getByText('No Slack sources selected', { exact: true }).waitFor();
            await f.select();
            await f.page.getByRole('status', { name: 'Loading Slack conversations' }).waitFor();
            await f.page.getByRole('button', { name: 'Retry loading Slack conversations' }).waitFor();
            f.faults.discovery = 409;
            f.faults.discoveryError = 'slack-not-linked';
            f.faults.discoveryDelay = 0;
            await f.page.getByRole('button', { name: 'Retry loading Slack conversations' }).click();
            await f.page.getByText('Link your Slack account first.', { exact: false }).waitFor();
            assert.equal(
              await f.page.getByRole('button', { name: 'Save Slack source', exact: true }).isDisabled(),
              true,
            );
            f.faults.discovery = 200;
            f.faults.discoveryError = null;
            f.faults.empty = true;
            await f.page.getByRole('button', { name: 'Check Slack again' }).click();
            await f.page.getByText('No Slack conversations on this page', { exact: true }).waitFor();
            f.faults.empty = false;
            await f.page.getByRole('button', { name: 'Check Slack conversations again' }).click();
            await f.page.getByRole('button', { name: 'Save Slack source', exact: true }).click();
            await f.page.getByText('Choose at least one Slack conversation before saving.').waitFor();
            assert.equal(f.writes.filter(write => write.kind === 'save').length, 0);
            await f.page.getByRole('checkbox', { name: '#leadership (private)' }).click();
            await f.page.getByRole('button', { name: 'Next conversations' }).click();
            await f.page.getByRole('checkbox', { name: '#archive-2025' }).click();
            assert.ok(f.reads.some(read => read.query.cursor === 'page-2'));
            await f.page.getByText('2 conversations selected.').waitFor();
            await f.page.getByRole('button', { name: 'Previous conversations' }).click();
            await f.page.getByRole('checkbox', { name: '#general' }).click();
            f.faults.save = 503;
            f.faults.saveDelay = 500;
            await f.page.getByRole('button', { name: 'Save Slack source', exact: true }).dblclick();
            await f.page.getByRole('button', { name: 'Saving Slack source…' }).waitFor();
            await f.page.getByRole('button', { name: 'Retry same operation' }).waitFor();
            assert.equal(f.writes.filter(write => write.kind === 'save').length, 1);
            assert.equal(await f.page.getByLabel('Conversation type').isDisabled(), true);
            const original = f.writes.find(write => write.kind === 'save').body;
            assert.deepEqual(original.selection.conversationIds, ['CARCHIVE', 'CGENERAL', 'GLEADS']);
            assert.deepEqual(original.memberIds, []);
            f.faults.save = 200;
            f.faults.saveDelay = 0;
            await f.page.getByRole('button', { name: 'Retry same operation' }).click();
            await f.page.getByText('#general was saved.', { exact: false }).waitFor();
            assert.deepEqual(f.writes.filter(write => write.kind === 'save').at(-1).body, original);
          }),
      );

      await t.test('personal messages stay private; date bounds and shared channel audience are validated', () =>
        fixture(async f => {
          await f.open();
          await f.select();
          await f.page.getByLabel('Conversation type').click();
          await f.page.getByRole('option', { name: 'Direct and group messages', exact: true }).click();
          await f.page.getByText('Direct and group messages stay private to you.', { exact: false }).waitFor();
          assert.equal(
            await f.page.getByRole('checkbox', { name: 'Share with selected workspace members' }).count(),
            0,
          );
          await f.page.getByRole('checkbox', { name: 'Direct message with UFRIEND' }).click();
          await f.page.getByLabel('Import messages after').fill('2020-01-01');
          await f.page.getByRole('button', { name: 'Save Slack source', exact: true }).click();
          await f.page.getByText('Enter a date that is not in the future and no more than 366 days ago.').waitFor();
          assert.equal(f.writes.filter(write => write.kind === 'save').length, 0);
          await f.page.getByLabel('Import messages after').fill(after);
          await f.page.getByRole('button', { name: 'Save Slack source', exact: true }).click();
          await f.page.getByText('Direct message with UFRIEND was saved.', { exact: false }).waitFor();
          const personal = f.writes.find(write => write.kind === 'save').body;
          assert.deepEqual(personal.selection, { kind: 'personal', conversationIds: ['DFRIEND'], after });
          assert.deepEqual(personal.memberIds, []);
          await f.select();
          await f.page.getByRole('checkbox', { name: '#general' }).click();
          f.faults.members = 503;
          await f.page.getByRole('checkbox', { name: 'Share with selected workspace members' }).click();
          await f.page.getByRole('button', { name: 'Retry loading workspace members' }).waitFor();
          await f.page.getByRole('button', { name: 'Save Slack source', exact: true }).click();
          await f.page
            .getByText('Load the current workspace members and select at least one reader', { exact: false })
            .waitFor();
          f.faults.members = 200;
          await f.page.getByRole('button', { name: 'Retry loading workspace members' }).click();
          await f.page.getByRole('checkbox', { name: 'Casey Reader (casey@example.test)' }).click();
          await f.page.getByRole('button', { name: 'Save Slack source', exact: true }).click();
          await f.page.getByText('#general was saved.', { exact: false }).waitFor();
          assert.deepEqual(f.writes.filter(write => write.kind === 'save').at(-1).body.memberIds, [readerId]);
        }),
      );

      await t.test('blocked conversations explain themselves; owner management and access refresh recover', () =>
        fixture(async f => {
          const item = source();
          f.sources.set(item.sourceId, item);
          const row = () => f.page.getByRole('listitem', { name: item.title, exact: true });
          await f.open();
          await row().getByText('Archived in Slack.', { exact: false }).waitFor();
          await row().getByText('Blocked', { exact: true }).waitFor();
          await row().getByText('3 ready · 1 failed · 4 threads discovered').waitFor();
          f.faults.refresh = 503;
          await row().getByRole('button', { name: 'Refresh my access' }).click();
          await row()
            .getByText('Could not refresh your access. No current authorization is confirmed.', { exact: false })
            .waitFor();
          f.faults.refresh = 200;
          await row().getByRole('button', { name: 'Retry access refresh' }).click();
          await row()
            .getByText('Checked 2 conversations: 1 confirmed, 1 unavailable to you.', { exact: false })
            .waitFor();
          await row().getByRole('button', { name: 'Pause source' }).click();
          await row().getByRole('button', { name: 'Resume source' }).waitFor();
          await row().getByRole('button', { name: 'Resume source' }).click();
          await row().getByRole('button', { name: 'Retry source' }).click();
          await row().getByText('Queued', { exact: true }).waitFor();
          f.faults.manage = 409;
          await row().getByRole('button', { name: 'Pause source' }).click();
          await row().getByRole('button', { name: 'Check source status' }).waitFor();
          f.faults.manage = 200;
          await row().getByRole('button', { name: 'Remove source' }).click();
          await row().getByText('The messages stay in Slack.', { exact: false }).waitFor();
          await row().getByRole('button', { name: 'Confirm remove source' }).click();
          await f.page.getByText('No Slack sources selected', { exact: true }).waitFor();
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

      await t.test(
        'shared readers see no selection or management; import details download through the Slack route',
        () =>
          fixture(async f => {
            const shared = source({
              title: 'Shared Slack source',
              canManage: false,
              selection: null,
              conversations: null,
              counts: null,
              memberIds: [],
            });
            f.sources.set(shared.sourceId, shared);
            f.documents.set(shared.sourceId, [
              [
                {
                  documentId: randomUUID(),
                  revisionId: randomUUID(),
                  title: '#general · Large thread',
                  publicationId: null,
                  parsing: 'failed',
                  embedding: 'pending',
                  failure: 'thread-too-large',
                  validUntil: new Date(Date.now() + 60_000).toISOString(),
                  canRetry: false,
                },
                {
                  documentId: workspace.id,
                  revisionId: workspace.id,
                  title: '#general · Orchid rollout',
                  publicationId: workspace.id,
                  parsing: 'ready',
                  embedding: 'ready',
                  failure: null,
                  validUntil: new Date(Date.now() + 60_000).toISOString(),
                  canRetry: false,
                },
              ],
              [],
            ]);
            await f.open();
            const row = f.page.getByRole('listitem', { name: 'Shared Slack source', exact: true });
            await row.getByText('Only the source owner can pause, resume, retry, or remove it.').waitFor();
            assert.equal(await row.getByRole('button', { name: 'Pause source' }).count(), 0);
            assert.equal(await row.getByRole('list', { name: 'Selected conversations' }).count(), 0);
            await row.getByRole('button', { name: 'View import details' }).click();
            await f.page
              .getByText('This thread exceeds the 1,000-message or 1 MB limit and is not searchable.')
              .waitFor();
            const download = f.page.waitForEvent('download');
            await f.page
              .getByRole('listitem', { name: '#general · Orchid rollout', exact: true })
              .getByRole('button', { name: 'Download thread' })
              .click();
            assert.equal((await download).suggestedFilename(), 'slack-thread.md');
            assert.ok(
              f.reads.some(
                read => read.path.includes('/knowledge/slack/documents/') && read.path.endsWith('/original'),
              ),
            );
            await f.page.getByRole('button', { name: 'Next Slack threads' }).click();
            await f.page.getByText('No authorized threads on this page').waitFor();
          }),
      );

      await t.test(
        'an oversized thread replacement shows its failure instead of Searchable and labels the retained download as an earlier version',
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
                  title: '#general · Supplier thread',
                  publicationId: null,
                  parsing: 'failed',
                  embedding: 'pending',
                  failure: 'thread-too-large',
                  historical: true,
                  validUntil,
                  canRetry: false,
                },
                {
                  documentId: workspace.id,
                  revisionId: workspace.id,
                  title: '#general · Orchid rollout',
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
            f.failures.set(item.sourceId, {
              sourceId: item.sourceId,
              syncedAt: '2026-10-16T09:00:00.000Z',
              items: [
                {
                  documentId: randomUUID(),
                  title: '#general · Oversized thread',
                  canonicalUrl: null,
                  status: 'failed',
                  reason: 'resource-limited',
                  attempts: 3,
                  observedAt: '2026-10-16T08:00:00.000Z',
                },
                {
                  documentId: randomUUID(),
                  title: '#general · Plain export',
                  canonicalUrl: null,
                  status: 'raw-text',
                  reason: 'unsupported',
                  attempts: 1,
                  observedAt: '2026-10-16T08:00:00.000Z',
                },
              ],
              truncated: false,
            });
            await f.open();
            await f.page
              .getByRole('listitem', { name: item.title, exact: true })
              .getByRole('button', { name: 'View import details' })
              .click();
            const replaced = f.page.getByRole('listitem', { name: '#general · Supplier thread', exact: true });
            await replaced.getByText('Import failed', { exact: true }).waitFor();
            assert.equal(await replaced.getByText('Searchable', { exact: true }).count(), 0);
            await replaced
              .getByText('This thread exceeds the 1,000-message or 1 MB limit and is not searchable.')
              .waitFor();
            await replaced
              .getByText(
                'This thread changed in Slack. Knowledge has not imported the current version, so this download is the earlier version.',
              )
              .waitFor();
            assert.equal(await replaced.getByRole('button', { name: 'Download thread' }).count(), 0);
            const download = f.page.waitForEvent('download');
            await replaced.getByRole('button', { name: 'Download earlier version' }).click();
            assert.equal((await download).suggestedFilename(), 'slack-thread.md');
            const current = f.page.getByRole('listitem', { name: '#general · Orchid rollout', exact: true });
            await current.getByText('Searchable', { exact: true }).waitFor();
            await current.getByRole('button', { name: 'Download thread' }).waitFor();
            assert.equal(await current.getByText('this download is the earlier version', { exact: false }).count(), 0);
            const problems = f.page.getByRole('region', { name: 'Items with import problems', exact: true });
            await problems.getByText('Last sync completed', { exact: false }).waitFor();
            const failed = problems.getByRole('listitem').filter({ hasText: '#general · Oversized thread' });
            await failed.getByText('Not searchable', { exact: true }).waitFor();
            await failed.getByText('The file is too large or too complex to read.').waitFor();
            await failed.getByText('3 attempts', { exact: false }).waitFor();
            const fallback = problems.getByRole('listitem').filter({ hasText: '#general · Plain export' });
            await fallback.getByText('Searchable as plain text', { exact: true }).waitFor();
          }),
      );

      await t.test('expired thread access hides titles and downloads; inactive Slack shows no knowledge controls', () =>
        fixture(async f => {
          const item = source();
          f.sources.set(item.sourceId, item);
          await f.open();
          // Opening the integration takes about as long as the 2.5s validity (cloud fails intermittently too), so the window starts once the page is ready.
          f.documents.set(item.sourceId, [
            [
              {
                documentId: workspace.id,
                revisionId: workspace.id,
                title: '#general · Expiring thread',
                publicationId: workspace.id,
                parsing: 'ready',
                embedding: 'ready',
                failure: null,
                validUntil: new Date(Date.now() + 2500).toISOString(),
                canRetry: false,
              },
            ],
          ]);
          await f.page
            .getByRole('listitem', { name: item.title, exact: true })
            .getByRole('button', { name: 'View import details' })
            .click();
          await f.page.getByText('#general · Expiring thread', { exact: true }).waitFor();
          await f.page.getByText('Thread access check expired', { exact: true }).waitFor({ timeout: 10_000 });
          assert.equal(await f.page.getByText('#general · Expiring thread', { exact: true }).count(), 0);
          assert.equal(await f.page.getByRole('button', { name: 'Download thread' }).count(), 0);
          f.faults.slackState = 'revoked';
          await f.page.goto(`${origin}/${workspace.slug}/integrations`);
          await f.page
            .getByRole('listitem')
            .filter({ has: f.page.getByRole('button', { name: 'Slack', exact: true }) })
            .getByRole('button', { name: 'Slack', exact: true })
            .click();
          const toggle = f.page.getByRole('dialog').getByRole('button', { name: 'Your account', exact: true });
          if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
          await f.page.getByText('Slack is not connected', { exact: true }).waitFor();
          assert.equal(await f.page.getByRole('heading', { name: 'Slack knowledge sources', exact: true }).count(), 0);
          assert.equal(
            await f.page.getByRole('dialog').getByRole('region', { name: 'Settings', exact: true }).count(),
            0,
          );
          f.faults.role = 'admin';
          await f.page.reload();
          await f.page.getByRole('dialog').getByRole('button', { name: 'Settings', exact: true }).click();
          await f.page.getByText('Slack workspace needs attention', { exact: true }).waitFor();
          assert.equal(await f.page.getByRole('heading', { name: 'Slack knowledge sources', exact: true }).count(), 0);
        }),
      );

      for (const mobile of [false, true])
        await t.test(
          `${mobile ? 'mobile dark' : 'desktop light'} long names, keyboard selection and focus return`,
          () =>
            fixture(async f => {
              f.faults.longName = true;
              const item = source({ title: '#general and international supplier operations '.repeat(4) });
              f.sources.set(item.sourceId, item);
              await f.open();
              await f.select();
              await f.page.getByRole('checkbox', { name: /^#general-international/ }).focus();
              await f.page.keyboard.press('Space');
              await f.page.getByText('1 conversation selected.').waitFor();
              await f.page.getByRole('checkbox', { name: 'Share with selected workspace members' }).focus();
              await f.page.keyboard.press('Space');
              await f.page.getByRole('checkbox', { name: 'Casey Reader (casey@example.test)' }).waitFor();
              assert.equal(
                await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
                true,
              );
              await f.page
                .getByRole('region', { name: 'Slack knowledge sources', exact: true })
                .scrollIntoViewIfNeeded();
              await f.page.screenshot({
                path: `${screenshots}/${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
                fullPage: true,
              });
              await f.page.getByRole('button', { name: 'Cancel selection' }).click();
              assert.equal(
                await f.page
                  .getByRole('heading', { name: 'Slack knowledge sources', exact: true })
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
