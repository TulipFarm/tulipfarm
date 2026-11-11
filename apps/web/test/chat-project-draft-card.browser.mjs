import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits, notifyChange } from './chat-query.fixture.mjs';

test('project reviews load, decide and retain their results after reloading', { timeout: 120000 }, async () => {
  const { workspace, session } = createWorkspaceFixture({ slug: 'fieldwork', name: 'Fieldwork' });
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        hasTouch: mobile,
        isMobile: mobile,
        colorScheme: mobile ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        let reloadFailures = false;
        let generation = 0;
        let reloadGeneration;
        const requestGenerations = new WeakMap();
        const isReloadRead = request => reloadFailures && requestGenerations.get(request) === reloadGeneration;
        let permanentFailure = true;
        let historyReads = 0;
        const draftReads = new Map();
        const inFlight = new Set();
        let peak = 0;
        page.on('framenavigated', frame => {
          if (frame === page.mainFrame()) generation++;
        });
        page.on('request', request => {
          requestGenerations.set(request, generation);
          if (!isReloadRead(request) || !/\/drafts\/[\w-]+$/.test(new URL(request.url()).pathname)) return;
          inFlight.add(request);
          peak = Math.max(peak, inFlight.size);
        });
        page.on('requestfinished', request => inFlight.delete(request));
        page.on('requestfailed', request => inFlight.delete(request));
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
          if (message.type() === 'error' && !reloadFailures) errors.push(message.text());
        });
        page.on('response', response => {
          if (response.status() >= 400 && !reloadFailures)
            errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
        });
        const chatId = randomUUID();
        const chat = {
          id: chatId,
          title: 'Project changes',
          titleRevision: 1,
          archived: false,
          activityAt: '2026-10-11T10:00:00Z',
          createdAt: '2026-10-11T10:00:00Z',
        };
        const settings = { name: 'Launch', instructions: 'Keep replies short. \u{1f337}', archived: false };
        const cases = [
          { name: 'create', current: null, settings, verb: 'Create', done: 'created' },
          { name: 'decline', current: null, settings: { ...settings, name: 'Declined' }, verb: 'Create' },
          {
            name: 'rename',
            current: settings,
            settings: { ...settings, name: 'Autumn' },
            verb: 'Update',
            done: 'updated',
          },
          {
            name: 'instructions',
            current: settings,
            settings: { ...settings, instructions: 'Cite sources.' },
            verb: 'Update',
            done: 'updated',
          },
          {
            name: 'archive',
            current: settings,
            settings: { ...settings, archived: true },
            verb: 'Archive',
            done: 'archived',
          },
          { name: 'restore', current: { ...settings, archived: true }, settings, verb: 'Restore', done: 'restored' },
        ].map(item => ({ ...item, id: randomUUID(), projectId: randomUUID() }));
        const drafts = new Map(
          cases.map(item => [
            item.id,
            {
              id: item.id,
              digest: 'd'.repeat(64),
              proposal: {
                kind: 'project',
                targetId: item.projectId,
                input: { current: item.current, expectedRevision: item.current ? 1 : null, settings: item.settings },
              },
              status: 'pending',
              outcome: null,
            },
          ]),
        );
        const decisions = [];
        const projects = [];
        const history = [
          {
            id: randomUUID(),
            sequence: 1,
            author: 'assistant',
            createdAt: '2026-10-11T10:00:01Z',
            parts: [{ kind: 'text', text: 'Review the project changes.' }],
            turn: null,
            tools: [],
          },
        ];
        await page.route('**/v1/**', async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          const method = request.method();
          if (await serveWorkspaceShellEvent(route, workspace)) return;
          const shell = workspaceShellReads(workspace.id).find(([url]) => url === path);
          if (shell) return route.fulfill({ json: shell[1] });
          if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
          if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
          if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
          if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
          if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
          if (path.endsWith('/governance'))
            return route.fulfill({
              json: {
                actorMembershipId: membership.membershipId,
                members: [],
                teams: [],
                directory: [],
                tableTeamIds: [],
                tables: [],
                grants: [],
              },
            });
          if (path.endsWith('/credits')) return route.fulfill({ json: credits });
          if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
          if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
          if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
          if (path.endsWith('/projects')) return route.fulfill({ json: projects });
          if (path.endsWith('/google-workspace/operations/proposals'))
            return route.fulfill({ json: { proposals: [], nextCursor: null } });
          if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
          if (path.endsWith('/conversations') && method === 'GET')
            return route.fulfill({ json: { chats: [chat], nextCursor: null } });
          const conversation = /\/conversations\/[\w-]+(\/.*)?$/.exec(path);
          if (conversation) {
            const rest = conversation[1] ?? '';
            if (method === 'GET' && rest === '/events') return route.fulfill({ status: 204 });
            const draft = /^\/drafts\/([\w-]+)(\/decision)?$/.exec(rest);
            if (draft && drafts.has(draft[1])) {
              const current = drafts.get(draft[1]);
              if (method === 'GET' && !draft[2]) {
                if (isReloadRead(request)) {
                  const attempt = (draftReads.get(draft[1]) ?? 0) + 1;
                  draftReads.set(draft[1], attempt);
                  if (draft[1] === cases[0].id && attempt <= 3) return route.abort('failed');
                  if ((draft[1] === cases[2].id && attempt <= 3) || (draft[1] === cases[5].id && permanentFailure))
                    return route.fulfill({ status: 503, json: { error: 'draft-unavailable' } });
                  if (attempt === 1 && [cases[3].id, cases[4].id].includes(draft[1])) {
                    await new Promise(resolve => setTimeout(resolve, draft[1] === cases[3].id ? 16000 : 11000));
                    if (request.failure()) return;
                  }
                }
                return route.fulfill({ json: current });
              }
              if (method === 'PUT' && draft[2]) {
                const body = request.postDataJSON();
                decisions.push({ id: draft[1], ...body });
                assert.equal(body.digest, current.digest);
                assert.equal(current.status, 'pending');
                const outcome =
                  body.decision === 'dismiss'
                    ? { kind: 'dismissed' }
                    : { kind: 'project', projectId: current.proposal.targetId, revision: 2 };
                drafts.set(draft[1], {
                  ...current,
                  outcome,
                  status: body.decision === 'dismiss' ? 'dismissed' : 'saved',
                });
                if (body.decision === 'save')
                  projects.push({
                    id: outcome.projectId,
                    ...current.proposal.input.settings,
                    revision: 2,
                    manager: true,
                  });
                return route.fulfill({ json: outcome });
              }
            }
            if (method === 'GET' && rest === '/messages') {
              historyReads++;
              return route.fulfill({ json: { messages: history, nextBefore: null, hasGitHubProposals: false } });
            }
            if (method === 'GET' && rest === '/plans') return route.fulfill({ json: { plans: [] } });
            if (method === 'GET' && !rest) return route.fulfill({ json: chat });
            if (method === 'GET') return route.fulfill({ json: [] });
          }
          if (path.endsWith('/integrations')) return route.fulfill({ json: { integrations: [] } });
          if (path.endsWith(`/github/chats/${chatId}/selection`))
            return route.fulfill({ json: { accountId: null, generation: null, version: 0 } });
          if (path.endsWith(`/github/chats/${chatId}/batches`)) return route.fulfill({ json: { batches: [] } });
          if (path.endsWith('/system-package-installations'))
            return route.fulfill({ json: { installations: [], nextCursor: null } });
          throw new Error(`Unexpected API request ${method} ${path}`);
        });
        await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}/chat/${chatId}`, { timeout: 60000 });
        await page
          .getByText('Review the project changes.', { exact: true })
          .waitFor({ timeout: 60000 })
          .catch(async error => {
            if (process.env.PROJECT_DRAFT_SCREENSHOTS)
              await page.screenshot({ path: `${process.env.PROJECT_DRAFT_SCREENSHOTS}/project-arrival-error.png` });
            throw error;
          });
        history[0].tools = cases.map(item => ({
          id: item.id,
          tool: 'projects.draft',
          status: 'completed',
          rowDraftId: item.id,
        }));
        await notifyChange(page, workspace.id, session.user.id, 'history', chatId);
        const card = item => page.locator('[aria-label^="Review project "]').nth(cases.indexOf(item));
        const shots = process.env.PROJECT_DRAFT_SCREENSHOTS;
        const theme = mobile ? 'mobile-dark' : 'desktop-light';
        await page
          .locator('[aria-label="Review project create"]')
          .or(page.getByText('Could not load draft', { exact: true }))
          .first()
          .waitFor({ timeout: 60000 });
        if (shots && (await page.getByText('Could not load draft', { exact: true }).count()))
          await page.screenshot({ path: `${shots}/project-error-${theme}.png` });
        for (const item of cases) {
          await card(item)
            .getByRole('button', { name: `${item.verb} project`, exact: true })
            .waitFor();
          if (!item.current || item.current.instructions !== item.settings.instructions)
            await card(item).getByText(item.settings.instructions, { exact: true }).waitFor();
          if (item.current && item.current.name !== item.settings.name)
            await card(item).getByText(item.current.name, { exact: true }).waitFor();
        }
        assert.deepEqual(decisions, [], 'loading a review must not approve it');
        assert.deepEqual(projects, [], 'loading a review must not create a project');
        if (shots) await card(cases[0]).screenshot({ path: `${shots}/project-pending-${theme}.png` });
        for (const item of cases) {
          const decline = item.name === 'decline';
          await card(item)
            .getByRole('button', { name: decline ? 'Not now' : `${item.verb} project`, exact: true })
            .click();
          await card(item)
            .getByText(decline ? 'Draft dismissed. Nothing was created.' : `Project ${item.done}.`, { exact: true })
            .waitFor()
            .catch(async error => {
              console.error({ decisions, draft: drafts.get(item.id), errors });
              if (shots) await page.screenshot({ path: `${shots}/project-decision-error-${theme}.png` });
              throw error;
            });
          if (!decline)
            assert.equal(
              await card(item).getByRole('link', { name: 'Open project', exact: true }).getAttribute('href'),
              `/${workspace.slug}/projects/${item.projectId}`,
            );
        }
        assert.equal(decisions.length, cases.length);
        assert.equal(
          projects.some(project => project.id === cases[1].projectId),
          false,
        );
        reloadGeneration = generation + 1;
        reloadFailures = true;
        const outgoingStatus = await page.evaluate(
          async url => (await fetch(url)).status,
          `/v1/workspaces/${workspace.id}/conversations/${chatId}/drafts/${cases[5].id}`,
        );
        assert.equal(outgoingStatus, 200, 'outgoing-document reads do not consume the reload failure script');
        assert.equal(draftReads.size, 0, 'outgoing-document reads do not count as reloaded reads');
        assert.equal(peak, 0, 'outgoing-document reads do not count toward reloaded concurrency');
        await page.reload();
        assert.equal(generation, reloadGeneration, 'failure scripting is scoped to the reloaded document');
        await page.getByText('Could not load draft', { exact: true }).waitFor({ timeout: 45000 });
        assert.ok(
          draftReads.get(cases[5].id) <= 8,
          `permanent failures exhaust a bounded retry budget, observed ${draftReads.get(cases[5].id)} requests`,
        );
        if (shots) await page.screenshot({ path: `${shots}/project-retry-${theme}.png` });
        permanentFailure = false;
        await page.getByRole('button', { name: 'Retry loading draft', exact: true }).click();
        for (const item of cases) {
          await card(item)
            .getByText(item.name === 'decline' ? 'Draft dismissed. Nothing was created.' : `Project ${item.done}.`, {
              exact: true,
            })
            .waitFor({ timeout: 45000 });
          assert.equal(await card(item).getByRole('button', { name: 'Not now', exact: true }).count(), 0);
          if (item.name !== 'decline')
            await card(item).getByRole('link', { name: 'Open project', exact: true }).waitFor();
        }
        assert.equal(decisions.length, cases.length, 'reload does not repeat a decision');
        assert.equal(await page.getByText('Could not load draft', { exact: true }).count(), 0);
        assert.equal(await page.getByRole('status', { name: 'Loading authoring draft' }).count(), 0);
        assert.ok(peak <= 3, `at most three draft reads run together, observed ${peak}`);
        assert.equal(draftReads.get(cases[0].id), 4, 'network failures recover without sibling cancellation');
        assert.equal(draftReads.get(cases[2].id), 4, '503 failures recover automatically');
        assert.equal(draftReads.get(cases[3].id), 2, 'a timed-out read recovers automatically');
        assert.equal(draftReads.get(cases[4].id), 1, 'a slow successful read is not cancelled by saved siblings');
        assert.equal(draftReads.get(cases[1].id), 1, 'a settled card does not invalidate sibling reads on reload');
        if (shots) await card(cases[0]).screenshot({ path: `${shots}/project-created-${theme}.png` });
        reloadFailures = false;
        const notifyDraft = async id => {
          await page.evaluate(
            ({ workspaceId, userId, membershipId, chatId, id }) => {
              const channel = new BroadcastChannel('tulipfarm:query:v1');
              channel.postMessage({
                version: 1,
                id: crypto.randomUUID(),
                sessionId: 'other-tab',
                scope: { kind: 'workspace', workspaceId, userId, membershipId },
                kind: 'change',
                keys: [['conversations', 'detail', chatId, 'draft', id]],
              });
              channel.close();
            },
            { workspaceId: workspace.id, userId: session.user.id, membershipId: membership.membershipId, chatId, id },
          );
        };
        for (const status of ['dismissed', 'failed', 'saved']) {
          const current = drafts.get(cases[0].id);
          const before = historyReads;
          drafts.set(current.id, { ...current, status: 'pending', outcome: null });
          await notifyDraft(current.id);
          await card(cases[0]).getByRole('button', { name: 'Create project', exact: true }).waitFor();
          assert.equal(historyReads, before, 'a nonfinal observation does not refresh history');
          drafts.set(current.id, {
            ...current,
            status,
            outcome:
              status === 'saved'
                ? { kind: 'project', projectId: cases[0].projectId, revision: 2 }
                : { kind: status === 'dismissed' ? 'dismissed' : 'unavailable' },
          });
          const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/messages'));
          await notifyDraft(current.id);
          await refreshed;
          await card(cases[0])
            .getByText(
              status === 'saved'
                ? 'Project created.'
                : status === 'dismissed'
                  ? 'Draft dismissed. Nothing was created.'
                  : 'The project could not be created. Ask chat to retry.',
              { exact: true },
            )
            .waitFor();
          assert.equal(historyReads, before + 1, 'a final transition refreshes the conversation once');
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
