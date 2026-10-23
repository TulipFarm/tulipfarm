import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { shellRead } from './shell-reads.mjs';
import { membership, credits } from './chat-query.fixture.mjs';
import { fallbackRecommendations } from '@tulipfarm/recommendations';

const { workspace, session } = createWorkspaceFixture();
const projectId = '44444444-4444-4444-8444-444444444444';
const base = `/v1/workspaces/${workspace.id}`;
const detailPath = `${workspace.slug}/projects/${projectId}`;
const settingsPath = `${detailPath}/settings`;
let vite;
let browser;
let origin;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await vite?.close();
});

function projectServer() {
  const member = {
    membershipId: membership.membershipId,
    userId: session.user.id,
    name: 'Ada',
    email: 'ada@example.test',
    role: 'manager',
  };
  const candidate = {
    membershipId: '55555555-5555-4555-8555-555555555555',
    userId: 'grace',
    name: 'Grace',
    email: 'grace@example.test',
  };
  const state = {
    project: {
      id: projectId,
      name: 'Spring launch',
      instructions: 'Answer as the launch team.',
      revision: 1,
      archived: false,
      manager: true,
    },
    members: [member],
    memberWrites: [],
    created: [],
    files: new Map(),
    edits: [],
    uploads: [],
    reads: { list: 0, detail: 0 },
    held: new Map(),
    lost: new Set(),
    dropped: new Set(),
    lostEdits: 0,
    failedReads: 0,
    unexpected: [],
    chatCreates: [],
    sends: [],
    chats: new Map(),
    messages: new Map(),
    attachments: new Map(),
    createStatus: 200,
    sendStatus: 200,
    commitUncertain: false,
    projectStatus: 200,
  };
  const hold = name => {
    const gate = Promise.withResolvers();
    state.held.set(name, gate);
    return () => {
      state.held.delete(name);
      gate.resolve();
    };
  };
  const stored = (id, revisionId, title, filename) =>
    state.files.set(id, {
      id,
      title,
      pinned: false,
      revisionId,
      filename,
      bytes: 64,
      updatedAt: '2026-10-05T09:00:00.000Z',
      source: null,
    });
  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
    if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
    if (path === '/v1/feature-flags') return route.fulfill({ json: {} });
    if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
    if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
    if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
    if (path.endsWith('/credits')) return route.fulfill({ json: credits });
    if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
    if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
    if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
    if (path.endsWith('/google-workspace/operations/proposals'))
      return route.fulfill({ json: { proposals: [], nextCursor: null } });
    if (path.endsWith('/workspace-mcp/capabilities'))
      return route.fulfill({ status: 404, json: { error: 'not-found' } });
    if (path === `${base}/conversations` && method === 'GET')
      return route.fulfill({ json: { chats: [...state.chats.values()], nextCursor: null } });
    const chat = new RegExp(`^${base}/conversations/([\\w-]+)$`).exec(path);
    if (chat && method === 'PUT') {
      const body = request.postDataJSON();
      state.chatCreates.push({ id: chat[1], body });
      if (state.createStatus !== 200)
        return route.fulfill({ status: state.createStatus, json: { error: 'chat-create-failed' } });
      assert.equal(body.projectId, projectId);
      state.chats.set(chat[1], {
        id: chat[1],
        title: 'New chat',
        titleRevision: 0,
        titleManual: false,
        archived: false,
        activityAt: workspace.createdAt,
        createdAt: workspace.createdAt,
        projectId,
      });
      return route.fulfill({ json: { id: chat[1] } });
    }
    if (chat && method === 'GET') return route.fulfill({ json: state.chats.get(chat[1]) });
    const sent = new RegExp(`^${base}/conversations/([\\w-]+)/messages/([\\w-]+)$`).exec(path);
    if (sent && method === 'PUT') {
      const body = request.postDataJSON();
      state.sends.push({ chatId: sent[1], messageId: sent[2], body });
      assert.ok(state.chats.has(sent[1]));
      await state.held.get('send')?.promise;
      if (state.sendStatus === 200 || state.commitUncertain) {
        const prior = state.messages.get(sent[2]);
        if (prior) assert.deepEqual(prior.parts, body.parts, 'An exact retry cannot change message parts');
        else
          state.messages.set(sent[2], {
            id: sent[2],
            author: 'human',
            sequence: 1,
            createdAt: workspace.createdAt,
            parts: body.parts,
            turn: null,
          });
      }
      return route.fulfill(
        state.sendStatus === 200
          ? { json: { messageId: sent[2], turnId: '77777777-7777-4777-8777-777777777777', sequence: 1 } }
          : {
              status: state.sendStatus,
              json: { error: state.sendStatus === 400 ? 'invalid-message' : 'send-unconfirmed' },
            },
      );
    }
    if (/\/conversations\/[^/]+\/messages$/.test(path) && method === 'GET')
      return route.fulfill({
        json: { messages: [...state.messages.values()], nextBefore: null, hasGitHubProposals: false },
      });
    const attachment = /\/(?:uploads|attachments)\/([^/]+)(\/content)?$/.exec(path);
    if (attachment) {
      if (method === 'PUT')
        state.attachments.set(
          attachment[1],
          attachment[2]
            ? { ...state.attachments.get(attachment[1]), state: 'ready' }
            : { ...request.postDataJSON(), id: attachment[1], state: 'reserved', expiresAt: '2099-01-01T00:00:00Z' },
        );
      return route.fulfill({ json: state.attachments.get(attachment[1]) });
    }
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n: keepalive\n\n' });
    if (path.endsWith('/recommendations'))
      return route.fulfill({
        json: { onboarding: false, status: 'ready', version: 1, items: fallbackRecommendations },
      });
    if (path === `${base}/governance/directory` && method === 'GET')
      return route.fulfill({
        json: {
          members: [member, candidate].map(person => ({
            id: person.membershipId,
            name: person.name,
            email: person.email,
            image: null,
          })),
        },
      });
    if (path === `${base}/projects` && method === 'GET') {
      state.reads.list++;
      return route.fulfill({ json: [state.project, ...state.created] });
    }
    if (path === `${base}/projects/${projectId}` && method === 'GET') {
      state.reads.detail++;
      if (state.projectStatus !== 200)
        return route.fulfill({ status: state.projectStatus, json: { error: 'project-not-found' } });
      if (state.failedReads > 0) {
        state.failedReads--;
        return route.fulfill({ status: 400, json: { error: 'invalid-request' } });
      }
      return route.fulfill({
        json: { project: state.project, members: state.members, files: [...state.files.values()] },
      });
    }
    const other = new RegExp(`^${base}/projects/([\\w-]+)$`).exec(path);
    if (other && method === 'PUT') {
      const created = {
        id: other[1],
        name: request.postDataJSON().name,
        instructions: '',
        revision: 1,
        archived: false,
        manager: true,
      };
      state.created.push(created);
      return route.fulfill({ json: created });
    }
    if (other && method === 'GET' && state.created.some(item => item.id === other[1]))
      return route.fulfill({
        json: { project: state.created.find(item => item.id === other[1]), members: [member], files: [] },
      });
    if (path === `${base}/projects/${projectId}/members` && method === 'PUT') {
      const change = request.postDataJSON();
      state.memberWrites.push(change);
      if (change.removed) state.members = state.members.filter(person => person.membershipId !== change.membershipId);
      else {
        const person = [member, candidate].find(item => item.membershipId === change.membershipId);
        state.members = state.members.some(item => item.membershipId === change.membershipId)
          ? state.members.map(item =>
              item.membershipId === change.membershipId ? { ...item, role: change.role } : item,
            )
          : [...state.members, { ...person, role: change.role }];
      }
      return route.fulfill({ json: {} });
    }
    if (path === `${base}/projects/${projectId}` && method === 'PATCH') {
      const edit = request.postDataJSON();
      state.edits.push(edit);
      await state.held.get('edit')?.promise;
      const current = state.project;
      if (edit.expectedRevision !== current.revision) {
        const replay =
          current.revision === edit.expectedRevision + 1 &&
          current.name === edit.name &&
          current.instructions === edit.instructions &&
          current.archived === edit.archived;
        return route.fulfill(replay ? { json: current } : { status: 409, json: { error: 'project-conflict' } });
      }
      state.project = {
        ...current,
        name: edit.name,
        instructions: edit.instructions,
        archived: edit.archived,
        revision: current.revision + 1,
      };
      if (state.lostEdits > 0) {
        state.lostEdits--;
        return route.abort('connectionreset');
      }
      return route.fulfill({ json: state.project });
    }
    const knowledge = new RegExp(`^${base}/projects/${projectId}/knowledge/([\\w-]+)$`).exec(path);
    if (knowledge && method === 'PUT') {
      const { revisionId, title } = request.postDataJSON();
      stored(knowledge[1], revisionId, title, `${title}.txt`);
      return route.fulfill({ json: { id: knowledge[1] } });
    }
    if (knowledge && method === 'PATCH') {
      const { pinned, removed } = request.postDataJSON();
      if (removed) state.files.delete(knowledge[1]);
      else state.files.set(knowledge[1], { ...state.files.get(knowledge[1]), pinned });
      return route.fulfill({ json: { id: knowledge[1] } });
    }
    const upload = new RegExp(`^${base}/projects/${projectId}/knowledge/([\\w-]+)/file$`).exec(path);
    if (upload && method === 'PUT') {
      const [, id] = upload;
      const revisionId = url.searchParams.get('revisionId');
      const filename = url.searchParams.get('filename');
      state.uploads.push({ id, revisionId, filename });
      await state.held.get(filename)?.promise;
      if (filename.endsWith('.docx')) return route.fulfill({ status: 409, json: { error: 'unreadable-file' } });
      if (state.dropped.delete(filename)) return route.abort('connectionreset');
      const prior = state.files.get(id);
      if (prior && prior.revisionId !== revisionId)
        return route.fulfill({ status: 409, json: { error: 'project-conflict' } });
      stored(id, revisionId, filename, filename);
      if (state.lost.delete(filename)) return route.abort('connectionreset');
      return route.fulfill({ json: { id } });
    }
    const shell = shellRead(method, path);
    if (shell) return route.fulfill(shell);
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: 'unexpected-request' } });
  }
  return { state, handle, hold };
}

