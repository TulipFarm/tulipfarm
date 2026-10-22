import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';
import { libraryItem } from './files-library.fixture.mjs';

const me = membership.membershipId;
const ana = { membershipId: '33333333-3333-4333-8333-333333333333', name: 'Ana Reyes', email: 'ana@example.test' };
const file = (id, name, mediaType) =>
  libraryItem({ id, kind: 'file', name, creatorMembershipId: me, mediaType, size: 2048 });
const budget = file('44444444-4444-4444-8444-444444444444', 'Q3 budget.csv', 'text/csv');
const notes = file('55555555-5555-4555-8555-555555555555', 'Pricing notes.md', 'text/markdown');
const scan = file('66666666-6666-4666-8666-666666666666', 'Signed contract.pdf', 'application/pdf');
const project = '88888888-8888-4888-8888-888888888888';
const projects = [
  { id: project, name: 'Launch', instructions: '', revision: 1, archived: false, manager: true },
  {
    id: '99999999-9999-4999-8999-999999999990',
    name: 'Old campaign',
    instructions: '',
    revision: 1,
    archived: true,
    manager: true,
  },
  {
    id: '99999999-9999-4999-8999-999999999991',
    name: 'Finance',
    instructions: '',
    revision: 1,
    archived: false,
    manager: false,
  },
];
const doc = (documentId, fileId, title, parsing, extra = {}) => ({
  documentId,
  revisionId: documentId,
  title,
  parsing,
  failure: null,
  publicationId: null,
  canRetry: false,
  kind: 'file',
  fileId,
  ...extra,
});

