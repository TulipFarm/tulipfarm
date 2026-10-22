import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const scope = name => `https://www.googleapis.com/auth/${name}`;
const binding = { integrationId: '0a000000-0000-4000-8000-00000000000a', accountId: 'google-a', generation: 3 };
const folderType = 'application/vnd.google-apps.folder';
const doc = {
  id: 'docLaunch',
  name: 'Launch plan',
  mimeType: 'application/vnd.google-apps.document',
  modifiedTime: '2026-10-05T08:30:00.000Z',
  owners: [{ me: true, displayName: 'Ada' }],
  webViewLink: 'https://docs.google.com/document/d/docLaunch/edit',
};
const sheet = {
  id: 'sheetStock',
  name: 'Launch stock',
  mimeType: 'application/vnd.google-apps.spreadsheet',
  modifiedTime: '2026-10-04T08:30:00.000Z',
  owners: [{ me: true }],
};
const form = {
  id: 'formLaunch',
  name: 'Launch survey',
  mimeType: 'application/vnd.google-apps.form',
  owners: [{ me: true }],
};
const folder = { id: 'folderLaunch', name: 'Launch assets', mimeType: folderType, owners: [{ me: true }] };
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
const agentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// Task summaries carry delegation fields since cloud aed31db6 (#803), packages/agents/src/task-contracts.ts:52.
const memo = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  generation: 0,
  status: 'waiting-clarification',
  agentId,
  activationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  definitionRevision: 'a'.repeat(64),
  parentTaskId: null,
  delegationDepth: 0,
  skills: [],
  scope: [],
  limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
  flowId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  activeMilliseconds: '0',
  toolCalls: 0,
  createdAt: '2026-10-05T08:00:00.000000Z',
  cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
  activity: [],
};
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

