import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { taskSummarySchema } from '@tulipfarm/agents/task-contracts';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';
import { libraryItem } from './files-library.fixture.mjs';

const me = membership.membershipId;
const ana = { membershipId: '33333333-3333-4333-8333-333333333333', name: 'Ana Reyes', email: 'ana@example.test' };
const other = '99999999-9999-4999-8999-999999999999';
const file = (id, name, mediaType, role = 'manager', creator = me) =>
  libraryItem({ id, kind: 'file', name, creatorMembershipId: creator, mediaType, size: 2048, role });
const budget = file('44444444-4444-4444-8444-444444444444', 'Q3 budget.csv', 'text/csv');
const notes = file('55555555-5555-4555-8555-555555555555', 'Pricing notes.md', 'text/markdown');
const draft = file('66666666-6666-4666-8666-666666666666', 'Old draft.txt', 'text/plain');
const plan = file('77777777-7777-4777-8777-777777777777', 'Launch plan.txt', 'text/plain', 'viewer', other);
const project = '88888888-8888-4888-8888-888888888888';
const launch = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'Launch planning',
  activityAt: '2026-10-05T09:00:00.000000Z',
  projectId: project,
  projectName: 'Launch',
};
const pricing = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  title: 'Pricing questions',
  activityAt: '2026-10-05T08:00:00.000000Z',
  projectId: null,
  projectName: null,
};
const agentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const summary = (id, status, request) => ({
  id,
  generation: 0,
  status,
  agentId,
  activationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  definitionRevision: 'a'.repeat(64),
  skills: [],
  scope: [],
  parentTaskId: null,
  delegationDepth: 0,
  limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
  flowId: id,
  activeMilliseconds: '0',
  toolCalls: 0,
  createdAt: '2026-10-05T08:00:00.000000Z',
  cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
  activity: [],
  request,
});
const memo = summary('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'waiting-clarification', 'Draft the Q3 pricing memo');
const working = summary('ffffffff-ffff-4fff-8fff-ffffffffffff', 'pending', 'Reconcile supplier invoices');
const taskView = ({ request: _request, ...task }) => taskSummarySchema.parse(task);
const chatView = destination => ({
  id: destination.id,
  title: destination.title,
  titleRevision: 1,
  titleManual: false,
  archived: false,
  activityAt: destination.activityAt,
  createdAt: destination.activityAt,
  projectId: destination.projectId,
});

test(
  'Use in chat places Files references into a chosen chat draft after resolving its audience',
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
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const base = `/v1/workspaces/${workspace.id}`;
        const state = {
          signedIn: 'ada',
          signOutFails: true,
          audienceFailures: 1,
          anaCanOpenBudget: false,
          sends: 0,
          audienceRequests: [],
          destinationQueries: [],
          taskQueries: [],
          taskCommands: [],
        };
        await page.route('**/v1/**', async route => {
          const request = route.request();
          const url = new URL(request.url());
          const path = url.pathname;
          const method = request.method();
          if (path === '/v1/auth/get-session')
            return route.fulfill({
              json:
                state.signedIn === 'ana'
                  ? {
                      session: { id: 'ana-session', userId: 'ana' },
                      user: { id: 'ana', name: ana.name, email: ana.email },
                    }
                  : state.signedIn
                    ? session
                    : null,
            });
          if (
            path === '/v1/auth/options' ||
            ((path === `${base}/recommendations` || path === `${base}/recommendations/events`) && method === 'GET')
          )
            return route.fulfill({ status: 503, json: { error: 'unavailable-in-fixture' } });
          if (path === '/v1/auth/sign-out') {
            if (state.signOutFails)
              return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: 'Sign-out unavailable' } });
            state.signedIn = null;
            return route.fulfill({ json: { success: true } });
          }
          if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
          if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
          if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
          if (path === `/v1/workspaces/${workspace.slug}/last-used` && method === 'PUT')
            return route.fulfill({ status: 204 });
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
          if (path.endsWith('/governance/me'))
            return route.fulfill({
              json:
                state.signedIn === 'ana'
                  ? {
                      ...membership,
                      membershipId: ana.membershipId,
                      role: 'member',
                      capabilities: { manageGovernance: false, canLeave: true },
                    }
                  : membership,
            });
          if (path.endsWith('/credits')) return route.fulfill({ json: credits });
          if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
          if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
          if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
          if (path.endsWith('/projects'))
            return route.fulfill({
              json: [{ id: project, name: 'Launch', instructions: '', revision: 1, archived: false, manager: true }],
            });
          if (path.endsWith('/google-workspace/operations/proposals'))
            return route.fulfill({ json: { proposals: [], nextCursor: null } });
          if (path.endsWith('/workspace-mcp/capabilities'))
            return route.fulfill({ status: 404, json: { error: 'not-found' } });
          if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
          if (path === `${base}/files/usage`)
            return route.fulfill({ json: { usedBytes: 8192, quotaBytes: 1073741824, maxFileBytes: 10485760 } });
          if (path === `${base}/files/library`)
            return route.fulfill({
              json: {
                items: [budget, notes, draft, plan],
                next: null,
                breadcrumbs: [],
                owners: [{ membershipId: other, name: 'Omar Haddad' }],
              },
            });
          if (path === `${base}/files/${plan.id}`) return route.fulfill({ json: plan });
          if (path === `${base}/files/${plan.id}/content`)
            return route.fulfill({
              body: 'Launch on 9 December.',
              headers: { 'content-type': 'application/octet-stream' },
            });
          if (path.endsWith('/recent-use') && method === 'POST') return route.fulfill({ json: { ok: true } });
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
                directGrants: state.anaCanOpenBudget
                  ? [{ subject: { kind: 'individual', id: ana.membershipId }, role: 'viewer' }]
                  : [],
                inherited: [],
                effectiveAudience: [
                  { membershipId: me, role: 'manager' },
                  ...(state.anaCanOpenBudget ? [{ membershipId: ana.membershipId, role: 'viewer' }] : []),
                ],
              },
            });
          if (path === `${base}/files/${budget.id}/sharing` && method === 'PUT') {
            assert.deepEqual(request.postDataJSON(), {
              subject: { kind: 'individual', id: ana.membershipId },
              role: 'viewer',
            });
            state.anaCanOpenBudget = true;
            return route.fulfill({ json: { id: budget.id } });
          }
          if (path === `${base}/conversations/destinations`) {
            const query = url.searchParams.get('query') ?? '';
            state.destinationQueries.push(query);
            return route.fulfill({
              json: { chats: [launch, pricing].filter(chat => chat.title.toLowerCase().includes(query.toLowerCase())) },
            });
          }
          if (path === `${base}/conversations/${launch.id}/file-audience`) {
            const { fileIds } = request.postDataJSON();
            state.audienceRequests.push(fileIds);
            if (state.audienceFailures > 0) {
              state.audienceFailures--;
              return route.fulfill({ status: 503, json: { error: 'conversations-unavailable' } });
            }
            return route.fulfill({
              json: {
                projectId: project,
                files: fileIds.map(fileId =>
                  fileId === plan.id
                    ? { fileId, status: 'audience', missing: null }
                    : fileId === draft.id || (fileId === budget.id && !state.anaCanOpenBudget)
                      ? { fileId, status: 'audience', missing: [{ membershipId: ana.membershipId, name: ana.name }] }
                      : { fileId, status: 'ready' },
                ),
              },
            });
          }
          if (path === `${base}/agent-tasks` && method === 'GET') {
            const search = url.searchParams.get('search') ?? '';
            state.taskQueries.push(search);
            return route.fulfill({
              json: {
                tasks: [memo, working]
                  .filter(task => task.request.toLowerCase().includes(search.toLowerCase()))
                  .map(taskView),
                nextCursor: null,
              },
            });
          }
          if (path === `${base}/github/accounts`) return route.fulfill({ json: { configured: true, accounts: [] } });
          if (path.startsWith(`${base}/github/tasks/`) && path.endsWith('/selection'))
            return route.fulfill({ json: { accountId: null, generation: null, version: 0 } });
          if (path.startsWith(`${base}/github/tasks/`) && path.endsWith('/batches'))
            return route.fulfill({ json: { batches: [] } });
          if (path.startsWith(`${base}/github/tasks/`) && path.endsWith('/investigation'))
            return route.fulfill({ json: { investigation: false, version: 0, selected: null, choices: [] } });
          if (path.startsWith(`${base}/slack/tasks/`)) return route.fulfill({ json: { actions: [] } });
          if (path === `${base}/agents/${agentId}`) return route.fulfill({ status: 404, json: { error: 'not-found' } });
          const agentTask = /\/agent-tasks\/([\w-]+)(\/.*)?$/.exec(path);
          if (agentTask) {
            const [, id, rest = ''] = agentTask;
            const task = [memo, working].find(item => item.id === id);
            if (method === 'POST' && rest === '/continue') {
              state.taskCommands.push(request.postDataJSON());
              return route.fulfill({ json: { id, generation: 0, status: 'pending' } });
            }
            if (method === 'GET' && rest === '/history')
              return route.fulfill({
                json: {
                  messages: [
                    {
                      sequence: 0,
                      generation: 0,
                      role: 'owner',
                      text: task.request,
                      sources: [],
                      createdAt: task.createdAt,
                    },
                    {
                      sequence: 1,
                      generation: 0,
                      role: 'agent',
                      text: 'Which quarter should the memo cover?',
                      sources: [],
                      createdAt: task.createdAt,
                    },
                  ],
                  nextCursor: null,
                },
              });
            if (method === 'GET' && !rest) return route.fulfill({ json: taskView(task) });
            if (method === 'GET' && rest === '/proposals')
              return route.fulfill({ json: { proposals: [], nextCursor: null } });
            return route.fulfill({ status: 404, json: { error: 'not-found' } });
          }
          if (path.endsWith('/conversations') && method === 'GET')
            return route.fulfill({ json: { chats: [launch, pricing].map(chatView), nextCursor: null } });
          const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
          if (conversation) {
            const [, id, rest = ''] = conversation;
            const destination = [launch, pricing].find(chat => chat.id === id);
            if (method === 'PUT' && rest.startsWith('/messages/')) {
              state.sends++;
              return route.fulfill({ status: 500, json: { error: 'unexpected' } });
            }
            if (method === 'GET' && rest === '/messages')
              return route.fulfill({ json: { messages: [], nextBefore: null, hasGitHubProposals: false } });
            if (method === 'GET' && !rest && destination) return route.fulfill({ json: chatView(destination) });
            if (method === 'GET') return route.fulfill({ json: [] });
          }
          if (method === 'GET' && path === '/v1/feature-flags') return route.fulfill({ json: {} });
          throw new Error(`Unexpected API request ${method} ${path}`);
        });
        const origin = server.resolvedUrls.local[0];
        const dialog = page.getByRole('dialog', { name: /in chat/ });
        const shot = async name => {
          await page.evaluate(() =>
            Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
          );
          await page.screenshot({ path: `${shots}/use-in-chat-${name}-${label}.png` });
        };
        const composerChip = name =>
          page.getByRole('form', { name: 'Message composer' }).getByText(name, { exact: true });
        try {
          await page.goto(`${origin}${workspace.slug}/files`);
          const menu = page.getByRole('button', { name: `More actions for ${notes.name}` });
          await menu.click();
          await page.getByRole('menuitem', { name: 'Use in chat' }).click();
          await dialog.getByRole('heading', { name: `Use “${notes.name}” in chat` }).waitFor();
          await dialog
            .getByRole('list', { name: 'Chats you can post in' })
            .getByRole('button', { name: /Pricing questions/ })
            .waitFor();
          await dialog.getByRole('searchbox', { name: 'Search chats' }).fill('launch');
          await page.waitForFunction(
            () => document.querySelectorAll('[aria-label="Chats you can post in"] li').length === 1,
          );
          assert.ok(state.destinationQueries.includes('launch'), 'search reaches the server');
          await dialog.getByRole('searchbox', { name: 'Search chats' }).fill('zzz');
          await dialog.getByText('No chats you can post in match “zzz”.').waitFor();
          await dialog.getByRole('button', { name: 'Clear search' }).click();
          await dialog.getByRole('button', { name: /Launch planning/ }).waitFor();
          await shot('destinations');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
          assert.equal(
            await menu.evaluate(element => element === document.activeElement),
            true,
            'closing returns focus to the row menu',
          );

          await menu.click();
          await page.getByRole('menuitem', { name: 'Use in chat' }).click();
          await dialog.getByRole('button', { name: /Pricing questions/ }).click();
          await page.waitForURL(new RegExp(`/chat/${pricing.id}`));
          await composerChip(notes.name).waitFor();
          assert.equal(state.audienceRequests.length, 0, 'a personal chat needs no audience check');
          assert.match(
            await page.getByRole('textbox', { name: 'Message' }).textContent(),
            new RegExp(notes.name.replaceAll('.', '\\.')),
            'the handed-off inline file is in the draft',
          );
          await page.reload();
          await composerChip(notes.name).waitFor();
          const editor = page.getByRole('textbox', { name: 'Message' });
          await editor.click();
          await editor.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
          await editor.press('Backspace');
          await composerChip(notes.name).waitFor({ state: 'detached' });

          await page.goto(`${origin}${workspace.slug}/files`);
          for (const item of [budget, notes, draft])
            await page.getByRole('checkbox', { name: `Select ${item.name}` }).click();
          const selected = page.getByRole('toolbar', { name: 'Selected items' });
          if (await selected.getByRole('button', { name: 'Use in chat' }).isVisible())
            await selected.getByRole('button', { name: 'Use in chat' }).click();
          else {
            await selected.getByRole('button', { name: 'Selected actions' }).click();
            await page.getByRole('menuitem', { name: 'Use in chat', exact: true }).click();
          }
          await dialog.getByRole('heading', { name: 'Use 3 files in chat' }).waitFor();
          await dialog.getByRole('button', { name: /Launch planning/ }).click();
          await dialog.getByRole('heading', { name: 'Couldn’t check access' }).waitFor();
          await dialog.getByRole('button', { name: 'Check access again' }).click();
          const review = dialog.getByRole('list', { name: 'Files to add' });
          await review.getByText('Ana Reyes can’t open it.').first().waitFor();
          assert.deepEqual(state.audienceRequests.at(-1), [budget.id, notes.id, draft.id]);
          const add = dialog.getByRole('button', { name: '2 files need attention' });
          assert.equal(await add.isDisabled(), true, 'the draft stays closed while someone lacks access');
          await shot('audience');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await dialog.getByRole('button', { name: `Remove ${draft.name}` }).click();
          await review.getByText(draft.name).waitFor({ state: 'detached' });
          await dialog.getByRole('button', { name: '1 file needs attention' }).waitFor();

          await dialog.getByRole('button', { name: `Grant access to ${budget.name}` }).click();
          const sharing = page.getByRole('dialog', { name: `Share “${budget.name}”` });
          await sharing.getByRole('heading', { name: '1 person in this chat can’t open it' }).waitFor();
          await shot('grant');
          await sharing.getByRole('button', { name: 'Let Ana Reyes view it' }).click();
          await sharing.getByText('Everyone in this chat can open it now.').waitFor();
          await sharing.getByRole('button', { name: 'Done' }).click();
          await sharing.waitFor({ state: 'detached' });
          const ready = dialog.getByRole('button', { name: `Add to the draft in “${launch.title}”` });
          await ready.waitFor();
          assert.deepEqual(
            state.audienceRequests.at(-1),
            [budget.id, notes.id],
            'granting access rechecks the remaining files',
          );
          assert.equal(
            await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
            'Access review',
            'focus returns to the review after sharing',
          );
          await ready.click();
          await page.waitForURL(new RegExp(`/chat/${launch.id}`));
          await composerChip(budget.name).waitFor();
          await composerChip(notes.name).waitFor();
          await shot('draft');

          await page.goto(`${origin}${workspace.slug}/files/${plan.id}`);
          if (mobile) {
            await page.getByRole('button', { name: 'File actions', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Use in chat' }).click();
          } else await page.getByRole('button', { name: 'Use in chat' }).click();
          await dialog.getByRole('button', { name: /Launch planning/ }).click();
          await dialog
            .getByText(
              'Some people in this chat can’t open it. Ask someone who manages it to share it, or use a personal chat.',
            )
            .waitFor();
          assert.equal(
            await dialog.getByRole('button', { name: `Grant access to ${plan.name}` }).count(),
            0,
            'only a file manager can grant access',
          );
          assert.equal(await dialog.getByText('Ana Reyes').count(), 0, 'a viewer learns no names');
          await dialog.getByRole('button', { name: 'Use in a new personal chat' }).click();
          await page.waitForURL(url => url.pathname === `/${workspace.slug}` && !url.search.includes('project'));
          await composerChip(plan.name).waitFor();
          await shot('private');
          assert.equal(state.sends, 0, 'Use in chat never sends a message');

          await page.goto(`${origin}${workspace.slug}/files`);
          await page.getByRole('button', { name: `More actions for ${notes.name}` }).click();
          await page.getByRole('menuitem', { name: 'Use in chat' }).click();
          const tasks = dialog.getByRole('list', { name: 'Agent tasks you can message' });
          await tasks.getByRole('button', { name: /Draft the Q3 pricing memo/ }).waitFor();
          assert.equal(await tasks.getByRole('button').count(), 1, 'a task that is still working takes no message');
          await tasks.getByText('Needs your answer').waitFor();
          await dialog.getByRole('searchbox', { name: 'Search chats' }).fill('zzz');
          await dialog.getByText('No agent tasks you can message match “zzz”.').waitFor();
          assert.ok(state.taskQueries.includes('zzz'), 'task search reaches the server');
          await dialog.getByRole('button', { name: 'Clear search' }).click();
          await shot('task-destination');
          await tasks.getByRole('button', { name: /Draft the Q3 pricing memo/ }).click();
          await page.waitForURL(new RegExp(`/agent-tasks/${memo.id}$`));
          const taskFiles = page.getByRole('region', { name: 'Files to read' });
          await taskFiles.getByText(notes.name, { exact: true }).waitFor();
          await page.reload();
          await taskFiles.getByText(notes.name, { exact: true }).waitFor();
          await shot('task-draft');
          assert.equal(state.taskCommands.length, 0, 'choosing a task sends nothing');
          await page.getByLabel('Your answer or continuation').fill('Cover Q3 only.');
          await page.getByRole('button', { name: 'Send answer' }).click();
          await page.waitForFunction(() => !document.querySelector('[aria-labelledby="task-files-heading"]'));
          assert.deepEqual(
            state.taskCommands.map(command => [command.text, command.sources]),
            [['Cover Q3 only.', [{ kind: 'file', fileId: notes.id }]]],
          );
          assert.deepEqual(
            await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('task:'))),
            [],
            'a sent message clears the task draft',
          );
          await page.goto(`${origin}${workspace.slug}`);

          state.signedIn = 'ana';
          await page.reload();
          await page.getByRole('textbox', { name: 'Message' }).waitFor();
          assert.equal(
            await composerChip(plan.name).count(),
            0,
            'another person signed in on this tab does not see Ada’s draft references',
          );
          state.signedIn = 'ada';
          await page.reload();
          await composerChip(plan.name).waitFor();
          await page.evaluate(() => sessionStorage.setItem('unrelated-session-key', 'keep'));
          const draftsBeforeLogout = await page.evaluate(() =>
            Object.fromEntries(
              Object.entries(sessionStorage).filter(([key]) => key.startsWith('tulipfarm:chat-draft-files:')),
            ),
          );
          assert.ok(Object.keys(draftsBeforeLogout).length > 0);
          await page.goto(`${origin}logout`);
          await page.getByRole('heading', { name: 'Could not log out' }).waitFor();
          assert.equal(new URL(page.url()).pathname, '/logout', 'a failed logout must not redirect');
          assert.deepEqual(
            await page.evaluate(() =>
              Object.fromEntries(
                Object.entries(sessionStorage).filter(([key]) => key.startsWith('tulipfarm:chat-draft-files:')),
              ),
            ),
            draftsBeforeLogout,
          );
          state.signOutFails = false;
          await page.getByRole('button', { name: 'Try again', exact: true }).click();
          await page.waitForURL(url => url.pathname === '/login');
          assert.deepEqual(
            await page.evaluate(() =>
              Object.keys(sessionStorage).filter(key => key.startsWith('tulipfarm:chat-draft-files:')),
            ),
            [],
            'signing out clears unsent draft references',
          );
          assert.equal(await page.evaluate(() => sessionStorage.getItem('unrelated-session-key')), 'keep');
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
