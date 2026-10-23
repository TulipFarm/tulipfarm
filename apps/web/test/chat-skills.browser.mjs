import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const qualify = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: '3f2a9c1b'.padEnd(64, 'd'),
  name: 'Qualify lead',
};
const tradeShow = {
  id: 'abababab-abab-4bab-8bab-abababababab',
  revision: '9b1d2e7a'.padEnd(64, 'c'),
  name: 'Qualify inbound leads from the spring trade show and route enterprise accounts to sales',
};
const revenue = {
  id: '44444444-4444-4444-8444-444444444444',
  kind: 'file',
  name: 'Q3 revenue summary.pdf',
  parentId: null,
  creatorMembershipId: membership.membershipId,
  mediaType: 'application/pdf',
  size: 428_000,
  trashed: false,
  role: 'manager',
};
const failedChat = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const projectChat = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const archivedProjectChat = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const projectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const archivedProjectId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const projects = [
  { id: projectId, name: 'Launch Day', instructions: '', revision: 1, archived: false, manager: true },
  { id: archivedProjectId, name: 'Old Launch', instructions: '', revision: 1, archived: true, manager: true },
];
const createdAt = '2026-10-05T10:00:00.000Z';
const chatOf = (id, project = null) => ({
  id,
  title: 'New chat',
  titleRevision: 0,
  titleManual: false,
  archived: false,
  activityAt: createdAt,
  createdAt,
  projectId: project,
});
const named = part => ({ ...part, name: [qualify, tradeShow].find(skill => skill.id === part.skillId).name });
const human = (parts, turn) => ({
  id: crypto.randomUUID(),
  sequence: 1,
  author: 'human',
  createdAt,
  parts,
  turn: { id: crypto.randomUUID(), generation: 0, ...turn },
  tools: [],
  calendarResults: [],
});