test(
  'Add to Knowledge and Add to project show the destination and audience, then track each file',
  { timeout: 180000 },
  async () => {
    const { workspace, session } = createWorkspaceFixture();
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch();
    const shots =
      process.env.FILES_SCREENSHOTS ?? fileURLToPath(new URL('../../../reports/check/files-browser/', import.meta.url));
    await mkdir(shots, { recursive: true });
    try {
      for (const mobile of [false, true]) {
        const label = mobile ? 'mobile-dark' : 'desktop-light';
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          hasTouch: mobile,
          isMobile: mobile,
          colorScheme: mobile ? 'dark' : 'light',
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const base = `/v1/workspaces/${workspace.id}`;
        const state = {
          listFailures: 1,
          entries: new Map(),
          polls: new Map(),
          adds: [],
          retries: 0,
          anaCanOpen: false,
          audience: [],
          projectAdds: [],
          projectAddFailures: 1,
        };
        await page.route('**/v1/**', async route => {
          const request = route.request();
          const url = new URL(request.url());
          const path = url.pathname;
          const method = request.method();
          if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
          if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
          if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
          if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
          if (path === `/v1/workspaces/${workspace.slug}/last-used` && method === 'PUT')
            return route.fulfill({ status: 204 });
          if (path === `${base}/github/accounts` && method === 'GET')
            return route.fulfill({ json: { configured: false, accounts: [] } });
          if (path === `${base}/atlassian/accounts` && method === 'GET')
            return route.fulfill({ json: { accounts: [], providers: [] } });
          if (path === `${base}/slack/status` && method === 'GET')
            return route.fulfill({
              json: { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] },
            });
          if (path === `${base}/bud` && method === 'GET')
            return route.fulfill({
              json: {
                conversationId: null,
                onboarding: 'skipped',
                bubblesEnabled: false,
                snoozedUntil: null,
                nudge: null,
                preferences: [],
              },
            });
          if ((path === `${base}/recommendations` || path === `${base}/recommendations/events`) && method === 'GET')
            return route.fulfill({ status: 503, json: { error: 'recommendations-unavailable' } });
          if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
          if (path.endsWith('/credits')) return route.fulfill({ json: credits });
          if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
          if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
          if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
          if (path.endsWith('/google-workspace/operations/proposals'))
            return route.fulfill({ json: { proposals: [], nextCursor: null } });
          if (path.endsWith('/workspace-mcp/capabilities'))
            return route.fulfill({ status: 404, json: { error: 'not-found' } });
          if (path === `${base}/projects`) return route.fulfill({ json: projects });
          if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
          if (path === `${base}/files/usage`)
            return route.fulfill({ json: { usedBytes: 8192, quotaBytes: 1073741824, maxFileBytes: 10485760 } });
          if (path === `${base}/files/library`)
            return route.fulfill({ json: { items: [budget, notes, scan], next: null, breadcrumbs: [], owners: [] } });
          if (path === `${base}/files/${budget.id}`) return route.fulfill({ json: budget });
          if (path === `${base}/files/${budget.id}/recent-use` && method === 'POST')
            return route.fulfill({ json: { ok: true } });
          if (path === `${base}/files/${budget.id}/content`)
            return route.fulfill({
              body: 'quarter,amount\nQ3,42',
              headers: { 'content-type': 'application/octet-stream' },
            });
          if (path === `${base}/files/${budget.id}/directory`)
            return route.fulfill({
              json: { members: [{ membershipId: me, name: 'Ada', email: 'ada@example.test' }, ana], teams: [] },
            });
          if (path === `${base}/files/${budget.id}/sharing` && method === 'GET')
            return route.fulfill({
              json: {
                item: { kind: 'readable', id: budget.id, name: budget.name },
                creator: { membershipId: me, active: true },
                effectiveRole: 'manager',
                directGrants: state.anaCanOpen
                  ? [{ subject: { kind: 'individual', id: ana.membershipId }, role: 'viewer' }]
                  : [],
                inherited: [],
                effectiveAudience: [
                  { membershipId: me, role: 'manager' },
                  ...(state.anaCanOpen ? [{ membershipId: ana.membershipId, role: 'viewer' }] : []),
                ],
              },
            });
          if (path === `${base}/files/${budget.id}/sharing` && method === 'PUT') {
            state.anaCanOpen = true;
            return route.fulfill({ json: { id: budget.id } });
          }

          if (path === `${base}/knowledge/documents` && method === 'GET') {
            if (state.listFailures > 0) {
              state.listFailures--;
              return route.fulfill({ status: 503, json: { error: 'knowledge-unavailable' } });
            }
            return route.fulfill({
              json: { items: [...state.entries.values()].filter(entry => entry.fileId === scan.id), nextCursor: null },
            });
          }
          const knowledge = /\/knowledge\/documents\/([\w-]+)(\/retry)?$/.exec(path);
          if (knowledge) {
            const [, documentId, retry] = knowledge;
            if (method === 'PUT') {
              const body = request.postDataJSON();
              state.adds.push(body.input.fileId);
              const entry = doc(documentId, body.input.fileId, body.title, 'queued');
              state.entries.set(documentId, entry);
              return route.fulfill({ json: entry });
            }
            const entry = state.entries.get(documentId);
            if (retry) {
              state.retries++;
              const next = { ...entry, parsing: 'queued', canRetry: false, failure: null };
              state.entries.set(documentId, next);
              state.polls.set(documentId, 0);
              return route.fulfill({ json: next });
            }
            const polls = (state.polls.get(documentId) ?? 0) + 1;
            state.polls.set(documentId, polls);
            const next =
              polls === 1
                ? { ...entry, parsing: 'parsing' }
                : entry.fileId === budget.id && state.retries === 0
                  ? { ...entry, parsing: 'failed', failure: 'provider', canRetry: true }
                  : { ...entry, parsing: 'ready' };
            state.entries.set(documentId, next);
            return route.fulfill({ json: next });
          }

          if (path === `${base}/projects/${project}/file-audience`) {
            const { fileIds } = request.postDataJSON();
            state.audience.push(fileIds);
            return route.fulfill({
              json: {
                readers: 3,
                files: fileIds.map(fileId =>
                  fileId === budget.id && !state.anaCanOpen
                    ? { fileId, status: 'audience', missing: [{ membershipId: ana.membershipId, name: ana.name }] }
                    : { fileId, status: 'ready' },
                ),
              },
            });
          }
          if (path === `${base}/projects/${project}/files` && method === 'POST') {
            const body = request.postDataJSON();
            state.projectAdds.push(body);
            if (state.projectAddFailures > 0) {
              state.projectAddFailures--;
              return route.fulfill({ status: 503, json: { error: 'projects-unavailable' } });
            }
            return route.fulfill({
              json: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', revisionId: 'dddddddd-dddd-8ddd-8ddd-dddddddddddd' },
            });
          }
          if (path === `${base}/projects/${project}`)
            return route.fulfill({
              json: {
                project: projects[0],
                members: [
                  { membershipId: me, userId: 'ada', name: 'Ada', email: 'ada@example.test', role: 'manager' },
                  { ...ana, userId: 'ana', role: 'member' },
                ],
                files: [
                  {
                    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    title: budget.name,
                    pinned: false,
                    revisionId: 'dddddddd-dddd-8ddd-8ddd-dddddddddddd',
                    filename: budget.name,
                    bytes: 2048,
                    updatedAt: '2026-10-05T09:00:00.000Z',
                    source: { kind: 'file', fileId: budget.id, readAt: '2026-10-05T09:00:00.000Z', available: true },
                  },
                  {
                    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                    title: 'Pricing sheet.txt',
                    pinned: false,
                    revisionId: 'ffffffff-ffff-8fff-8fff-ffffffffffff',
                    filename: 'Pricing sheet.txt',
                    bytes: 1024,
                    updatedAt: '2026-10-01T09:00:00.000Z',
                    source: { kind: 'file', fileId: null, readAt: '2026-10-01T09:00:00.000Z', available: false },
                  },
                ],
              },
            });
          if (path.endsWith('/conversations') && method === 'GET')
            return route.fulfill({ json: { chats: [], nextCursor: null } });
          if (path === `${base}/governance/directory` && method === 'GET')
            return route.fulfill({
              json: {
                members: [
                  { id: me, name: 'Ada', email: 'ada@example.test', image: null },
                  { id: ana.membershipId, name: ana.name, email: ana.email, image: null },
                ],
              },
            });
          if (method === 'GET' && path === '/v1/feature-flags') return route.fulfill({ json: {} });
          throw new Error(`Unexpected API request ${method} ${path}`);
        });
        const origin = server.resolvedUrls.local[0];
        const shot = async name => {
          await page.evaluate(() =>
            Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
          );
          await page.screenshot({ path: `${shots}/promotion-${name}-${label}.png` });
        };
        const fits = async () =>
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            'nothing scrolls sideways',
          );
        try {
          await page.goto(`${origin}${workspace.slug}/files`);
          const knowledge = page.getByRole('dialog', { name: /to Knowledge/ });
          const menu = page.getByRole('button', { name: `More actions for ${notes.name}` });
          await menu.click();
          await page.getByRole('menuitem', { name: 'Add to Knowledge' }).click();
          await knowledge.getByRole('heading', { name: 'Couldn’t check your Knowledge' }).waitFor();
          await knowledge.getByRole('button', { name: 'Check again' }).click();
          await knowledge.getByText('Your Knowledge', { exact: true }).waitFor();
          await knowledge.getByText('Only you. Your chats and agents can search it; other people can’t.').waitFor();
          assert.equal(state.adds.length, 0, 'nothing is added before the person confirms');
          await shot('knowledge-review');
          await fits();
          await knowledge.getByRole('button', { name: 'Add to Knowledge' }).click();
          await knowledge.getByText('Ready. Chats can use it from your Knowledge.').waitFor();
          assert.deepEqual(state.adds, [notes.id]);
          await shot('knowledge-ready');
          await knowledge.getByRole('button', { name: 'Done' }).click();
          await knowledge.waitFor({ state: 'detached' });
          assert.equal(
            await menu.evaluate(element => element === document.activeElement),
            true,
            'closing returns focus to the row menu',
          );

          state.entries.set(
            '77777777-7777-4777-8777-777777777777',
            doc('77777777-7777-4777-8777-777777777777', scan.id, scan.name, 'ocr-unavailable', {
              failure: 'ocr-required',
            }),
          );
          for (const item of [budget, scan]) await page.getByRole('checkbox', { name: `Select ${item.name}` }).click();
          const selected = page.getByRole('toolbar', { name: 'Selected items' });
          if (await selected.getByRole('button', { name: 'Add to Knowledge' }).isVisible())
            await selected.getByRole('button', { name: 'Add to Knowledge' }).click();
          else {
            await selected.getByRole('button', { name: 'Selected actions' }).click();
            await page.getByRole('menuitem', { name: 'Add to Knowledge', exact: true }).click();
          }
          await knowledge.getByRole('heading', { name: 'Add 2 files to Knowledge' }).waitFor();
          await knowledge
            .getByText('This file has scanned pages. TulipFarm can’t read text from images yet.')
            .waitFor();
          await knowledge.getByRole('button', { name: 'Add 1 file' }).click();
          await knowledge.getByRole('button', { name: `Retry extraction for ${budget.name}` }).waitFor();
          assert.deepEqual(state.adds, [notes.id, budget.id], 'a file already in Knowledge is not added twice');
          await shot('knowledge-retry');
          await fits();
          await knowledge.getByRole('button', { name: `Retry extraction for ${budget.name}` }).click();
          await knowledge.getByText('Ready. Chats can use it from your Knowledge.').waitFor();
          assert.equal(state.retries, 1);
          await knowledge.getByRole('button', { name: 'Done' }).click();
          await page
            .getByRole('toolbar', { name: 'Selected items' })
            .getByRole('button', { name: 'Clear selection' })
            .click();

          await page.goto(`${origin}${workspace.slug}/files/${budget.id}`);
          await page.getByRole('button', { name: mobile ? 'File actions' : 'More file actions', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Add to project' }).click();
          const dialog = page.getByRole('dialog', { name: /to a project/ });
          const list = dialog.getByRole('list', { name: 'Projects you manage' });
          await list.getByRole('button', { name: 'Launch' }).waitFor();
          assert.equal(
            await list.getByRole('button').count(),
            1,
            'archived projects and projects the person only reads are not offered',
          );
          await shot('project-choose');
          await list.getByRole('button', { name: 'Launch' }).click();
          await dialog.getByText('Ana Reyes can’t open it.').waitFor();
          await dialog
            .getByText('3 people: everyone in Launch. Project chats use the text in their answers.')
            .waitFor();
          assert.equal(
            await dialog.getByRole('button', { name: '1 file needs attention' }).isDisabled(),
            true,
            'the add stays closed while someone lacks access',
          );
          await shot('project-audience');
          await fits();
          await dialog.getByRole('button', { name: `Grant access to ${budget.name}` }).click();
          const sharing = page.getByRole('dialog', { name: `Share “${budget.name}”` });
          await sharing.getByRole('heading', { name: '1 person in this project can’t open it' }).waitFor();
          await sharing.getByRole('button', { name: 'Let Ana Reyes view it' }).click();
          await sharing.getByText('Everyone in this project can open it now.').waitFor();
          await sharing.getByRole('button', { name: 'Done' }).click();
          await sharing.waitFor({ state: 'detached' });
          await dialog.getByText('Everyone in this project can open it').waitFor();
          assert.equal(state.audience.length, 2, 'granting access rechecks the audience');
          assert.equal(state.projectAdds.length, 0, 'nothing is added before the person confirms');
          await dialog.getByRole('button', { name: 'Add to Launch' }).click();
          await dialog.getByText('Projects are not ready in this workspace yet. Try again in a few minutes.').waitFor();
          await dialog.getByRole('button', { name: 'Try it again' }).click();
          await dialog.getByText('Added to Launch. Project chats can use it now.').waitFor();
          assert.equal(
            state.projectAdds[0].commandId,
            state.projectAdds[1].commandId,
            'a retry reuses the command so the file is not added twice',
          );
          await shot('project-added');
          await dialog.getByRole('link', { name: 'Open Launch' }).click();
          await page.waitForURL(new RegExp(`/projects/${project}`));
          // Cloud 0637f9ee (#743) moved project files from a tab into the Project context aside; pages/projects.tsx:368 words the missing source.
          const files = page
            .getByRole('complementary', { name: 'Project context' })
            .getByRole('list', { name: 'Project files' });
          await files.getByText('Source unavailable').waitFor();
          await files
            .getByText('Source unavailable. Chats don’t use it. Share the file again, or remove it.', { exact: true })
            .waitFor();
          assert.equal(
            await files.getByRole('link', { name: 'Files' }).getAttribute('href'),
            `/${workspace.slug}/files/${budget.id}`,
            'an available source links to its file',
          );
          await shot('project-sources');
          await fits();
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
