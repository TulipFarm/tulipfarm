import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const chooseAccount = async (page, name) => {
  await page.getByLabel('Use GitHub account', { exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
};
const importSettings = page => page.getByRole('button', { name: /^Import settings/ }).click();

test(
  'GitHub Knowledge selection and management in the personal GitHub settings in Chromium',
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
    const screenshots = fileURLToPath(new URL('../../../reports/check/knowledge-github-ui/', import.meta.url));
    await mkdir(screenshots, { recursive: true });
    const { workspace, session } = createWorkspaceFixture({ slug: 'github-knowledge-qa', name: 'GitHub Knowledge QA' });
    const readerId = randomUUID();
    const personal = {
      id: randomUUID(),
      state: 'active',
      configured: true,
      identity: { id: '101', login: 'octo-owner' },
      generation: 1,
      scopes: ['repo', 'read:user'],
    };
    const work = {
      id: randomUUID(),
      state: 'active',
      configured: true,
      identity: { id: '102', login: 'octo-work' },
      generation: 3,
      scopes: ['read:user'],
    };
    const binding = account => ({ accountId: account, accountGeneration: 1, githubUserId: '101', login: 'octo-owner' });
    const after = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const repositories = [
      {
        repositoryId: '7001',
        fullName: 'acme/handbook',
        visibility: 'private',
        title: 'acme/handbook',
        state: 'active',
        failure: null,
        excluded: false,
        status: 'active',
        missingKinds: [],
      },
      {
        repositoryId: '7002',
        fullName: 'acme/leadership',
        visibility: 'private',
        title: 'acme/leadership',
        state: 'unavailable',
        failure: 'forbidden',
        excluded: false,
        status: 'access-lost',
        missingKinds: [],
      },
    ];
    const source = (overrides = {}) => ({
      sourceId: randomUUID(),
      selection: { repositories: ['acme/handbook', 'acme/leadership'], kinds: ['docs', 'issues', 'pulls'], after },
      memberIds: [workspace.id, readerId],
      title: 'acme/handbook and 1 more',
      canManage: true,
      state: 'active',
      syncState: 'ready',
      failure: null,
      nextAttemptAt: new Date().toISOString(),
      repositories,
      counts: { total: 9, ready: 8, failed: 1 },
      connection: 'connected',
      accountId: personal.id,
      repositoryCounts: { active: 1, excluded: 0, needsPermission: 0, accessLost: 1 },
      ...overrides,
    });

    async function fixture(run, mobile = false, width = mobile ? 390 : 1440) {
      const context = await browser.newContext({
        viewport: { width, height: mobile ? 844 : 1100 },
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
        documents = new Map();
      const faults = {
        accounts: [personal, work],
        accountsGate: null,
        configured: true,
        discovery: 200,
        discoveryError: null,
        discoveryDelay: 0,
        discoveryPages: null,
        failedCursor: null,
        empty: false,
        list: 200,
        save: 200,
        saveDelay: 0,
        saveError: null,
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
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          };
        else if (path.endsWith('/credits'))
          json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
        else if (path.endsWith('/github/accounts') && request.method() === 'GET') {
          await faults.accountsGate;
          json = { configured: faults.configured, accounts: faults.accounts };
        } else if (path.endsWith('/knowledge/github/members')) {
          status = faults.members;
          json = {
            members: [
              { id: workspace.id, name: 'You', email: session.user.email },
              { id: readerId, name: 'Casey Reader', email: 'casey@example.test' },
            ],
          };
        } else if (path.endsWith('/knowledge/github/discover')) {
          status = faults.discovery;
          wait = faults.discoveryDelay;
          error = faults.discoveryError;
          const account = url.searchParams.get('accountId');
          const page2 = url.searchParams.has('cursor');
          const items =
            account === work.id
              ? [
                  {
                    repositoryId: '9001',
                    fullName: 'work/public-docs',
                    visibility: 'public',
                    title: 'work/public-docs',
                  },
                ]
              : page2
                ? [{ repositoryId: '7003', fullName: 'acme/archive', visibility: 'internal', title: 'acme/archive' }]
                : [
                    { repositoryId: '7001', fullName: 'acme/handbook', visibility: 'private', title: 'acme/handbook' },
                    {
                      repositoryId: '7002',
                      fullName: 'acme/leadership',
                      visibility: 'private',
                      title: 'acme/leadership',
                    },
                  ];
          json = {
            binding: binding(account),
            items: faults.empty
              ? []
              : faults.longName
                ? items.map(item => ({
                    ...item,
                    fullName: `${item.fullName}-${'international-supplier-operations-'.repeat(2)}`.slice(0, 100),
                  }))
                : items,
            nextCursor: !faults.empty && account === personal.id && !page2 ? '2' : null,
          };
          if (faults.discoveryPages) {
            const index = Number(url.searchParams.get('cursor') ?? 1) - 1;
            json.items = faults.discoveryPages[index];
            json.nextCursor = index + 1 < faults.discoveryPages.length ? String(index + 2) : null;
          }
          if (faults.failedCursor && url.searchParams.get('cursor') === faults.failedCursor) status = 503;
        } else if (path.endsWith('/knowledge/github/sources') && request.method() === 'GET') {
          status = faults.list;
          json = { items: [...sources.values()] };
        } else if (path.endsWith('/knowledge/github/sources') && request.method() === 'POST') {
          const body = request.postDataJSON();
          writes.push({ kind: 'save', body });
          status = faults.save;
          wait = faults.saveDelay;
          error = faults.saveError;
          json =
            sources.get(body.commandId) ??
            source({
              sourceId: body.commandId,
              selection: body.selection,
              memberIds: [workspace.id, ...body.memberIds],
              title: body.selection.scope === 'all' ? 'All repositories' : body.selection.repositories[0],
              repositories: repositories.slice(0, 1),
              counts: { total: 0, ready: 0, failed: 0 },
              syncState: 'queued',
            });
          if (status === 200) sources.set(body.commandId, json);
        } else if (path.includes('/knowledge/github/sources/') && path.endsWith('/manage')) {
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
        } else if (path.includes('/knowledge/github/sources/') && path.endsWith('/settings')) {
          const id = path.split('/sources/')[1].split('/')[0],
            body = request.postDataJSON();
          writes.push({ kind: 'settings', id, body });
          const old = sources.get(id);
          json = {
            ...old,
            selection: {
              ...old.selection,
              kinds: body.kinds,
              ...(body.excludePaths.length ? { excludePaths: body.excludePaths } : { excludePaths: undefined }),
              after: body.after ?? undefined,
            },
            repositories: old.repositories.map(item => ({
              ...item,
              excluded: body.excludedRepositories.includes(item.repositoryId),
              status: body.excludedRepositories.includes(item.repositoryId) ? 'excluded' : item.status,
            })),
          };
          sources.set(id, json);
        } else if (path.includes('/knowledge/github/sources/') && path.endsWith('/refresh')) {
          writes.push({ kind: 'refresh', path });
          status = faults.refresh;
          json = { refreshed: 1, unavailable: 1, bounded: true };
        } else if (path.includes('/knowledge/github/sources/') && path.endsWith('/documents')) {
          const pages = documents.get(path.split('/sources/')[1].split('/')[0]) ?? [];
          const index = Number(url.searchParams.get('cursor') ?? 0);
          json = { items: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null };
        } else if (
          path.startsWith(`/v1/workspaces/${workspace.id}/knowledge/github/documents/`) &&
          path.endsWith('/original')
        )
          return route.fulfill({
            status: 200,
            body: '# Doc',
            headers: {
              ...headers,
              'access-control-expose-headers': 'Content-Disposition',
              'content-type': 'application/octet-stream',
              'content-disposition': "attachment; filename*=UTF-8''github-document.md",
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
        await page.goto(`${origin}/${workspace.slug}/integrations#github-accounts`);
        await page.getByRole('region', { name: 'Personal GitHub accounts' }).waitFor();
        await page.getByRole('heading', { name: 'Repositories in Knowledge', exact: true }).waitFor();
        const prompts = page.getByRole('region', { name: 'Things to ask with GitHub', exact: true });
        assert.deepEqual(await prompts.locator('[data-slot="gradient-banner-panel"]').allTextContents(), [
          'What changed in main this week?',
          'List my open pull requests',
          'Find issues assigned to me',
        ]);
        assert.deepEqual(
          await prompts
            .locator('[data-slot="gradient-banner"]')
            .evaluateAll(cards => cards.map(card => card.dataset.variant)),
          ['lagoon', 'iris', 'mint'],
        );
        assert.ok(
          await prompts.evaluate(element =>
            Boolean(
              document.querySelector('[aria-label="Personal GitHub accounts"]').compareDocumentPosition(element) &
              Node.DOCUMENT_POSITION_PRECEDING,
            ),
          ),
        );
        const surfaces = page.locator('[data-slot="card"][data-surface="raised"]');
        assert.equal(await surfaces.count(), 2);
        const colors = await surfaces.evaluateAll(cards => ({
          sheet: getComputedStyle(document.querySelector('[data-slot="sheet-content"]')).backgroundColor,
          cards: cards.map(card => getComputedStyle(card).backgroundColor),
          dark: matchMedia('(prefers-color-scheme: dark)').matches,
        }));
        for (const color of colors.cards) {
          assert.notEqual(color, colors.sheet, 'Settings panels must be distinct from the sheet');
          if (colors.dark) {
            const brightness = value =>
              value
                .match(/[\d.]+/g)
                .slice(0, 3)
                .reduce((sum, channel) => sum + Number(channel), 0);
            assert.ok(
              brightness(color) > brightness(colors.sheet),
              'Dark settings panels must be lighter than the sheet',
            );
          }
        }
        const manage = page.getByRole('button', { name: 'Manage accounts', exact: true });
        if (await manage.count()) {
          assert.equal(await manage.evaluate(element => getComputedStyle(element).borderStyle), 'solid');
          assert.notEqual(await manage.evaluate(element => getComputedStyle(element).borderColor), 'rgba(0, 0, 0, 0)');
          assert.notEqual(
            await manage.evaluate(element => getComputedStyle(element).backgroundColor),
            'rgba(0, 0, 0, 0)',
          );
        }
      };
      const select = async () => {
        await page.getByRole('button', { name: 'Add repositories', exact: true }).click();
        await page.getByRole('region', { name: 'Select GitHub repositories', exact: true }).waitFor();
      };
      const choose = async () => {
        await select();
        await page.getByRole('radio', { name: /^Only repositories I choose/ }).click();
      };
      try {
        await run({ page, context, faults, sources, documents, writes, reads, open, select, choose });
        assert.deepEqual(errors, []);
        assert.deepEqual(unknown, []);
      } finally {
        await context.close();
      }
    }

    try {
      await t.test('sheet opening focuses its title during account loading and preserves keyboard focus cues', () =>
        fixture(async f => {
          const gate = Promise.withResolvers();
          f.faults.accountsGate = gate.promise;
          const about = f.page.getByRole('button', { name: 'About this integration', exact: true });
          const titleFocused = () =>
            f.page.waitForFunction(() => document.activeElement?.matches('[data-slot="sheet-title"]'));
          try {
            await f.page.goto(`${origin}/${workspace.slug}/integrations#github-accounts`, {
              waitUntil: 'domcontentloaded',
            });
            await f.page.getByText('Loading GitHub accounts…', { exact: true }).waitFor();
            await titleFocused();
            assert.equal(await about.evaluate(element => element.matches(':focus-visible')), false);
          } finally {
            gate.resolve();
          }
          await f.page.getByRole('button', { name: 'Manage accounts', exact: true }).waitFor();
          await titleFocused();
          assert.equal(await about.evaluate(element => element.matches(':focus-visible')), false);
          for (let step = 0; step < 8 && !(await about.evaluate(element => element === document.activeElement)); step++)
            await f.page.keyboard.press('Tab');
          assert.equal(
            await about.evaluate(element => element === document.activeElement && element.matches(':focus-visible')),
            true,
          );
          // sprout accordion.css paints the keyboard focus cue as a 2px outline rather than a box-shadow ring.
          assert.equal(
            await about.evaluate(element => {
              const style = getComputedStyle(element);
              return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
            }),
            true,
          );
          await f.page.keyboard.press('Enter');
          assert.equal(await about.getAttribute('aria-expanded'), 'true');
          await f.page.getByRole('button', { name: 'Close', exact: true }).click();
          const trigger = f.page.getByRole('button', { name: 'GitHub', exact: true });
          await trigger.click();
          await titleFocused();
          assert.equal(await about.evaluate(element => element.matches(':focus-visible')), false);
          await f.page.keyboard.press('Escape');
          await trigger.waitFor();
          await f.page.waitForFunction(element => element === document.activeElement, await trigger.elementHandle());
          assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
        }),
      );
      await t.test(
        'delayed discovery, retry after failure, scope explanation, empty state, pagination and uncertain save replay',
        () =>
          fixture(async f => {
            f.faults.discoveryDelay = 700;
            f.faults.discovery = 503;
            await f.open();
            await f.page.getByText('No repositories imported yet', { exact: true }).waitFor();
            await f.choose();
            assert.equal(await f.page.getByText('No repositories imported yet', { exact: true }).count(), 0);
            await f.page.getByRole('status', { name: 'Loading GitHub repositories' }).waitFor();
            await f.page.getByRole('button', { name: 'Retry loading GitHub repositories' }).waitFor();
            f.faults.discovery = 409;
            f.faults.discoveryError = 'github-reconnect-required';
            f.faults.discoveryDelay = 0;
            await f.page.getByRole('button', { name: 'Retry loading GitHub repositories' }).click();
            await f.page.getByText('This GitHub account needs to be reconnected.', { exact: false }).waitFor();
            assert.equal(
              await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).isDisabled(),
              true,
            );
            await f.page.getByRole('button', { name: 'Reconnect GitHub account', exact: true }).waitFor();
            f.faults.discovery = 200;
            f.faults.discoveryError = null;
            f.faults.empty = true;
            await f.page.getByRole('button', { name: 'Check GitHub again' }).click();
            await f.page.getByText('No repositories available', { exact: true }).waitFor();
            f.faults.empty = false;
            await f.page.getByRole('button', { name: 'Check GitHub repositories again' }).click();
            await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).click();
            await f.page.getByText('Choose at least one GitHub repository before saving.').waitFor();
            assert.equal(f.writes.filter(write => write.kind === 'save').length, 0);
            await f.page.getByRole('checkbox', { name: 'acme/leadership (private)' }).click();
            await f.page.getByRole('searchbox', { name: 'Find repositories' }).fill('archive');
            await f.page.getByRole('checkbox', { name: 'acme/archive (internal)' }).click();
            assert.ok(f.reads.some(read => read.query.cursor === '2'));
            await f.page.getByText('2 / 1,000 selected').waitFor();
            await f.page.getByRole('searchbox', { name: 'Find repositories' }).fill('');
            await f.page.getByRole('checkbox', { name: 'acme/handbook (private)' }).click();
            await importSettings(f.page);
            await f.page.getByRole('checkbox', { name: 'Discussions' }).click();
            f.faults.save = 503;
            f.faults.saveDelay = 500;
            await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).dblclick();
            await f.page.getByRole('button', { name: 'Adding to Knowledge…' }).waitFor();
            await f.page.getByRole('button', { name: 'Retry same operation' }).waitFor();
            assert.equal(f.writes.filter(write => write.kind === 'save').length, 1);
            assert.equal(await f.page.getByLabel('Use GitHub account', { exact: true }).isDisabled(), true);
            const original = f.writes.find(write => write.kind === 'save').body;
            assert.deepEqual(original.selection.repositories, ['acme/archive', 'acme/handbook', 'acme/leadership']);
            assert.deepEqual(original.selection.kinds, ['code', 'commits', 'docs', 'issues', 'pulls']);
            assert.equal(original.selection.after, undefined);
            assert.equal(original.accountId, personal.id);
            assert.deepEqual(original.memberIds, []);
            f.faults.save = 200;
            f.faults.saveDelay = 0;
            await f.page.getByRole('button', { name: 'Retry same operation' }).click();
            await f.page.getByText('acme/archive was saved.', { exact: false }).waitFor();
            assert.deepEqual(f.writes.filter(write => write.kind === 'save').at(-1).body, original);
          }),
      );

      await t.test('all repositories and all content are selected by default and new repositories follow', () =>
        fixture(async f => {
          await f.open();
          await f.page.getByText('indexes every repository it can read', { exact: false }).waitFor();
          await f.select();
          assert.equal(await f.page.getByRole('radio', { name: /^All repositories/ }).isChecked(), true);
          await f.page
            .getByText('3 repositories will be indexed now. New repositories are added on each sync.')
            .waitFor();
          await f.page.getByText('All content · full history · only you', { exact: true }).waitFor();
          await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).click();
          await f.page.getByText('All repositories was saved.', { exact: false }).waitFor();
          const saved = f.writes.find(write => write.kind === 'save').body;
          assert.deepEqual(saved.selection, {
            scope: 'all',
            repositories: [],
            kinds: ['code', 'commits', 'discussions', 'docs', 'issues', 'pulls'],
          });
          const row = f.page.getByRole('listitem', { name: 'All repositories', exact: true });
          await row.getByText('All repositories, including new ones · All content · full history').waitFor();
        }),
      );

      await t.test(
        'all six pages load before search; later-page failure hides partial results; owner filters preserve selection',
        () =>
          fixture(async f => {
            f.faults.accounts = [personal];
            const all = Array.from({ length: 260 }, (_, index) => ({
              repositoryId: String(index + 1),
              fullName: index === 259 ? 'TulipFarm/tulipfarm-cloud' : `octo-owner/project-${index}`,
              visibility: 'private',
              title: `Repository ${index}`,
            }));
            f.faults.discoveryPages = Array.from({ length: 6 }, (_, index) => all.slice(index * 50, (index + 1) * 50));
            f.faults.failedCursor = '6';
            await f.open();
            await f.choose();
            await f.page.getByRole('button', { name: 'Retry loading GitHub repositories' }).waitFor();
            assert.equal(await f.page.getByRole('checkbox').count(), 0);
            assert.equal(
              await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).isDisabled(),
              true,
            );
            f.faults.failedCursor = null;
            await f.page.getByRole('button', { name: 'Retry loading GitHub repositories' }).click();
            await f.page.getByText('260 repositories', { exact: true }).waitFor();
            const footer = f.page.getByRole('group', { name: 'Repository selection actions', exact: true });
            const before = await footer.boundingBox();
            assert.ok(before && before.y + before.height <= f.page.viewportSize().height);
            const repositoryList = f.page.getByRole('region', { name: 'Available repositories', exact: true });
            assert.equal(await repositoryList.evaluate(element => getComputedStyle(element).overflowY), 'visible');
            await f.page.getByRole('button', { name: 'Show more repositories', exact: true }).scrollIntoViewIfNeeded();
            const afterScroll = await footer.boundingBox();
            assert.equal(afterScroll.y, before.y, 'selection actions stay fixed while the drawer scrolls');
            assert.equal(
              await footer
                .getByRole('button', { name: 'Add to Knowledge', exact: true })
                .evaluate(button => button.form?.getAttribute('aria-label')),
              'Add repositories to Knowledge',
            );
            assert.equal(await f.page.getByLabel('Use GitHub account', { exact: true }).count(), 0);
            const search = f.page.getByRole('searchbox', { name: 'Find repositories' });
            await search.fill('tulipfarm-cloud');
            await f.page.getByRole('checkbox', { name: 'TulipFarm/tulipfarm-cloud (private)' }).click();
            await search.fill('');
            await f.page.getByRole('combobox', { name: 'Repository owner' }).click();
            await f.page.getByRole('option', { name: 'octo-owner', exact: true }).click();
            await f.page.getByText('259 of 260 repositories', { exact: true }).waitFor();
            await f.page.getByRole('button', { name: 'Remove TulipFarm/tulipfarm-cloud', exact: true }).waitFor();
            await search.fill('does-not-exist');
            await f.page.getByText('No repositories match', { exact: true }).waitFor();
            await f.page.getByRole('button', { name: 'Clear filters', exact: true }).click();
            await f.page.getByText('260 repositories', { exact: true }).waitFor();
            await f.page.getByRole('button', { name: 'Remove TulipFarm/tulipfarm-cloud', exact: true }).click();
            await f.page.getByText('0 / 1,000 selected', { exact: true }).waitFor();
            assert.equal(await search.evaluate(element => element === document.activeElement), true);
            const choices = repositoryList.getByRole('checkbox');
            for (let index = 0; index < 25; index++) await choices.nth(index).check();
            await f.page.getByText('25 / 1,000 selected', { exact: true }).waitFor();
            assert.equal(await choices.nth(25).isEnabled(), true);
          }),
      );

      await t.test(
        'account switch, content kinds, date bounds, shared audience and rejected selections are validated',
        () =>
          fixture(async f => {
            await f.open();
            await f.choose();
            await f.page.getByRole('checkbox', { name: 'acme/handbook (private)' }).click();
            await chooseAccount(f.page, '@octo-work');
            await f.page.getByRole('button', { name: 'Keep this account', exact: true }).click();
            await f.page.getByRole('button', { name: 'Remove acme/handbook', exact: true }).waitFor();
            await chooseAccount(f.page, '@octo-work');
            await f.page.getByRole('button', { name: 'Switch account and clear selection', exact: true }).click();
            assert.equal(await f.page.getByRole('button', { name: 'Remove acme/handbook', exact: true }).count(), 0);
            await f.page.getByRole('checkbox', { name: 'work/public-docs', exact: true }).click();
            await importSettings(f.page);
            for (const name of [
              'Source code',
              'Documentation and text files',
              'Issues and comments',
              'Pull request descriptions and comments',
              'Discussions',
              'Commit messages and changed files',
            ])
              await f.page.getByRole('checkbox', { name }).click();
            await f.page.getByLabel('Only index activity after').fill('2999-01-01');
            await f.page.getByLabel('Exclude file paths').fill('^vendor/\n(a+)+$');
            await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).click();
            await f.page.getByText('Choose at least one kind of content.').waitFor();
            await f.page.getByText('Enter a date that is not in the future.').waitFor();
            await f.page.getByText('“(a+)+$” could take too long to match', { exact: false }).waitFor();
            assert.equal(f.writes.filter(write => write.kind === 'save').length, 0);
            for (const name of [
              'Documentation and text files',
              'Issues and comments',
              'Pull request descriptions and comments',
              'Commit messages and changed files',
            ])
              await f.page.getByRole('checkbox', { name }).click();
            await f.page.getByLabel('Only index activity after').fill(after);
            await f.page.getByLabel('Exclude file paths').fill('^vendor/\n\\.min\\.js$');
            f.faults.members = 503;
            await f.page.getByRole('checkbox', { name: 'Share with selected workspace members' }).click();
            await f.page.getByRole('button', { name: 'Retry loading workspace members' }).waitFor();
            await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).click();
            await f.page
              .getByText('Load the current workspace members and select at least one reader', { exact: false })
              .waitFor();
            f.faults.members = 200;
            await f.page.getByRole('button', { name: 'Retry loading workspace members' }).click();
            await f.page.getByRole('checkbox', { name: 'Casey Reader (casey@example.test)' }).click();
            f.faults.save = 404;
            f.faults.saveError = 'github-forbidden';
            await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).click();
            await f.page.getByText('Your access changed. Close this view and check your workspace access.').waitFor();
            f.faults.save = 400;
            f.faults.saveError = 'github-invalid-selection';
            await f.page.getByRole('button', { name: 'Cancel selection' }).click();
            await f.choose();
            await chooseAccount(f.page, '@octo-work');
            await f.page.getByRole('checkbox', { name: 'work/public-docs', exact: true }).click();
            await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).click();
            await f.page
              .getByText('A repository was renamed, a date is in the future or an exclude pattern was rejected.', {
                exact: false,
              })
              .waitFor();
            f.faults.save = 200;
            f.faults.saveError = null;
            await f.page.getByRole('button', { name: 'Add to Knowledge', exact: true }).click();
            await f.page.getByText('work/public-docs was saved.', { exact: false }).waitFor();
            const saved = f.writes.filter(write => write.kind === 'save').at(-1).body;
            assert.equal(saved.accountId, work.id);
            assert.deepEqual(saved.selection, {
              repositories: ['work/public-docs'],
              kinds: ['code', 'commits', 'discussions', 'docs', 'issues', 'pulls'],
            });
          }),
      );

      await t.test('without an active account selection is unavailable and explains the next step', () =>
        fixture(async f => {
          f.faults.accounts = [{ ...personal, state: 'reconnect-required' }];
          await f.open();
          await f.page.getByText('Connect a GitHub account above to select repositories.').waitFor();
          assert.equal(await f.page.getByRole('button', { name: 'Add repositories', exact: true }).isDisabled(), true);
          f.faults.configured = false;
          await f.page.reload();
          await f.page.getByRole('heading', { name: 'GitHub OAuth is not configured' }).waitFor();
          assert.equal(
            await f.page.getByRole('heading', { name: 'Repositories in Knowledge', exact: true }).count(),
            0,
          );
        }),
      );

      await t.test('blocked repositories explain themselves; owner management and access refresh recover', () =>
        fixture(async f => {
          const item = source();
          f.sources.set(item.sourceId, item);
          const row = () => f.page.getByRole('listitem', { name: item.title, exact: true });
          await f.open();
          await row()
            .getByText('The source owner can no longer read this repository in GitHub.', { exact: false })
            .waitFor();
          await row().getByText('Access lost', { exact: true }).waitFor();
          await row().getByText('1 active · 1 access lost', { exact: true }).waitFor();
          await row()
            .getByText('2 chosen repositories · docs, issues, pull requests · activity since', { exact: false })
            .waitFor();
          await row().getByText('8 ready · 1 failed · 9 items discovered').waitFor();
          await row().getByRole('button', { name: 'Edit settings' }).click();
          const settings = row().getByRole('region', { name: 'GitHub source settings', exact: true });
          await settings.getByRole('checkbox', { name: 'acme/leadership (private)' }).uncheck();
          await settings.getByText('1 of 2 repositories included', { exact: true }).waitFor();
          await settings.getByRole('checkbox', { name: 'Discussions' }).check();
          await settings.getByLabel('Exclude file paths').fill('^vendor/');
          await settings.getByRole('button', { name: 'Save source settings' }).click();
          await row().getByText('Excluded', { exact: true }).waitFor();
          await row().getByText('1 excluded · discussions, docs, issues, pull requests', { exact: false }).waitFor();
          const change = f.writes.find(write => write.kind === 'settings').body;
          assert.deepEqual(change.excludedRepositories, ['7002']);
          assert.deepEqual(change.kinds, ['discussions', 'docs', 'issues', 'pulls']);
          assert.deepEqual(change.excludePaths, ['^vendor/']);
          assert.equal(change.after, after);
          f.faults.refresh = 503;
          await row().getByRole('button', { name: 'Refresh my access' }).click();
          await row()
            .getByText('Could not refresh your access. No current authorization is confirmed.', { exact: false })
            .waitFor();
          f.faults.refresh = 200;
          await row().getByRole('button', { name: 'Retry access refresh' }).click();
          await row()
            .getByText('Checked 2 repositories: 1 confirmed, 1 unavailable to you.', { exact: false })
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
          await row().getByText('The content stays in GitHub.', { exact: false }).waitFor();
          await row().getByRole('button', { name: 'Confirm remove source' }).click();
          await f.page.getByText('No repositories imported yet', { exact: true }).waitFor();
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

      await t.test('revoked access prompts a reconnect and repositories show missing permissions', () =>
        fixture(async f => {
          const item = source({
            connection: 'reconnect-required',
            failure: 'reconnect-required',
            syncState: 'failed',
            repositories: [
              { ...repositories[0], status: 'needs-permission', missingKinds: ['issues', 'pulls'] },
              {
                ...repositories[1],
                failure: 'insufficient-scope',
                status: 'needs-permission',
                missingKinds: ['docs', 'issues', 'pulls'],
              },
            ],
            repositoryCounts: { active: 0, excluded: 0, needsPermission: 2, accessLost: 0 },
          });
          f.sources.set(item.sourceId, item);
          const row = () => f.page.getByRole('listitem', { name: item.title, exact: true });
          await f.open();
          await row().getByText('GitHub access for this source needs to be reconnected.', { exact: false }).waitFor();
          await row().getByText('0 active · 2 need permission', { exact: true }).waitFor();
          assert.equal(await row().getByText('Needs permission', { exact: true }).count(), 2);
          await row().getByText('cannot read issues, pull requests in this repository', { exact: false }).waitFor();
          await row().getByText('Reconnect it with repository access, then retry.', { exact: false }).waitFor();
          await row().getByRole('button', { name: 'Reconnect GitHub', exact: true }).click();
          await delay(300);
          assert.ok(
            f.reads.some(
              read => read.method === 'POST' && read.path.endsWith(`/github/accounts/${personal.id}/reconnect`),
            ),
          );
        }),
      );

      await t.test('shared readers see that the owner must reconnect, without a reconnect button', () =>
        fixture(async f => {
          const item = source({ canManage: false, connection: 'reconnect-required', selection: null });
          f.sources.set(item.sourceId, item);
          const row = () => f.page.getByRole('listitem', { name: item.title, exact: true });
          await f.open();
          await row().getByText('may be out of date until the source owner reconnects', { exact: false }).waitFor();
          assert.equal(await row().getByRole('button', { name: 'Reconnect GitHub', exact: true }).count(), 0);
        }),
      );

      await t.test(
        'shared readers see no selection or management; import details download through the GitHub route',
        () =>
          fixture(async f => {
            const shared = source({
              title: 'Shared GitHub source',
              canManage: false,
              selection: null,
              repositories: null,
              counts: null,
              memberIds: [],
            });
            f.sources.set(shared.sourceId, shared);
            f.documents.set(shared.sourceId, [
              [
                {
                  documentId: randomUUID(),
                  revisionId: randomUUID(),
                  title: 'acme/handbook: docs/huge.md',
                  publicationId: null,
                  parsing: 'failed',
                  embedding: 'pending',
                  failure: 'too-large',
                  validUntil: new Date(Date.now() + 60_000).toISOString(),
                  canRetry: false,
                },
                {
                  documentId: workspace.id,
                  revisionId: workspace.id,
                  title: 'acme/handbook#4: Orchid shipment',
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
            const row = f.page.getByRole('listitem', { name: 'Shared GitHub source', exact: true });
            await row
              .getByText('Only the source owner can change settings, pause, resume, retry, or remove it.')
              .waitFor();
            assert.equal(await row.getByRole('button', { name: 'Edit settings' }).count(), 0);
            assert.equal(await row.getByRole('button', { name: 'Pause source' }).count(), 0);
            assert.equal(await row.getByRole('list', { name: 'Selected repositories' }).count(), 0);
            await row.getByRole('button', { name: 'View import details' }).click();
            await f.page
              .getByText('This part is larger than the 1 MB Knowledge limit and is not searchable.')
              .waitFor();
            const download = f.page.waitForEvent('download');
            await f.page
              .getByRole('listitem', { name: 'acme/handbook#4: Orchid shipment', exact: true })
              .getByRole('button', { name: 'Download item' })
              .click();
            assert.equal((await download).suggestedFilename(), 'github-document.md');
            assert.ok(
              f.reads.some(
                read => read.path.includes('/knowledge/github/documents/') && read.path.endsWith('/original'),
              ),
            );
            await f.page.getByRole('button', { name: 'Next GitHub items' }).click();
            await f.page.getByText('No authorized items on this page').waitFor();
          }),
      );

      await t.test(
        'an oversized replacement shows its failure instead of Searchable and labels the retained download as an earlier version',
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
                  title: 'acme/handbook: docs/vendors.md',
                  publicationId: null,
                  parsing: 'failed',
                  embedding: 'pending',
                  failure: 'too-large',
                  historical: true,
                  validUntil,
                  canRetry: false,
                },
                {
                  documentId: workspace.id,
                  revisionId: workspace.id,
                  title: 'acme/handbook: README.md',
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
            const replaced = f.page.getByRole('listitem', { name: 'acme/handbook: docs/vendors.md', exact: true });
            await replaced.getByText('Import failed', { exact: true }).waitFor();
            assert.equal(await replaced.getByText('Searchable', { exact: true }).count(), 0);
            await replaced
              .getByText('This part is larger than the 1 MB Knowledge limit and is not searchable.')
              .waitFor();
            await replaced
              .getByText(
                'This item changed in GitHub. Knowledge has not imported the current version, so this download is the earlier version.',
              )
              .waitFor();
            assert.equal(await replaced.getByRole('button', { name: 'Download item' }).count(), 0);
            const download = f.page.waitForEvent('download');
            await replaced.getByRole('button', { name: 'Download earlier version' }).click();
            assert.equal((await download).suggestedFilename(), 'github-document.md');
            const current = f.page.getByRole('listitem', { name: 'acme/handbook: README.md', exact: true });
            await current.getByText('Searchable', { exact: true }).waitFor();
            await current.getByRole('button', { name: 'Download item' }).waitFor();
            assert.equal(await current.getByText('this download is the earlier version', { exact: false }).count(), 0);
          }),
      );

      await t.test('expired item access hides titles and downloads', () =>
        fixture(async f => {
          const item = source();
          f.sources.set(item.sourceId, item);
          await f.open();
          const now = new Date();
          await f.page.clock.install({ time: now });
          f.documents.set(item.sourceId, [
            [
              {
                documentId: workspace.id,
                revisionId: workspace.id,
                title: 'acme/handbook: README.md',
                publicationId: workspace.id,
                parsing: 'ready',
                embedding: 'ready',
                failure: null,
                validUntil: new Date(now.getTime() + 60_000).toISOString(),
                canRetry: false,
              },
            ],
          ]);
          await f.page
            .getByRole('listitem', { name: item.title, exact: true })
            .getByRole('button', { name: 'View import details' })
            .click();
          await f.page.getByText('acme/handbook: README.md', { exact: true }).waitFor();
          await f.page.clock.fastForward(60_001);
          await f.page.getByText('Item access check expired', { exact: true }).waitFor({ timeout: 10_000 });
          assert.equal(await f.page.getByText('acme/handbook: README.md', { exact: true }).count(), 0);
          assert.equal(await f.page.getByRole('button', { name: 'Download item' }).count(), 0);
        }),
      );

      for (const width of [320, 375, 414, 768, 1440])
        await t.test(
          `${width}px ${width < 768 ? 'dark' : 'light'} long names, fixed actions, keyboard selection and focus return`,
          () =>
            fixture(
              async f => {
                f.faults.longName = true;
                const item = source({ title: 'acme/handbook and international supplier operations '.repeat(4) });
                f.sources.set(item.sourceId, item);
                await f.open();
                await f.choose();
                await f.page.getByRole('checkbox', { name: /^acme\/handbook-international/ }).focus();
                await f.page.keyboard.press('Space');
                await f.page.getByText('1 / 1,000 selected').waitFor();
                await importSettings(f.page);
                await f.page.getByRole('checkbox', { name: 'Share with selected workspace members' }).focus();
                await f.page.keyboard.press('Space');
                await f.page.getByRole('checkbox', { name: 'Casey Reader (casey@example.test)' }).waitFor();
                assert.equal(
                  await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
                  true,
                );
                const footer = f.page.getByRole('group', { name: 'Repository selection actions', exact: true });
                const box = await footer.boundingBox();
                assert.ok(box && box.y >= 0 && box.y + box.height <= f.page.viewportSize().height);
                assert.equal(await footer.evaluate(element => element.scrollWidth <= element.clientWidth), true);
                const scroll = f.page.locator('[data-github-scroll]');
                assert.equal(await scroll.evaluate(element => element.scrollWidth <= element.clientWidth), true);
                await f.page
                  .getByRole('region', { name: 'GitHub knowledge sources', exact: true })
                  .scrollIntoViewIfNeeded();
                await f.page.screenshot({ path: `${screenshots}/${width}px.png`, fullPage: true });
                await f.page.getByRole('button', { name: 'Cancel selection' }).click();
                assert.equal(
                  await f.page
                    .getByRole('heading', { name: 'Repositories in Knowledge', exact: true })
                    .evaluate(element => element === document.activeElement),
                  true,
                );
              },
              width < 768,
              width,
            ),
        );
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