test('/ stages one reviewed skill, send it, and show which skill the reply used', { timeout: 180000 }, async () => {
  const { workspace, session } = createWorkspaceFixture();
  const base = `/v1/workspaces/${workspace.id}`;
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const browser = await chromium.launch();
  const shots = process.env.CHAT_SKILL_SCREENSHOTS;
  try {
    for (const mobile of [false, true]) {
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
      const unexpected = [];
      const loads = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('load', () => loads.push(page.url()));
      const skillSearches = [];
      let skillGate = null;
      let skills = 'listed';
      const sends = [];
      let sendGate = null;
      let sendStatus = 200;
      const chats = new Map([
        [
          failedChat,
          {
            chat: chatOf(failedChat),
            messages: [
              human(
                [
                  named({ kind: 'skill', skillId: qualify.id, revision: qualify.revision }),
                  { kind: 'text', text: 'Acme Corp wants a demo.' },
                ],
                { status: 'failed', errorCode: 'skill-unavailable' },
              ),
            ],
          },
        ],
        [projectChat, { chat: chatOf(projectChat, projectId), messages: [] }],
        [archivedProjectChat, { chat: chatOf(archivedProjectChat, archivedProjectId), messages: [] }],
      ]);
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
        if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
        if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
        if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
        if (path === `${base}/governance/me`) return route.fulfill({ json: membership });
        if (path === `${base}/credits`) return route.fulfill({ json: credits });
        if (path === `${base}/model-catalog`) return route.fulfill({ json: chatCatalog });
        if (path === '/v1/google-workspace/availability') return route.fulfill({ json: { configured: false } });
        if (path === `${base}/google-workspace`) return route.fulfill({ json: { status: 'disconnected' } });
        if (path === `${base}/projects`) return route.fulfill({ json: projects });
        if (path === `${base}/google-workspace/operations/proposals`)
          return route.fulfill({ json: { proposals: [], nextCursor: null } });
        if (path === `${base}/workspace-mcp/capabilities`)
          return route.fulfill({ status: 404, json: { error: 'not-found' } });
        if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
        if (path === `${base}/skills` && method === 'GET') {
          skillSearches.push(url.search);
          if (skillGate) await skillGate.promise;
          if (skills === 'failing')
            return route.fulfill({ status: 503, json: { error: 'skill-operation-unavailable' } });
          const query = (url.searchParams.get('search') ?? '').toLowerCase();
          const matching = list =>
            skills === 'none' ? [] : list.filter(skill => skill.name.toLowerCase().includes(query));
          return route.fulfill({ json: { workspace: matching([qualify, tradeShow]), nextCursor: null } });
        }
        if (path === `${base}/files` && method === 'GET')
          return route.fulfill({
            json: {
              items: [revenue].filter(item =>
                item.name.toLowerCase().includes((url.searchParams.get('query') ?? '').toLowerCase()),
              ),
              next: null,
            },
          });
        if (path === `${base}/conversations` && method === 'GET')
          return route.fulfill({ json: { chats: [...chats.values()].map(entry => entry.chat), nextCursor: null } });
        const conversation = new RegExp(`^${base}/conversations/([\\w-]+)(/.*)?$`).exec(path);
        if (conversation) {
          const [, id, rest = ''] = conversation;
          if (method === 'PUT' && !rest) {
            chats.set(id, { chat: chatOf(id), messages: [] });
            return route.fulfill({ json: { id } });
          }
          const stored = chats.get(id);
          if (stored && method === 'PUT' && rest.startsWith('/messages/')) {
            const body = request.postDataJSON();
            sends.push(body);
            if (sendGate) await sendGate.promise;
            if (sendStatus !== 200) return route.fulfill({ status: sendStatus, json: { error: 'skill-unavailable' } });
            const sent = {
              ...human(
                body.parts.map(part => (part.kind === 'skill' ? named(part) : part)),
                { status: 'completed' },
              ),
              id: rest.split('/').at(-1),
              sequence: stored.messages.length + 1,
            };
            const used = sent.parts.find(part => part.kind === 'skill');
            const reply = {
              id: crypto.randomUUID(),
              sequence: sent.sequence + 1,
              author: 'assistant',
              createdAt,
              parts: [
                ...(used ? [{ ...used, kind: 'skill-use' }] : []),
                { kind: 'text', text: 'How many people work at Acme Corp?' },
              ],
              turn: null,
              tools: [],
              calendarResults: [],
            };
            stored.messages.push(sent, reply);
            return route.fulfill({ json: { messageId: sent.id, turnId: sent.turn.id, sequence: sent.sequence } });
          }
          if (stored && method === 'GET' && rest === '/messages')
            return route.fulfill({
              json: { messages: stored.messages, nextBefore: null, hasGitHubProposals: false },
            });
          if (stored && method === 'GET' && !rest) return route.fulfill({ json: stored.chat });
        }
        unexpected.push(`${method} ${path}${url.search}`);
        return route.fulfill({ status: 501, json: { error: 'unexpected-test-request' } });
      });
      try {
        const origin = server.resolvedUrls.local[0];
        const message = page.getByRole('textbox', { name: 'Message' });
        const skillList = page.getByRole('listbox', { name: 'Skills you can use' });
        const options = skillList.getByRole('option');
        const searched = search =>
          page.waitForResponse(
            response =>
              new URL(response.url()).pathname === `${base}/skills` && new URL(response.url()).search === search,
          );
        const fitsWidth = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

        await page.goto(`${origin}${workspace.slug}`);
        await message.click();
        skillGate = Promise.withResolvers();
        skills = 'failing';
        const firstSearch = page.waitForRequest(request => new URL(request.url()).pathname === `${base}/skills`);
        await message.pressSequentially('/');
        await skillList.waitFor({ state: 'attached' });
        assert.equal(await message.getAttribute('aria-controls'), await skillList.getAttribute('id'));
        assert.equal(await message.getAttribute('aria-autocomplete'), 'list');
        await page.getByRole('status').filter({ hasText: 'Loading skills…' }).waitFor();
        await firstSearch;
        skillGate.resolve();
        skillGate = null;
        await page
          .getByRole('alert')
          .filter({ hasText: 'Couldn’t load skills. Check your connection, then retry.' })
          .waitFor();
        assert.equal(await message.textContent(), '/', 'a failed load keeps the typed trigger');
        skills = 'listed';
        await page.getByRole('button', { name: 'Retry skills' }).click();
        await page
          .getByRole('status')
          .filter({ hasText: '2 skills you can use. Use Up and Down to choose, Enter to use, Escape to close.' })
          .waitFor();
        assert.deepEqual(
          await options.allInnerTexts(),
          [`${tradeShow.name}\nWorkspace skill · Version 9b1d2e7a`, 'Qualify lead\nWorkspace skill · Version 3f2a9c1b'],
          'only workspace skills are suggested',
        );
        assert.equal(skillSearches.at(-1), '?view=reviewed&limit=8');
        assert.equal(
          await message.evaluate(element => element === document.activeElement),
          true,
          'retrying keeps focus in the message field',
        );

        skills = 'none';
        await message.press('Escape');
        await skillList.waitFor({ state: 'detached' });
        await message.press('Backspace');
        await message.pressSequentially('/');
        await page
          .getByRole('status')
          .filter({ hasText: 'No reviewed skills yet. An admin reviews skills in Skills.' })
          .waitFor();
        skills = 'listed';
        const noMatch = searched('?view=reviewed&search=zzz&limit=8');
        await message.pressSequentially('zzz');
        await noMatch;
        await page.getByRole('status').filter({ hasText: 'No skills match “zzz”.' }).waitFor();
        const typed = skillSearches.length;
        for (let index = 0; index < 3; index++) await message.press('Backspace');
        const qualifying = searched('?view=reviewed&search=qual&limit=8');
        await message.pressSequentially('qual');
        await qualifying;
        await page.getByRole('status').filter({ hasText: '2 skills you can use.' }).waitFor();
        assert.deepEqual(
          skillSearches.slice(typed),
          ['?view=reviewed&search=qual&limit=8'],
          'typing debounces to one search, so no later response resets the active option',
        );
        assert.equal(await message.getAttribute('aria-activedescendant'), await options.nth(0).getAttribute('id'));
        await message.press('ArrowDown');
        assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true');
        if (shots)
          await page.screenshot({
            path: `${shots}/chat-skill-picker-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
          });
        assert.equal(await fitsWidth(), true);
        await message.press('Enter');
        await skillList.waitFor({ state: 'detached' });
        const staged = page
          .getByRole('form', { name: 'Message composer' })
          .getByText('Qualify lead · Version 3f2a9c1b', { exact: true });
        await staged.waitFor();
        assert.equal(await staged.getAttribute('title'), 'Qualify lead');
        assert.equal(await message.textContent(), '', 'choosing a skill removes the typed /qual');
        await page.getByText('The assistant follows this skill for this message only.').waitFor();
        assert.equal(
          await message.evaluate(element => element === document.activeElement),
          true,
          'the message field keeps focus',
        );

        await message.pressSequentially('1 / 2');
        assert.equal(await message.textContent(), '1 / 2');
        assert.equal(await skillList.count(), 0, 'a slash between words is text, not a trigger');
        await message.fill('');
        await message.pressSequentially('Acme Corp wants a demo.');
        if (shots)
          await page.screenshot({
            path: `${shots}/chat-skill-staged-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
          });
        assert.equal(await fitsWidth(), true);

        sendStatus = 409;
        await message.press('Enter');
        await page
          .getByRole('alert')
          .filter({
            hasText:
              'This skill is no longer available. Remove it or choose another skill, then send again. Your draft is kept.',
          })
          .waitFor();
        assert.deepEqual(sends.at(-1).parts, [
          { kind: 'skill', skillId: qualify.id, revision: qualify.revision },
          { kind: 'text', text: 'Acme Corp wants a demo.' },
        ]);
        assert.equal(await message.textContent(), 'Acme Corp wants a demo.', 'a rejected send keeps the draft');
        await staged.waitFor();
        await page.getByRole('button', { name: 'Refresh before editing' }).click();
        await page.getByRole('button', { name: 'Review retained input' }).click();
        await page.getByRole('button', { name: 'Remove skill Qualify lead' }).waitFor();

        sendStatus = 200;
        sendGate = Promise.withResolvers();
        await message.click();
        await message.press('Enter');
        const messages = page.getByRole('list', { name: 'Messages' });
        const sentChip = messages.getByRole('img', { name: 'Skill Qualify lead, version 3f2a9c1b' });
        await sentChip.waitFor();
        assert.equal(
          await sentChip.textContent(),
          'Qualify lead · Version 3f2a9c1b',
          'the pending message shows the chosen skill',
        );
        sendGate.resolve();
        sendGate = null;
        await page.waitForURL(/\/chat\//);
        assert.deepEqual(sends.at(-1).parts, [
          { kind: 'skill', skillId: qualify.id, revision: qualify.revision },
          { kind: 'text', text: 'Acme Corp wants a demo.' },
        ]);
        await messages.getByText('Used skill Qualify lead · Version 3f2a9c1b', { exact: true }).waitFor();
        await sentChip.waitFor();
        await messages.getByText('How many people work at Acme Corp?').waitFor();
        if (shots)
          await page.screenshot({
            path: `${shots}/chat-skill-history-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
          });

        await page.goto(`${origin}${workspace.slug}/chat/${failedChat}`);
        await page
          .getByRole('alert')
          .filter({
            hasText:
              '“Qualify lead” is no longer available, so this reply didn’t run. Ask a workspace admin to enable it, then retry, or send a new message without it.',
          })
          .waitFor();
        await page.getByRole('button', { name: 'Retry reply' }).waitFor();
        await page.getByRole('button', { name: 'Cancel reply' }).waitFor();
        await messages.getByRole('img', { name: 'Skill Qualify lead, version 3f2a9c1b' }).waitFor();
        assert.equal(
          await page.getByRole('button', { name: 'Chat help' }).count(),
          0,
          'the composer has no chat help button',
        );

        const useSkill = () => message.pressSequentially('/');
        await message.fill('');
        await useSkill();
        await skillList.waitFor();
        assert.equal(await message.textContent(), '/');
        await options.first().waitFor();
        await message.press('Enter');
        const longChip = page
          .getByRole('form', { name: 'Message composer' })
          .getByText(`${tradeShow.name} · Version 9b1d2e7a`, { exact: true });
        await longChip.waitFor();
        assert.equal(await fitsWidth(), true, 'a long skill name wraps inside the composer');
        if (shots)
          await page.screenshot({ path: `${shots}/chat-skill-long-${mobile ? 'mobile-dark' : 'desktop-light'}.png` });
        await page.getByRole('button', { name: `Remove skill ${tradeShow.name}` }).click();
        await longChip.waitFor({ state: 'detached' });
        assert.equal(
          await message.evaluate(element => element === document.activeElement),
          true,
          'removing the chip returns focus to the message field',
        );
        await useSkill();
        await options.first().waitFor();
        await message.press('Enter');
        await longChip.waitFor();
        await message.press('Enter');
        await messages.getByRole('img', { name: `Skill ${tradeShow.name}, version 9b1d2e7a` }).waitFor();
        assert.deepEqual(
          sends.at(-1).parts,
          [{ kind: 'skill', skillId: tradeShow.id, revision: tradeShow.revision }],
          'a skill alone is a message',
        );
        await messages.getByText(`Used skill ${tradeShow.name} · Version 9b1d2e7a`, { exact: true }).waitFor();
        assert.equal(await longChip.count(), 0, 'an accepted send clears the staged skill');

        await message.click();
        await message.pressSequentially('Compare @q');
        const fileList = page.getByRole('listbox', { name: 'Files you can add' });
        await fileList.getByRole('option', { name: /Q3 revenue summary\.pdf/ }).waitFor();
        await message.pressSequentially(' /qual');
        await skillList.waitFor();
        assert.equal(await fileList.count(), 0, 'the later / trigger owns the suggestions');
        for (let index = 0; index < 6; index++) await message.press('Backspace');
        await fileList.getByRole('option', { name: /Q3 revenue summary\.pdf/ }).waitFor();
        assert.equal(await skillList.count(), 0);
        await message.press('Enter');
        await page.getByRole('button', { name: `Inspect ${revenue.name}` }).waitFor();
        assert.equal(await message.textContent(), 'Compare ');

        const searchesBefore = skillSearches.length;
        await page.goto(`${origin}${workspace.slug}/chat/${projectChat}`);
        const projectScope = page.getByRole('button', { name: 'Project sharing details: Launch Day' });
        await projectScope.waitFor();
        assert.equal(
          await page
            .getByRole('region', { name: 'Conversation' })
            .getByText(/Shared in/)
            .count(),
          0,
          'project sharing is not announced at the top of the timeline',
        );
        await projectScope.click();
        await page.getByText('Project members can read this chat.').waitFor();
        await page.getByRole('link', { name: 'Launch Day' }).waitFor();
        await page.keyboard.press('Escape');
        await message.click();
        await message.pressSequentially('/');
        await page.waitForTimeout(400);
        assert.equal(await page.getByRole('listbox').count(), 0, '/ opens nothing in a project chat');
        assert.equal(skillSearches.length, searchesBefore);

        await page.goto(`${origin}${workspace.slug}/chat/${archivedProjectChat}`);
        const archivedScope = page.getByRole('button', { name: 'Project sharing details: Old Launch' });
        await archivedScope.waitFor();
        await archivedScope.click();
        await page.getByText('Project members can read this chat.').waitFor();
        await page.getByText('The project is archived, so this chat is read-only.').waitFor();
        await page.getByRole('link', { name: 'Old Launch' }).waitFor();

        assert.deepEqual(unexpected, []);
        assert.deepEqual(errors, []);
        assert.deepEqual(
          loads.map(url => new URL(url).pathname),
          [
            `/${workspace.slug}`,
            `/${workspace.slug}/chat/${failedChat}`,
            `/${workspace.slug}/chat/${projectChat}`,
            `/${workspace.slug}/chat/${archivedProjectChat}`,
          ],
          'only the four visits load a document; sending a draft navigates in place',
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