const shots = process.env.UI_CONTINUITY_SCREENSHOTS;
// Records the screen even when an assertion fails, so a baseline run still produces its "before" evidence.
async function evidence(page, name, check) {
  try {
    await check();
  } finally {
    if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }).catch(() => {});
  }
}

async function open(context, path) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}${path}`);
  return { page, errors };
}

async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const filesInput = page => page.getByRole('region', { name: 'Files', exact: true }).locator('input[type="file"]');
const fileCount = (page, count) =>
  until(
    async () => (await page.getByRole('list', { name: 'Project files' }).getByRole('listitem').count()) === count,
    `the project shows ${count} files`,
  );
const file = (name, text = `${name} text`) => ({
  name,
  mimeType: name.endsWith('.docx')
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'text/plain',
  buffer: Buffer.from(text),
});

async function projectChat(run, options = {}) {
  const api = projectServer();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
    ...options,
  });
  await context.route('**/v1/**', api.handle);
  try {
    const { page, errors } = await open(context, detailPath);
    const editor = page.locator('[contenteditable]').first();
    await editor.waitFor();
    await run({ page, editor, api });
    assert.deepEqual(errors, []);
    assert.deepEqual(api.state.unexpected, []);
  } finally {
    for (const gate of api.state.held.values()) gate.resolve();
    await context.close();
  }
}
const sendMessage = page => page.getByRole('button', { name: 'Send message', exact: true }).click();
async function reviewProjectDraft(page) {
  await page.getByRole('button', { name: 'Refresh before editing', exact: true }).click();
  await page.getByRole('button', { name: 'Review retained input', exact: true }).click();
  await page.locator('[contenteditable=true]').first().waitFor();
}
test(
  'project chat retains rich input after rejection and sends once to the same chat',
  { timeout: 60000 },
  async () => {
    await projectChat(async ({ page, editor, api }) => {
      await editor.fill('Keep the launch plan.');
      await editor.press('ControlOrMeta+a');
      await editor.press('ControlOrMeta+b');
      await page
        .getByRole('form', { name: 'Message composer' })
        .locator('input[type=file]')
        .setInputFiles(file('launch-notes.txt'));
      await page.locator('[data-state="ready"]', { hasText: 'launch-notes.txt' }).waitFor();
      const html = await editor.innerHTML();
      api.state.sendStatus = 400;
      await sendMessage(page);
      await reviewProjectDraft(page);
      assert.equal(await editor.innerHTML(), html);
      assert.equal(await editor.evaluate(node => document.activeElement === node), true);
      assert.equal(api.state.chatCreates.length, 1);
      assert.equal(api.state.sends.length, 1);
      await page.locator('[data-state="ready"]', { hasText: 'launch-notes.txt' }).waitFor();
      api.state.sendStatus = 200;
      await sendMessage(page);
      await page.waitForURL(`**/chat/${api.state.chatCreates[0].id}`);
      assert.equal(api.state.chatCreates.length, 1);
      assert.equal(api.state.messages.size, 1);
      assert.deepEqual(api.state.sends[1].body.parts, api.state.sends[0].body.parts);
      assert.notEqual(api.state.sends[1].messageId, api.state.sends[0].messageId);
      assert.notEqual(api.state.sends[1].body.commandId, api.state.sends[0].body.commandId);
    });
  },
);
for (const status of [408, 429, 503])
  for (const committed of [false, true])
    test(`project chat ${status} exact retry retains input, committed=${committed}`, { timeout: 60000 }, async () => {
      await projectChat(async ({ page, editor, api }) => {
        await editor.fill('Do not send this twice.');
        api.state.sendStatus = status;
        api.state.commitUncertain = committed;
        await sendMessage(page);
        const retry = page.getByRole('button', { name: 'Retry same operation', exact: true });
        await retry.waitFor();
        assert.equal(await editor.textContent(), 'Do not send this twice.');
        assert.equal(await editor.getAttribute('contenteditable'), 'false');
        assert.equal(await page.getByRole('button', { name: 'Review retained input', exact: true }).count(), 0);
        api.state.sendStatus = 200;
        await retry.click();
        await page.waitForURL(`**/chat/${api.state.chatCreates[0].id}`);
        assert.deepEqual(api.state.sends[1], api.state.sends[0]);
        assert.equal(api.state.chatCreates.length, 1);
        assert.equal(api.state.messages.size, 1);
      });
    });
for (const status of [400, 503])
  test(`project chat creation ${status} recovery retains its create identity`, { timeout: 60000 }, async () => {
    await projectChat(async ({ page, editor, api }) => {
      api.state.createStatus = status;
      await editor.fill('Create only one project chat.');
      await sendMessage(page);
      if (status === 400) await reviewProjectDraft(page);
      else await page.getByRole('button', { name: 'Retry same operation', exact: true }).waitFor();
      assert.equal(await editor.textContent(), 'Create only one project chat.');
      assert.equal(api.state.sends.length, 0);
      api.state.createStatus = 200;
      if (status === 400) await sendMessage(page);
      else await page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
      await page.waitForURL(`**/chat/${api.state.chatCreates[0].id}`);
      assert.deepEqual(api.state.chatCreates[1], api.state.chatCreates[0]);
      assert.equal(api.state.chats.size, 1);
      assert.equal(api.state.messages.size, 1);
    });
  });
test(
  'project chat refresh failure cannot unlock a rejected draft; successful retry can',
  { timeout: 60000 },
  async () => {
    await projectChat(async ({ page, editor, api }) => {
      api.state.sendStatus = 400;
      await editor.fill('Keep after a failed refresh.');
      await sendMessage(page);
      api.state.failedReads = 1;
      await page.getByRole('button', { name: 'Refresh before editing', exact: true }).click();
      await page.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor();
      assert.equal(await editor.textContent(), 'Keep after a failed refresh.');
      assert.equal(await editor.getAttribute('contenteditable'), 'false');
      assert.equal(await page.getByRole('button', { name: 'Review retained input', exact: true }).count(), 0);
      await reviewProjectDraft(page);
      assert.equal(await editor.textContent(), 'Keep after a failed refresh.');
      assert.equal(api.state.sends.length, 1);
    });
  },
);
for (const unavailable of ['denied', 'archived'])
  test(`project chat ${unavailable} after rejection does not offer another send`, { timeout: 60000 }, async () => {
    await projectChat(async ({ page, editor, api }) => {
      api.state.sendStatus = 400;
      await editor.fill('Do not send without access.');
      await sendMessage(page);
      if (unavailable === 'denied') api.state.projectStatus = 403;
      else api.state.project.archived = true;
      await page.getByRole('button', { name: 'Refresh before editing', exact: true }).click();
      await page
        .getByText(unavailable === 'denied' ? 'Project unavailable' : 'This project is archived', { exact: true })
        .waitFor();
      assert.equal(await page.getByRole('button', { name: 'Review retained input', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).count(), 0);
      assert.equal(api.state.sends.length, 1);
    });
  });
test(
  'project chat draft navigation warns, but accepted sends navigate without a prompt',
  { timeout: 60000 },
  async () => {
    await projectChat(async ({ page, editor, api }) => {
      await editor.fill('Keep until accepted.');
      await page.getByRole('link', { name: 'Edit project', exact: true }).click();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      assert.equal(await editor.textContent(), 'Keep until accepted.');
      const release = api.hold('send');
      await page.getByRole('button', { name: 'Send message', exact: true }).evaluate(button => {
        button.click();
        button.click();
      });
      await until(() => api.state.sends.length === 1, 'one send is pending');
      release();
      await page.waitForURL(`**/chat/${api.state.chatCreates[0].id}`);
      assert.equal(await page.getByText('Leave these edits?', { exact: true }).count(), 0);
      assert.equal(api.state.sends.length, 1);
    });
  },
);
test('project chat drafts do not move to a different project', { timeout: 60000 }, async () => {
  await projectChat(async ({ page, editor, api }) => {
    const otherId = '88888888-8888-4888-8888-888888888888';
    api.state.created.push({ ...api.state.project, id: otherId, name: 'Other project' });
    await editor.fill('Only for Spring launch.');
    await page.getByRole('link', { name: 'Back to projects', exact: true }).click();
    await page.getByRole('button', { name: 'Leave editor', exact: true }).click();
    await page.locator(`a[href="/${workspace.slug}/projects/${otherId}"]`).click();
    await page.locator('[contenteditable=true]').first().waitFor();
    assert.equal(await page.locator('[contenteditable=true]').first().textContent(), '');
    assert.equal(api.state.chatCreates.length, 0);
    assert.equal(api.state.sends.length, 0);
  });
});
for (const width of [320, 375, 414, 768, 1440])
  test(`project chat recovery at ${width}px preserves keyboard editing`, { timeout: 60000 }, async () => {
    await projectChat(
      async ({ page, editor, api }) => {
        api.state.sendStatus = 400;
        await editor.fill('Retained on a small screen.');
        await editor.press('Enter');
        await reviewProjectDraft(page);
        assert.equal(await editor.textContent(), 'Retained on a small screen.');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        api.state.sendStatus = 200;
        await editor.press('Enter');
        await page.waitForURL(`**/chat/${api.state.chatCreates[0].id}`);
        assert.equal(api.state.messages.size, 1);
      },
      { viewport: { width, height: 1000 }, colorScheme: width === 375 ? 'dark' : 'light' },
    );
  });

test('project member selectors show labels and submit selected roles', { timeout: 120000 }, async () => {
  const api = projectServer();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/v1/**', api.handle);
  try {
    const { page, errors } = await open(context, settingsPath);
    const person = page.getByRole('combobox', { name: 'Person', exact: true });
    await person.click();
    await page.getByRole('option', { name: 'Grace (grace@example.test)', exact: true }).click();
    assert.equal((await person.innerText()).trim(), 'Grace (grace@example.test)');

    const addRole = page.getByRole('combobox', { name: 'Role', exact: true });
    await addRole.click();
    await page.getByRole('option', { name: 'Manager', exact: true }).last().click();
    assert.equal((await addRole.innerText()).trim(), 'Manager');
    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    await page.getByRole('combobox', { name: 'Role for Grace', exact: true }).waitFor();
    assert.deepEqual(api.state.memberWrites[0], {
      membershipId: '55555555-5555-4555-8555-555555555555',
      role: 'manager',
      removed: false,
    });

    const adaRole = page.getByRole('combobox', { name: 'Role for Ada', exact: true });
    await adaRole.click();
    await page.getByRole('option', { name: 'Member', exact: true }).click();
    await page.getByText('Ada is now a member.', { exact: true }).waitFor();
    assert.deepEqual(api.state.memberWrites[1], {
      membershipId: membership.membershipId,
      role: 'member',
      removed: false,
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// The edit page shows the project name as its back link (cloud 0637f9ee #743, pages/projects.tsx:300).
test(
  'unsaved instructions survive a rename saved in another tab and save on top of it',
  { timeout: 120000 },
  async () => {
    const api = projectServer();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/v1/**', api.handle);
    try {
      const a = await open(context, settingsPath);
      const b = await open(context, settingsPath);
      await a.page.getByRole('textbox', { name: 'Instructions' }).fill('Quote prices in euros.');
      await b.page.getByRole('textbox', { name: 'Project name' }).fill('Autumn launch');
      await b.page.getByRole('button', { name: 'Save changes' }).click();
      await a.page.getByRole('link', { name: 'Autumn launch', exact: true }).waitFor();
      assert.equal(
        await a.page.getByRole('textbox', { name: 'Instructions' }).inputValue(),
        'Quote prices in euros.',
        'the unsaved instructions survive the newer version',
      );
      assert.equal(
        await a.page.getByRole('textbox', { name: 'Project name' }).inputValue(),
        'Autumn launch',
        'the untouched name follows the newer version',
      );
      assert.equal(await a.page.getByRole('alert').count(), 0, 'edits to different fields do not conflict');
      await a.page.getByRole('button', { name: 'Save changes' }).click();
      await until(() => api.state.project.revision === 3, 'tab A saves on top of the rename');
      assert.deepEqual(api.state.edits.at(-1), {
        expectedRevision: 2,
        name: 'Autumn launch',
        instructions: 'Quote prices in euros.',
        archived: false,
      });
      assert.deepEqual(api.state.unexpected, []);
      assert.deepEqual([...a.errors, ...b.errors], []);
    } finally {
      await context.close();
    }
  },
);

test(
  'a draft that conflicts with a newer version waits for the person to keep or discard it',
  { timeout: 120000 },
  async () => {
    const api = projectServer();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/v1/**', api.handle);
    try {
      const a = await open(context, settingsPath);
      const b = await open(context, settingsPath);
      const instructions = a.page.getByRole('textbox', { name: 'Instructions' });
      const save = a.page.getByRole('button', { name: 'Save changes' });
      await instructions.fill('Quote prices in euros.');
      await b.page.getByRole('textbox', { name: 'Instructions' }).fill('Quote prices in dollars.');
      await b.page.getByRole('button', { name: 'Save changes' }).click();
      await until(() => api.state.project.revision === 2, 'tab B saves its instructions');
      const conflict = a.page.getByRole('alert').filter({ hasText: 'This project changed while you were editing' });
      await until(
        async () => (await conflict.count()) === 1 || (await instructions.inputValue()) !== 'Quote prices in euros.',
        'tab A reports the conflict or loses the draft',
      );
      assert.equal(await instructions.inputValue(), 'Quote prices in euros.', 'the conflicting draft is kept');
      await a.page.getByText('Quote prices in dollars.', { exact: true }).waitFor();
      assert.equal(await save.isDisabled(), true, 'saving waits for a choice');
      await a.page.getByRole('button', { name: 'Keep my edits' }).click();
      assert.equal(await conflict.count(), 0);
      assert.equal(
        await save.evaluate(element => element === document.activeElement),
        true,
        'keeping the edits moves focus to Save',
      );
      const reads = api.state.reads.detail;
      await save.click();
      await until(
        () => api.state.project.revision === 3 && api.state.reads.detail >= reads + 2,
        'the kept draft replaces the newer instructions and both tabs reload it',
      );
      assert.deepEqual(api.state.edits.at(-1), {
        expectedRevision: 2,
        name: 'Spring launch',
        instructions: 'Quote prices in euros.',
        archived: false,
      });

      api.state.project = { ...api.state.project, name: 'Renamed elsewhere', revision: 4 };
      await instructions.fill('Quote prices in euros and pounds.');
      await save.click();
      await a.page
        .getByText(
          'This project changed, is archived, or is over its 20 MB knowledge limit. Refresh it and try again. Your edits are kept.',
        )
        .waitFor();
      assert.equal(
        await instructions.inputValue(),
        'Quote prices in euros and pounds.',
        'a rejected save keeps the draft',
      );
      await a.page.getByRole('button', { name: 'Check status again' }).click();
      await a.page.getByRole('link', { name: 'Renamed elsewhere', exact: true }).waitFor();
      assert.equal(await instructions.inputValue(), 'Quote prices in euros and pounds.', 'the refresh keeps the draft');
      await save.click();
      await until(() => api.state.project.revision === 5, 'the draft saves on top of the change it had not seen');
      assert.deepEqual(api.state.edits.at(-1), {
        expectedRevision: 4,
        name: 'Renamed elsewhere',
        instructions: 'Quote prices in euros and pounds.',
        archived: false,
      });

      await b.page.getByRole('link', { name: 'Renamed elsewhere', exact: true }).waitFor();
      await instructions.fill('Discard this draft.');
      await b.page.getByRole('textbox', { name: 'Project name' }).fill('Summer launch');
      await b.page.getByRole('textbox', { name: 'Instructions' }).fill('Use the launch brief.');
      await b.page.getByRole('button', { name: 'Save changes' }).click();
      await conflict.waitFor();
      assert.equal(
        await a.page.getByRole('textbox', { name: 'Project name' }).inputValue(),
        'Summer launch',
        'an untouched field follows the newer version during a conflict',
      );
      assert.equal(await instructions.inputValue(), 'Discard this draft.');
      await a.page.getByRole('button', { name: 'Discard changes' }).click();
      assert.equal(await instructions.inputValue(), 'Use the launch brief.', 'discarding loads the newer version');
      assert.equal(await conflict.count(), 0);
      assert.deepEqual(api.state.unexpected, []);
      assert.deepEqual([...a.errors, ...b.errors], []);
    } finally {
      await context.close();
    }
  },
);

test(
  'a draft that another tab saved word for word follows a later revert instead of saving over it',
  { timeout: 120000 },
  async () => {
    const api = projectServer();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/v1/**', api.handle);
    try {
      const a = await open(context, settingsPath);
      const b = await open(context, settingsPath);
      const instructions = a.page.getByRole('textbox', { name: 'Instructions' });
      const save = a.page.getByRole('button', { name: 'Save changes' });
      await instructions.fill('Quote prices in euros.');
      await b.page.getByRole('textbox', { name: 'Instructions' }).fill('Quote prices in euros.');
      await b.page.getByRole('button', { name: 'Save changes' }).click();
      await until(
        async () => api.state.project.revision === 2 && (await save.isDisabled()),
        'the matching save leaves tab A with nothing unsaved',
      );
      await b.page.getByRole('textbox', { name: 'Instructions' }).fill('Answer as the launch team.');
      await b.page.getByRole('button', { name: 'Save changes' }).click();
      await until(
        async () => (await instructions.inputValue()) === 'Answer as the launch team.',
        'tab A follows the revert',
      );
      assert.equal(await save.isDisabled(), true, 'tab A has nothing to save over the revert');
      assert.equal(api.state.edits.length, 2);
      assert.deepEqual(api.state.unexpected, []);
      assert.deepEqual([...a.errors, ...b.errors], []);
    } finally {
      await context.close();
    }
  },
);

test(
  'an unconfirmed save locks the draft until a status check or the same retry settles it',
  { timeout: 120000 },
  async () => {
    const api = projectServer();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/v1/**', api.handle);
    try {
      const { page, errors } = await open(context, settingsPath);
      const instructions = page.getByRole('textbox', { name: 'Instructions' });
      const save = page.getByRole('button', { name: 'Save changes' });
      const check = page.getByRole('button', { name: 'Check status again' });
      const retry = page.getByRole('button', { name: 'Retry same operation' });
      await instructions.fill('Quote prices in euros.');
      api.state.lostEdits = 1;
      await save.click();
      await page
        .getByText(
          'We could not confirm the outcome. Your input is kept here. Check status before trying the same operation again.',
        )
        .waitFor();
      assert.equal(await instructions.isDisabled(), true, 'the draft stays as sent until its outcome is known');
      assert.equal(await save.isDisabled(), true);
      await check.click();
      await check.waitFor({ state: 'detached' });
      assert.equal(await instructions.isDisabled(), false, 'a status check that finds the save unlocks the editor');
      assert.equal(await instructions.inputValue(), 'Quote prices in euros.');
      assert.equal(await save.isDisabled(), true, 'the found save leaves nothing unsaved');

      const command = {
        expectedRevision: 2,
        name: 'Spring launch',
        instructions: 'Quote prices in euros and pounds.',
        archived: false,
      };
      await instructions.fill(command.instructions);
      api.state.lostEdits = 1;
      await save.click();
      await retry.click();
      await retry.waitFor({ state: 'detached' });
      assert.equal(await instructions.inputValue(), command.instructions);
      assert.deepEqual(api.state.edits.slice(-2), [command, command], 'the retry resends the same command');
      assert.equal(api.state.project.revision, 3, 'the server replays the retry instead of saving it twice');
      assert.equal(await save.isDisabled(), true);
      assert.deepEqual(api.state.unexpected, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test('archive and upload results reach cached project views after the page closes', { timeout: 120000 }, async () => {
  const api = projectServer();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/v1/**', api.handle);
  try {
    const { page, errors } = await open(context, `${workspace.slug}/projects`);
    const project = page.getByRole('link', { name: 'Spring launch' });
    const back = page.getByRole('link', { name: 'Back to projects' });
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Autumn launch');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('heading', { name: 'Autumn launch', level: 1 }).waitFor();
    await back.click();
    await page.getByRole('table', { name: 'Active projects' }).getByRole('link', { name: 'Autumn launch' }).waitFor();
    await project.click();
    const release = api.hold('brief.txt');
    await filesInput(page).setInputFiles([file('brief.txt')]);
    await until(() => api.state.uploads.length === 1, 'the upload starts');
    await back.click();
    await page.getByRole('table', { name: 'Active projects' }).waitFor();
    const lists = api.state.reads.list;
    release();
    await until(
      () => api.state.reads.list > lists,
      'a finished upload refreshes the project list after the page closed',
    );
    await project.click();
    await fileCount(page, 1);

    const archived = api.hold('edit');
    await page.getByRole('link', { name: 'Edit project' }).click();
    await page.getByRole('button', { name: 'Archive project' }).click();
    await until(() => api.state.edits.length === 1, 'the archive starts');
    await page.goBack();
    await back.click();
    await page.getByRole('table', { name: 'Active projects' }).getByRole('link', { name: 'Spring launch' }).waitFor();
    archived();
    await page.getByRole('group', { name: 'Project status' }).getByRole('button', { name: 'Archived' }).click();
    await page.getByRole('table', { name: 'Archived projects' }).getByRole('link', { name: 'Spring launch' }).waitFor();
    await project.click();
    await page.getByText('This project is archived', { exact: true }).waitFor();
    assert.equal(api.state.project.archived, true);
    assert.deepEqual(api.state.unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(
  'upload results, Retry, and the busy file picker survive leaving the project page',
  { timeout: 120000 },
  async () => {
    const api = projectServer();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/v1/**', api.handle);
    try {
      const { page, errors } = await open(context, detailPath);
      const back = page.getByRole('link', { name: 'Back to projects' });
      const project = page.getByRole('link', { name: 'Spring launch' });
      const uploads = page.getByRole('region', { name: 'Uploads' });
      const choose = page.getByRole('button', { name: 'Choose files' });
      const warnsOnClose = () =>
        page.evaluate(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        });
      api.state.dropped.add('c.txt');
      const release = api.hold('a.txt');
      await filesInput(page).setInputFiles([file('a.txt'), file('b.docx'), file('c.txt')]);
      await until(() => api.state.uploads.length === 1, 'a.txt starts sending');
      await back.click();
      await project.click();
      await uploads.getByRole('status').filter({ hasText: 'Adding a.txt…' }).waitFor();
      assert.equal(await choose.isDisabled(), true, 'choosing files waits for the running batch');
      assert.equal(await warnsOnClose(), true, 'closing the tab while sending warns first');

      await back.click();
      await page.getByRole('table', { name: 'Active projects' }).waitFor();
      release();
      await until(() => api.state.uploads.length === 3, 'the batch keeps sending after the page closes');
      await project.click();
      await fileCount(page, 1);
      await uploads.getByRole('status').filter({ hasText: '1 added, 1 not added, 1 not confirmed' }).waitFor();
      await uploads
        .getByText(
          'b.docx: TulipFarm could not read text from this file. Check that it is not empty, protected, or larger than 10 MB.',
        )
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Add', exact: true }).isDisabled(),
        false,
        'adding files works again after the batch',
      );
      assert.equal(await warnsOnClose(), false, 'a finished batch does not warn');
      await uploads.getByRole('button', { name: 'Retry adding c.txt' }).click();
      await uploads.getByRole('status').filter({ hasText: '2 added, 1 not added' }).waitFor();
      const attempts = api.state.uploads.filter(item => item.filename === 'c.txt');
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[1], attempts[0], 'the retry after navigation sends the same ids');
      await fileCount(page, 2);
      assert.deepEqual(
        [...api.state.files.values()].map(item => item.filename),
        ['a.txt', 'c.txt'],
      );
      assert.deepEqual(api.state.unexpected, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test(
  'a mixed upload batch reports each file and retries only the unconfirmed one with its ids',
  { timeout: 120000 },
  async () => {
    const api = projectServer();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/v1/**', api.handle);
    try {
      const { page, errors } = await open(context, detailPath);
      const input = filesInput(page);
      const uploads = page.getByRole('region', { name: 'Uploads' });
      const row = name => uploads.getByRole('listitem').filter({ hasText: name });

      await input.setInputFiles([file('notes.txt'), file('scan.docx'), file('prices.txt')]);
      await until(() => api.state.uploads.length === 3, 'the file after a rejected one is still sent');
      await uploads.getByRole('status').filter({ hasText: '2 added, 1 not added' }).waitFor();
      assert.deepEqual(
        api.state.uploads.map(item => item.filename),
        ['notes.txt', 'scan.docx', 'prices.txt'],
      );
      for (const [name, outcome] of [
        ['notes.txt', 'Added'],
        ['scan.docx', 'Not added'],
        ['prices.txt', 'Added'],
      ])
        await row(name).getByText(outcome, { exact: true }).waitFor();
      await uploads
        .getByText(
          'scan.docx: TulipFarm could not read text from this file. Check that it is not empty, protected, or larger than 10 MB.',
        )
        .waitFor();
      assert.equal(
        await uploads.getByRole('button', { name: /Retry/ }).count(),
        0,
        'a confirmed rejection offers no retry',
      );
      await fileCount(page, 2);
      const list = page.getByRole('list', { name: 'Project files' });
      assert.deepEqual(await list.getByRole('listitem').locator('p.font-medium').allTextContents(), [
        'notes.txt',
        'prices.txt',
      ]);
      await uploads.getByRole('button', { name: 'Dismiss upload results' }).click();
      assert.equal(await uploads.count(), 0);

      api.state.lost.add('minutes.txt');
      const reads = api.state.reads.detail;
      const release = api.hold('minutes.txt');
      await input.setInputFiles([file('budget.txt'), file('minutes.txt')]);
      await until(
        () => api.state.reads.detail > reads && api.state.uploads.at(-1)?.filename === 'minutes.txt',
        'the list reloads after budget.txt before minutes.txt finishes',
      );
      api.state.failedReads = 1;
      release();
      await uploads.getByRole('status').filter({ hasText: '1 added, 1 not confirmed' }).waitFor();
      await until(() => api.state.failedReads === 0, 'an unconfirmed upload reloads the project');
      await row('minutes.txt').getByText('Not confirmed', { exact: true }).waitFor();
      await uploads
        .getByText(
          'minutes.txt: We couldn’t confirm whether it was added. Retry sends the same file without adding a copy.',
        )
        .waitFor();
      await uploads.getByRole('button', { name: 'Retry adding minutes.txt' }).click();
      await page.getByRole('status').filter({ hasText: '2 files added.' }).waitFor();
      assert.equal(await uploads.count(), 0, 'a batch that ends fully added collapses to one message');
      const attempts = api.state.uploads.filter(item => item.filename === 'minutes.txt');
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[1], attempts[0], 'the retry sends the same ids');
      assert.equal(
        api.state.uploads.filter(item => item.filename === 'budget.txt').length,
        1,
        'confirmed files are not sent again',
      );
      assert.deepEqual(
        [...api.state.files.values()].map(item => item.filename),
        ['notes.txt', 'prices.txt', 'budget.txt', 'minutes.txt'],
      );
      await fileCount(page, 4);

      api.state.lost.add('agenda.txt');
      await input.setInputFiles([file('agenda.txt'), file('brief.txt')]);
      await page.getByRole('status').filter({ hasText: '2 files added.' }).waitFor();
      await fileCount(page, 6);
      api.state.lost.add('memo.txt');
      await input.setInputFiles([file('memo.txt')]);
      await page.getByRole('status').filter({ hasText: 'memo.txt added.' }).waitFor();
      await fileCount(page, 7);
      assert.equal(await uploads.count(), 0, 'files the reloaded list shows need no retry');
      assert.deepEqual(
        ['agenda.txt', 'memo.txt'].map(name => api.state.uploads.filter(item => item.filename === name).length),
        [1, 1],
      );

      await page.getByRole('button', { name: 'Actions for notes.txt' }).click();
      await page.getByRole('menuitem', { name: 'Pin to top' }).click();
      await page.getByRole('status').filter({ hasText: 'notes.txt pinned. Chats always include it first.' }).waitFor();
      await list.getByRole('listitem').filter({ hasText: 'notes.txt' }).getByText('Pinned', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Paste text' }).click();
      const paste = page.getByRole('dialog', { name: 'Paste text' });
      await paste.getByRole('textbox', { name: 'Title' }).fill('Launch brief');
      await paste.getByRole('textbox', { name: 'Text' }).fill('Launch is on 12 May.');
      await paste.getByRole('button', { name: 'Save text' }).click();
      await page.getByRole('status').filter({ hasText: 'Launch brief added.' }).waitFor();
      await fileCount(page, 8);
      assert.deepEqual(api.state.unexpected, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test(
  'project search narrows by name, keeps its scope through a project visit, and recovers from no results',
  { timeout: 120000 },
  async () => {
    const api = projectServer();
    api.state.created.push(
      {
        id: '66666666-6666-4666-8666-666666666666',
        name: 'Autumn launch',
        instructions: '',
        revision: 1,
        archived: false,
        manager: true,
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        name: 'Winter launch',
        instructions: '',
        revision: 1,
        archived: true,
        manager: true,
      },
    );
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/v1/**', api.handle);
    try {
      const { page, errors } = await open(context, `${workspace.slug}/projects`);
      const search = page.getByRole('searchbox', { name: 'Search projects', exact: true });
      const active = page.getByRole('table', { name: 'Active projects' });
      const archived = page.getByRole('table', { name: 'Archived projects' });
      await active.getByRole('link', { name: 'Spring launch' }).waitFor();
      assert.equal(await archived.count(), 0, 'archived projects stay out of the active list until chosen');
      await evidence(page, 'a10-project-search-match', async () => {
        await search.fill('autumn');
        await page.waitForURL(/[?&]q=autumn/);
        await page.getByRole('status').filter({ hasText: '1 project matches “autumn”.' }).waitFor();
        assert.equal(await active.getByRole('link', { name: 'Spring launch' }).count(), 0);
        await active.getByRole('link', { name: 'Autumn launch' }).waitFor();
      });
      await evidence(page, 'a10-project-search-no-results', async () => {
        await search.fill('winter');
        await page.getByRole('heading', { name: 'No active projects match “winter”' }).waitFor();
        await page.getByText('1 archived project matches this name.', { exact: true }).waitFor();
      });
      await page.getByRole('button', { name: 'Show archived matches', exact: true }).click();
      await archived.getByRole('link', { name: 'Winter launch' }).click();
      await page.getByRole('heading', { name: 'Winter launch', level: 1 }).waitFor();
      await page.getByRole('link', { name: 'Back to projects' }).click();
      await archived.getByRole('link', { name: 'Winter launch' }).waitFor();
      assert.equal(await search.inputValue(), 'winter', 'returning from a project keeps the search');
      assert.match(page.url(), /[?&]archived=true/);
      await page.reload();
      await archived.getByRole('link', { name: 'Winter launch' }).waitFor();
      assert.equal(await search.inputValue(), 'winter', 'a reload keeps the search');

      await search.fill('zzz');
      await page.getByRole('heading', { name: 'No archived projects match “zzz”' }).waitFor();
      await page.getByRole('button', { name: 'Clear search', exact: true }).filter({ hasText: 'Clear search' }).click();
      await archived.getByRole('link', { name: 'Winter launch' }).waitFor();
      assert.equal(await search.inputValue(), '');
      assert.doesNotMatch(page.url(), /[?&]q=/);
      await page
        .getByRole('group', { name: 'Project status' })
        .getByRole('button', { name: 'Active', exact: true })
        .click();
      await active.getByRole('link', { name: 'Autumn launch' }).waitFor();
      await active.getByRole('link', { name: 'Spring launch' }).waitFor();
      assert.deepEqual(api.state.unexpected, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test('leaving a project states the access loss and waits for confirmation', { timeout: 120000 }, async () => {
  const api = projectServer();
  const grace = {
    membershipId: '55555555-5555-4555-8555-555555555555',
    userId: 'grace',
    name: 'Grace',
    email: 'grace@example.test',
    role: 'manager',
  };
  api.state.project = { ...api.state.project, manager: false };
  api.state.members = [{ ...api.state.members[0], role: 'member' }, grace];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/v1/**', api.handle);
  try {
    const { page, errors } = await open(context, settingsPath);
    const dialog = page.getByRole('alertdialog', { name: 'Leave Spring launch?' });
    await page.getByRole('button', { name: 'Leave project', exact: true }).click();
    await evidence(page, 'a11-leave-project-confirmation', async () => {
      await dialog
        .getByText(
          "You lose access to this project's chats, files, and instructions right away. A project manager must add you again before you can return.",
          { exact: true },
        )
        .waitFor();
    });
    assert.deepEqual(api.state.memberWrites, [], 'opening the confirmation changes nothing');
    await dialog.getByRole('button', { name: 'Stay in project', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(api.state.memberWrites, []);
    await page.getByRole('button', { name: 'Leave project', exact: true }).click();
    await dialog.getByRole('button', { name: 'Leave project', exact: true }).click();
    await page.waitForURL(/\/projects$/);
    assert.deepEqual(api.state.memberWrites, [
      { membershipId: membership.membershipId, role: 'member', removed: true },
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('removing a member names the lost access and offers a real undo', { timeout: 120000 }, async () => {
  const api = projectServer();
  const graceId = '55555555-5555-4555-8555-555555555555';
  api.state.members = [
    api.state.members[0],
    { membershipId: graceId, userId: 'grace', name: 'Grace', email: 'grace@example.test', role: 'member' },
  ];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/v1/**', api.handle);
  try {
    const { page, errors } = await open(context, settingsPath);
    await page.getByRole('button', { name: 'Remove Grace', exact: true }).click();
    await evidence(page, 'a11-remove-member-undo', async () => {
      await page
        .getByText("Grace removed. They can no longer open this project's chats, files, or instructions.", {
          exact: true,
        })
        .waitFor();
    });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByText('Grace is back in this project as a member.', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Role for Grace', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
    assert.deepEqual(api.state.memberWrites, [
      { membershipId: graceId, role: 'member', removed: true },
      { membershipId: graceId, role: 'member', removed: false },
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