test(
  'Google Drive files enter chat through @ search and Use in chat, only into personal chats',
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
        const google = `${base}/google-workspace`;
        const state = {
          driveSearches: [],
          driveFails: 0,
          sends: [],
          history: new Map(),
          created: new Map(),
          taskCommands: [],
          taskIntegration: 'connected',
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
          if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
          if (path.endsWith('/credits')) return route.fulfill({ json: credits });
          if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
          if (path === '/v1/google-workspace/availability') return route.fulfill({ json: { configured: true } });
          if (path === google)
            return route.fulfill({
              json: { status: 'connected', ...binding, email: 'ada@example.test', scopes: [scope('drive')] },
            });
          if (path === `${google}/operations/files/list`) {
            const body = request.postDataJSON();
            assert.deepEqual(body.expectedIntegration, binding);
            if (body.name !== undefined) {
              state.driveSearches.push(body.name);
              assert.equal(body.pageSize, 5, 'Drive search is bounded');
              if (state.driveFails > 0) {
                state.driveFails--;
                return route.fulfill({ status: 503, json: { error: 'provider-unavailable' } });
              }
              return route.fulfill({
                json: {
                  files: [doc, sheet, form, folder].filter(item =>
                    item.name.toLowerCase().includes(body.name.toLowerCase()),
                  ),
                  incompleteSearch: false,
                },
              });
            }
            return route.fulfill({ json: { files: [folder, doc, sheet, form], incompleteSearch: false } });
          }
          if (path === `${google}/operations/read`)
            return route.fulfill({ json: { untrusted: true, data: { items: [] } } });
          if (path === `${google}/operations/files/metadata`)
            return route.fulfill({
              json:
                request.postDataJSON().fileId === doc.id ? doc : { id: 'root', name: 'My Drive', mimeType: folderType },
            });
          if (path === `${google}/operations/files/content`)
            return route.fulfill({ body: pdf, headers: { 'content-type': 'application/pdf' } });
          if (path.endsWith('/projects'))
            return route.fulfill({
              json: [{ id: project, name: 'Launch', instructions: '', revision: 1, archived: false, manager: true }],
            });
          if (path.endsWith('/google-workspace/operations/proposals'))
            return route.fulfill({ json: { proposals: [], nextCursor: null } });
          if (path.endsWith('/workspace-mcp/capabilities'))
            return route.fulfill({ status: 404, json: { error: 'not-found' } });
          if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
          if (path === `${base}/files/suggestions`) return route.fulfill({ json: { items: [], next: null } });
          if (path === `${base}/files` && method === 'GET') return route.fulfill({ json: { items: [], next: null } });
          if (path === `${base}/files/usage`)
            return route.fulfill({ json: { usedBytes: 0, quotaBytes: 1073741824, maxFileBytes: 10485760 } });
          if (path === `${base}/conversations/destinations`)
            return route.fulfill({ json: { chats: [launch, pricing] } });
          if (path.endsWith('/conversations') && method === 'GET')
            return route.fulfill({
              json: { chats: [launch, pricing, ...state.created.values()].map(chatView), nextCursor: null },
            });
          const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
          if (conversation) {
            const [, id, rest = ''] = conversation;
            const destination = [launch, pricing, ...state.created.values()].find(chat => chat.id === id);
            if (method === 'PUT' && !rest) {
              const created = {
                id,
                title: 'New chat',
                activityAt: '2026-10-05T10:00:00.000000Z',
                projectId: request.postDataJSON().projectId ?? null,
              };
              state.created.set(id, created);
              return route.fulfill({ json: { id } });
            }
            if (method === 'PUT' && rest.startsWith('/messages/')) {
              const body = request.postDataJSON();
              state.sends.push({ chat: id, body });
              if (destination?.projectId)
                return route.fulfill({ status: 409, json: { error: 'google-file-audience' } });
              const messageId = rest.split('/').at(-1);
              const parts = body.parts.map(part =>
                part.kind === 'google-file'
                  ? { kind: part.kind, fileId: part.fileId, name: part.name, mimeType: part.mimeType }
                  : part,
              );
              state.history.set(id, [
                {
                  id: messageId,
                  sequence: 1,
                  author: 'human',
                  createdAt: '2026-10-05T10:00:01.000Z',
                  parts,
                  turn: { id: '99999999-9999-4999-8999-999999999999', status: 'completed', generation: 0 },
                  tools: [],
                  calendarResults: [],
                },
              ]);
              return route.fulfill({
                json: { messageId, turnId: '99999999-9999-4999-8999-999999999999', sequence: 1 },
              });
            }
            if (method === 'GET' && rest === '/messages')
              return route.fulfill({
                json: { messages: state.history.get(id) ?? [], nextBefore: null, hasGitHubProposals: false },
              });
            if (method === 'GET' && !rest && destination) return route.fulfill({ json: chatView(destination) });
            if (method === 'GET') return route.fulfill({ json: [] });
          }
          if (path === `${base}/agent-tasks` && method === 'GET')
            return route.fulfill({ json: { tasks: [memo], nextCursor: null } });
          if (path === `${base}/github/accounts`) return route.fulfill({ json: { configured: true, accounts: [] } });
          if (path.startsWith(`${base}/github/tasks/`) && path.endsWith('/selection'))
            return route.fulfill({ json: { accountId: null, generation: null, version: 0 } });
          if (path.startsWith(`${base}/github/tasks/`) && path.endsWith('/batches'))
            return route.fulfill({ json: { batches: [] } });
          // Task pages read GitHub investigation access since cloud 6a97dbef (#1044); answered as files-use-in-chat does.
          if (path.startsWith(`${base}/github/tasks/`) && path.endsWith('/investigation'))
            return route.fulfill({ json: { investigation: false, version: 0, selected: null, choices: [] } });
          if (path.startsWith(`${base}/slack/tasks/`)) return route.fulfill({ json: { actions: [] } });
          if (path === `${base}/agents/${agentId}`) return route.fulfill({ status: 404, json: { error: 'not-found' } });
          if (path === `${base}/agent-tasks/${memo.id}/continue` && method === 'POST') {
            state.taskCommands.push(request.postDataJSON());
            if (state.taskIntegration !== 'connected')
              return route.fulfill({ status: 409, json: { error: 'google-integration-required' } });
            return route.fulfill({ json: { id: memo.id, generation: 0, status: 'pending' } });
          }
          if (path === `${base}/agent-tasks/${memo.id}/history`)
            return route.fulfill({
              json: {
                messages: [
                  {
                    sequence: 0,
                    generation: 0,
                    role: 'owner',
                    text: 'Draft the launch checklist',
                    sources: [],
                    createdAt: memo.createdAt,
                  },
                  {
                    sequence: 1,
                    generation: 0,
                    role: 'agent',
                    text: 'Which plan should it follow?',
                    sources: [],
                    createdAt: memo.createdAt,
                  },
                ],
                nextCursor: null,
              },
            });
          if (path === `${base}/agent-tasks/${memo.id}/proposals`)
            return route.fulfill({ json: { proposals: [], nextCursor: null } });
          if (path === `${base}/agent-tasks/${memo.id}`) return route.fulfill({ json: memo });
          if (method === 'GET' && path === '/v1/feature-flags') return route.fulfill({ json: {} });
          if (path.endsWith('/last-used')) return route.fulfill({ status: 204 });
          if (path.endsWith('/bud'))
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
          if (path.endsWith('/recommendations') || path.endsWith('/recommendations/events'))
            return route.fulfill({ status: 503, json: { error: 'recommendations-unavailable' } });
          if (path.endsWith('/workspace-mcp/capabilities'))
            return route.fulfill({ status: 404, json: { error: 'not-found' } });
          if (method === 'GET' && path === `${base}/github/accounts`)
            return route.fulfill({ json: { configured: false, accounts: [] } });
          if (method === 'GET' && path === `${base}/atlassian/accounts`)
            return route.fulfill({ json: { accounts: [], providers: [] } });
          if (method === 'GET' && path === `${base}/integrations`) return route.fulfill({ json: { integrations: [] } });
          if (method === 'GET' && path === `${base}/slack/status`)
            return route.fulfill({
              json: { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] },
            });
          throw new Error(`Unexpected API request ${method} ${path}`);
        });
        const origin = server.resolvedUrls.local[0];
        const shot = async name => {
          await page.evaluate(() =>
            Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
          );
          await page.screenshot({ path: `${shots}/google-chat-${name}-${label}.png` });
        };
        const composer = page.getByRole('form', { name: 'Message composer' });
        const message = page.getByRole('textbox', { name: 'Message' });
        const dialog = page.getByRole('dialog', { name: /in chat/ });
        try {
          await page.goto(`${origin}${workspace.slug}`);
          await message.click();
          await message.pressSequentially('@laun');
          const list = page.getByRole('listbox', { name: 'Files you can add' });
          await list.getByRole('option').first().waitFor();
          assert.deepEqual(
            await list
              .getByRole('option')
              .allInnerTexts()
              .then(texts => texts.map(text => text.split('\n')[0])),
            ['Launch plan', 'Launch stock'],
            'folders and forms are not offered',
          );
          assert.equal(
            await message.evaluate(element => element === document.activeElement),
            true,
            'the message field keeps focus',
          );
          await shot('picker');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await message.press('Enter');
          await list.waitFor({ state: 'detached' });
          await composer.getByText(doc.name, { exact: true }).waitFor();
          await page
            .getByText(
              'The assistant reads this file from Google Drive through your Google account for your requests in this chat, using your current access.',
            )
            .waitFor();
          assert.ok(
            state.driveSearches.every(query => query.length > 0 && query.length <= 80),
            'Drive is searched only for typed names',
          );

          await page.goto(`${origin}${workspace.slug}?project=${project}`);
          const blocked = page.getByRole('alert').filter({ hasText: 'Google Drive files work only in personal chats' });
          await blocked.waitFor();
          assert.equal(
            await composer.getByRole('button', { name: 'Send message' }).isDisabled(),
            true,
            'a project draft cannot send a Google reference',
          );
          await shot('project-blocked');
          await blocked.getByRole('button', { name: 'Start a personal chat instead' }).click();
          await page.waitForURL(url => !url.search.includes('project'));
          await blocked.waitFor({ state: 'detached' });
          await composer.getByText(doc.name, { exact: true }).waitFor();
          await message.click();
          await message.press('End');
          await message.press('Enter');
          await page.waitForURL(/\/chat\//);
          // Cloud 505e926b (#833) opens the new chat before the send settles (private-conversations.tsx:326-333), so read the request once history shows it.
          const messages = page.getByRole('list', { name: 'Messages' });
          await messages.getByRole('button', { name: `Inspect ${doc.name}` }).waitFor();
          const sent = state.sends.at(-1);
          assert.deepEqual(sent.body.parts.at(-1), {
            kind: 'google-file',
            fileId: doc.id,
            name: doc.name,
            mimeType: doc.mimeType,
            expectedIntegration: binding,
          });
          await shot('history');

          await page.goto(`${origin}${workspace.slug}/files?section=google`);
          await page.getByRole('button', { name: `More actions for ${doc.name}` }).click();
          await page.getByRole('menuitem', { name: 'Use in chat' }).click();
          await dialog.getByRole('heading', { name: `Use “${doc.name}” in chat` }).waitFor();
          await dialog.getByText('it can’t be used in project chats').waitFor();
          const chats = dialog.getByRole('list', { name: 'Chats you can post in' });
          await chats.getByRole('button', { name: /Pricing questions/ }).waitFor();
          assert.equal(
            await chats.getByRole('button', { name: /Launch planning/ }).count(),
            0,
            'project chats are not offered',
          );
          await shot('use-in-chat');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          const tasks = dialog.getByRole('list', { name: 'Agent tasks you can message' });
          await tasks.getByRole('button', { name: /Draft the launch checklist/ }).waitFor();
          await dialog.getByText('through your Google account when it works on your next message').waitFor();
          await chats.getByRole('button', { name: /Pricing questions/ }).click();
          await page.waitForURL(new RegExp(`/chat/${pricing.id}`));
          await message.getByText(doc.name, { exact: true }).waitFor();
          assert.equal(
            await page.getByRole('alert').filter({ hasText: 'Google Drive files work only in personal chats' }).count(),
            0,
          );

          await page.goto(`${origin}${workspace.slug}/chat/${launch.id}`);
          await page.getByRole('button', { name: 'Send message' }).waitFor();
          assert.equal(await message.getByText(doc.name, { exact: true }).count(), 0, 'drafts stay with their chat');
          await page.goto(`${origin}${workspace.slug}/files/google/${doc.id}`);
          if (mobile) {
            await page.getByRole('button', { name: 'File actions', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Use in chat' }).click();
          } else await page.getByRole('button', { name: 'Use in chat' }).click();
          await dialog.getByRole('button', { name: 'New personal chat' }).click();
          await page.waitForURL(url => url.pathname === `/${workspace.slug}`);
          await message.getByText(doc.name, { exact: true }).waitFor();

          await page.goto(`${origin}${workspace.slug}/files?section=google`);
          await page.getByRole('button', { name: `More actions for ${doc.name}` }).click();
          await page.getByRole('menuitem', { name: 'Use in chat' }).click();
          await dialog
            .getByRole('list', { name: 'Agent tasks you can message' })
            .getByRole('button', { name: /Draft the launch checklist/ })
            .click();
          await page.waitForURL(new RegExp(`/agent-tasks/${memo.id}$`));
          const taskFiles = page.getByRole('region', { name: 'Files to read' });
          await taskFiles.getByText(doc.name, { exact: true }).waitFor();
          await taskFiles.getByText('Google Drive', { exact: true }).waitFor();
          await taskFiles.getByText('the task pauses until you add the file again').waitFor();
          await shot('task-draft');
          assert.equal(state.taskCommands.length, 0, 'choosing a task sends nothing');
          state.taskIntegration = 'disconnected';
          await page.getByLabel('Your answer or continuation').fill('Follow the launch plan.');
          await page.getByRole('button', { name: 'Send answer' }).click();
          await page
            .getByRole('alert')
            .filter({ hasText: 'Google Drive files need your Google integration with Drive access.' })
            .waitFor();
          await taskFiles.getByText(doc.name, { exact: true }).waitFor();
          await shot('task-integration-required');
          state.taskIntegration = 'connected';
          await page.getByRole('button', { name: 'Send answer' }).click();
          await page.waitForFunction(() => !document.querySelector('[aria-labelledby="task-files-heading"]'));
          assert.deepEqual(
            state.taskCommands.map(command => command.sources),
            [[{ kind: 'drive-file', fileId: doc.id }], [{ kind: 'drive-file', fileId: doc.id }]],
            'the task command names the Drive file by id; the server binds the integration',
          );
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
