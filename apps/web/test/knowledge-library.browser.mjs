import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { knowledgeSaveSchema, knowledgeCommandSchema } from '@tulipfarm/knowledge/contracts';
import {
  startBuiltApp,
  captureBuilderScreenshot,
  captureBrowserFailure,
  builderBrowserOptions,
} from './built-app.fixture.mjs';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

const entry = (title, rest = {}) => ({
  documentId: randomUUID(),
  revisionId: randomUUID(),
  publicationId: randomUUID(),
  title,
  kind: 'note',
  noteText: 'Handbook policy: ask your manager for leave.',
  parsing: 'ready',
  failure: null,
  canRetry: false,
  ...rest,
});

let server, browser;
before(async () => {
  server = await startBuiltApp();
  browser = await chromium.launch(builderBrowserOptions());
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
});

async function environment(t, { entries = [], enabled = true, otherMember = false, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  if (clock) {
    await page.clock.install({ time: new Date(0) });
    await page.clock.pauseAt(new Date(0));
  }
  const { workspace, session } = createWorkspaceFixture({
    slug: 'knowledge-demo',
    name: 'Knowledge demo',
    userId: otherMember ? 'grace' : 'ada',
  });
  const file = {
    id: randomUUID(),
    kind: 'file',
    name: 'Reference handbook.txt',
    parentId: null,
    creatorMembershipId: workspace.id,
    mediaType: 'text/plain',
    size: 120,
    trashed: false,
    role: 'manager',
  };
  const requests = [],
    errors = [],
    unexpected = [],
    failed = [];
  const base = `/v1/workspaces/${workspace.id}`;
  let listReads = 0;
  const answer = (json, status = 200) => ({ status, json: structuredClone(json) });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 500) failed.push(response.url());
  });
  await page.route('**/v1/**', async route => {
    if (await serveWorkspaceShellEvent(route, workspace)) return;
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    const body = request.postDataJSON();
    requests.push({ path, method, body, query: url.searchParams.toString() });
    let response;
    if (path.endsWith('/auth/get-session')) response = answer(session);
    else if (path === '/v1/user/visit') response = answer({ firstSession: false });
    else if (path === '/v1/workspaces') response = answer([workspace]);
    else if (path === `/v1/workspaces/${workspace.slug}`) response = answer(workspace);
    else if (path === '/v1/google-workspace/availability') response = answer({ configured: false });
    else if (path === `${base}/google-workspace`) response = answer({ status: 'disconnected' });
    else if (path.endsWith('/governance/me'))
      response = answer({
        membershipId: otherMember ? '22222222-2222-4222-8222-222222222222' : workspace.id,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      });
    else if (new Map(workspaceShellReads(workspace.id)).has(path))
      response = answer(new Map(workspaceShellReads(workspace.id)).get(path));
    else if (path === `${base}/knowledge/defaults`) response = answer({ enabled, items: [] });
    else if (/\/knowledge\/(github|google|slack|atlassian)\/sources$/.test(path)) response = answer({ items: [] });
    else if (path === `${base}/files/suggestions`) response = answer({ items: [file], next: null });
    else if (path === `${base}/knowledge/documents`) {
      listReads++;
      const visible = otherMember ? [] : entries;
      const cursor = url.searchParams.get('cursor');
      response = answer({
        items: cursor ? visible.slice(1) : visible.slice(0, 1),
        nextCursor: !cursor && visible.length > 1 ? visible[0].documentId : null,
      });
    } else if (path === `${base}/knowledge/search`) {
      const matches = otherMember
        ? []
        : entries.filter(item => item.noteText?.toLowerCase().includes(url.searchParams.get('query').toLowerCase()));
      response = answer({
        mode: 'keyword-only',
        reason: 'typing',
        coverage: 'keyword-only',
        bounded: true,
        continuation: null,
        validUntil: new Date(Date.now() + 240000).toISOString(),
        hits: matches.map(item => ({
          title: item.title,
          heading: 'Leave policy',
          text: item.noteText,
          location: { kind: 'page', page: 2 },
          citation: {
            kind: 'knowledge-document',
            workspaceId: workspace.id,
            sourceId: workspace.id,
            documentId: item.documentId,
            revisionId: item.revisionId,
            publicationId: item.publicationId,
            accessEpoch: 1,
            ordinal: 0,
          },
        })),
      });
    } else if (path.startsWith(`${base}/knowledge/documents/`)) {
      const documentId = path.split('/documents/')[1].split('/')[0];
      const index = entries.findIndex(item => item.documentId === documentId),
        current = entries[index];
      if (method === 'GET') response = current ? answer(current) : answer({ error: 'knowledge-not-found' }, 404);
      else if (method === 'PUT') {
        const input = knowledgeSaveSchema.parse({ ...body, documentId });
        if (current && current.revisionId !== input.expectedRevisionId)
          response = answer({ error: 'knowledge-conflict' }, 409);
        else {
          const value = entry(input.title, {
            documentId,
            revisionId: input.commandId,
            parsing: 'queued',
            kind: input.input.kind,
            ...(input.input.kind === 'note' ? { noteText: input.input.text } : { fileId: input.input.fileId }),
          });
          if (current) entries[index] = value;
          else entries.push(value);
          response = answer(value);
        }
      } else {
        knowledgeCommandSchema.parse({ ...body, documentId });
        if (!current) response = answer({ error: 'knowledge-not-found' }, 404);
        else if (current.revisionId !== body.expectedRevisionId)
          response = answer({ error: 'knowledge-conflict' }, 409);
        else if (path.endsWith('/remove')) {
          entries.splice(index, 1);
          response = answer({ documentId, revisionId: current.revisionId, removed: true });
        } else if (path.endsWith('/retry')) {
          Object.assign(current, { parsing: 'queued', failure: null, canRetry: false });
          response = answer(current);
        }
      }
    }
    if (!response) {
      unexpected.push(`${method} ${path}`);
      response = answer({ error: 'unknown-fixture-route' }, 404);
    }
    await route.fulfill(response);
  });
  const initialPages = clock
    ? page.waitForResponse(response => new URL(response.url()).searchParams.has('cursor'))
    : null;
  await page.goto(`${server.origin}/${workspace.slug}/knowledge`);
  if (initialPages) {
    await (await initialPages).finished();
    await page.clock.runFor(100);
  }
  const library = page.locator('section[aria-label="Your Knowledge"]');
  await library.getByRole('heading', { name: 'Your entries', exact: true }).waitFor();
  t.after(() => {
    assert.deepEqual(errors, [], 'no browser exceptions');
    assert.deepEqual(unexpected, [], 'no unexpected or failed fixture requests');
    assert.deepEqual(failed, [], 'no failed server requests');
  });
  return {
    page,
    library,
    entries,
    file,
    requests,
    get listReads() {
      return listReads;
    },
    documentReads: () =>
      requests.filter(request => request.method === 'GET' && request.path.startsWith(`${base}/knowledge/documents/`)),
  };
}

test(
  'lists ready files and notes across pages, tracks parsing, and only offers eligible retries',
  { timeout: 60000 },
  async t => {
    const pending = entry('Processing report', { kind: 'file', fileId: randomUUID(), parsing: 'queued' });
    const entries = [
      entry('Reference handbook', { kind: 'file', fileId: randomUUID() }),
      pending,
      entry('Meeting notes'),
      entry('Password PDF', { parsing: 'failed', failure: 'encrypted' }),
      entry('Provider interruption', { parsing: 'failed', failure: 'provider', canRetry: true }),
      entry('Scanned report', { parsing: 'ocr-unavailable' }),
    ];
    const env = await environment(t, { entries });
    const { page, library } = env;
    const rows = library.getByRole('list', { name: 'Knowledge entries' });
    await rows.getByRole('heading', { name: 'Meeting notes' }).waitFor();
    assert.equal(await rows.getByRole('listitem').count(), 6);
    await rows
      .getByRole('listitem')
      .filter({ hasText: 'Reference handbook' })
      .getByText('Ready', { exact: true })
      .waitFor();
    await rows.getByRole('listitem').filter({ hasText: 'Meeting notes' }).getByText('Ready', { exact: true }).waitFor();
    await rows.getByText('Queued', { exact: true }).waitFor();
    await rows.getByText('OCR unavailable', { exact: true }).waitFor();
    assert.equal(await page.getByText('Nothing indexed yet', { exact: true }).count(), 0);
    const encrypted = rows.getByRole('listitem').filter({ hasText: 'Password PDF' });
    await encrypted.getByText('Reason: encrypted').waitFor();
    assert.equal(await encrypted.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
    Object.assign(pending, { parsing: 'parsing' });
    await rows.getByText('Parsing', { exact: true }).waitFor();
    Object.assign(pending, { parsing: 'ready' });
    await rows
      .getByRole('listitem')
      .filter({ hasText: 'Processing report' })
      .getByText('Ready', { exact: true })
      .waitFor();
    await rows.getByRole('button', { name: 'Retry', exact: true }).click();
    await rows
      .getByRole('listitem')
      .filter({ hasText: 'Provider interruption' })
      .getByText('Queued', { exact: true })
      .waitFor();
    Object.assign(
      entries.find(item => item.title === 'Provider interruption'),
      {
        parsing: 'failed',
        failure: 'provider',
        canRetry: true,
      },
    );
    await rows
      .getByRole('listitem')
      .filter({ hasText: 'Provider interruption' })
      .getByText('Failed', { exact: true })
      .waitFor();
    await captureBuilderScreenshot(page, 'knowledge-library');
    assert.equal(env.listReads, 4, 'only initial and mutation reads traverse the cursor pages');
    assert.ok(
      env.documentReads().some(request => request.path.endsWith(pending.documentId)),
      'pending entries are checked',
    );
  },
);

test(
  'empty Knowledge offers real actions and validates new notes with automatic Knowledge off',
  { timeout: 60000 },
  async t => {
    const { page, library, entries } = await environment(t, { enabled: false });
    await library.getByText('No personal entries yet').waitFor();
    for (const name of ['Add note', 'Add from Files', 'Upload files', 'Connect a source'])
      await library.getByRole('button', { name, exact: true }).waitFor();
    await library.getByRole('button', { name: 'Add note', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a note', exact: true });
    await dialog.getByRole('button', { name: 'Add note', exact: true }).click();
    assert.equal(await dialog.getByLabel('Title', { exact: true }).getAttribute('aria-invalid'), 'true');
    assert.equal(await dialog.getByLabel('Note text', { exact: true }).getAttribute('aria-invalid'), 'true');
    assert.equal(await dialog.getByLabel('Title', { exact: true }).getAttribute('maxlength'), '512');
    assert.equal(entries.length, 0);
    await dialog.getByLabel('Title', { exact: true }).fill('  New note  ');
    await dialog.getByLabel('Note text', { exact: true }).fill('Bring the release checklist.');
    await dialog.getByRole('button', { name: 'Add note', exact: true }).click();
    await library.getByRole('heading', { name: 'New note', exact: true }).waitFor();
    assert.equal(entries[0].title, 'New note');
    assert.equal(await library.getByText('No personal entries yet').count(), 0);
    await library.getByRole('button', { name: 'Add from Files', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Add a file from Files' })
      .getByRole('button', { name: 'Reference handbook.txt' })
      .click();
    const add = page.getByRole('dialog', { name: /Add.*Reference handbook.txt.*to Knowledge/ });
    await add.getByRole('button', { name: /^Add/ }).click();
    await add.getByRole('button', { name: 'Done', exact: true }).click();
    await library.getByRole('heading', { name: 'Reference handbook.txt' }).waitFor();
  },
);

test('keyword search shows source passages and empty results without model requests', { timeout: 60000 }, async t => {
  const { page, library, requests } = await environment(t, { entries: [entry('Team handbook')] });
  await library.getByRole('searchbox', { name: 'Search Knowledge' }).fill('manager');
  await library.getByRole('button', { name: 'Search', exact: true }).click();
  const hits = library.getByRole('list', { name: 'Matching passages' });
  await hits.getByText('Team handbook', { exact: true }).waitFor();
  await hits.getByText('Handbook policy: ask your manager for leave.').waitFor();
  await hits.getByText('Leave policy · Page 2').waitFor();
  assert.ok(requests.some(request => request.method === 'GET' && request.query === 'query=manager'));
  await library.getByRole('searchbox', { name: 'Search Knowledge' }).fill('unmatched');
  await library.getByRole('button', { name: 'Search', exact: true }).click();
  await library.getByText('No matching passages.').waitFor();
  await library.getByRole('searchbox', { name: 'Search Knowledge' }).fill('');
  await library.getByRole('heading', { name: 'Team handbook', exact: true }).waitFor();
  assert.equal(await page.getByText('Nothing indexed yet').count(), 0);
});

test(
  'edits notes and retitles files with revision checks; stale edit and remove keep the entry',
  { timeout: 60000 },
  async t => {
    const note = entry('Team handbook'),
      file = entry('Old file title', { kind: 'file', fileId: randomUUID() });
    const { page, library, entries, requests } = await environment(t, { entries: [note, file] });
    await library.getByRole('button', { name: 'Edit Team handbook', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Edit Knowledge entry' });
    await dialog.getByLabel('Note text').fill('Revised policy: ask the team lead.');
    await dialog.getByLabel('Title', { exact: true }).fill('New handbook');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await library.getByRole('heading', { name: 'New handbook', exact: true }).waitFor();
    const save = requests.find(request => request.method === 'PUT' && request.path.endsWith(note.documentId));
    assert.equal(save.body.expectedRevisionId, note.revisionId);
    assert.equal(save.body.input.text, 'Revised policy: ask the team lead.');
    await library.getByRole('button', { name: 'Edit Old file title', exact: true }).click();
    await dialog.getByLabel('Title', { exact: true }).fill('New file title');
    assert.equal(await dialog.getByLabel('Note text').count(), 0);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await library.getByRole('heading', { name: 'New file title', exact: true }).waitFor();
    await library.getByRole('button', { name: 'Edit New handbook', exact: true }).click();
    await dialog.getByLabel('Title', { exact: true }).fill('Stale title');
    entries[0].revisionId = randomUUID();
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await dialog.getByText(/This entry changed while you were working/).waitFor();
    assert.equal(entries[0].title, 'New handbook');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await library.getByRole('button', { name: 'Refresh entries', exact: true }).click();
    await library.getByRole('button', { name: 'Remove New handbook', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Remove New handbook?' });
    await dialog.getByText('This removes the Knowledge entry. The original in Files is not deleted.').waitFor();
    entries[0].revisionId = randomUUID();
    await dialog.getByRole('button', { name: 'Remove entry', exact: true }).click();
    await dialog.getByText(/This entry changed while you were working/).waitFor();
    assert.equal(entries.length, 2);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await library.getByRole('button', { name: 'Refresh entries', exact: true }).click();
    await library.getByRole('button', { name: 'Remove New handbook', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove entry', exact: true }).click();
    await library.getByRole('heading', { name: 'New handbook', exact: true }).waitFor({ state: 'detached' });
    assert.equal(entries.length, 1);
    assert.equal(
      requests.some(request => /\/files\/.*\/(trash|delete)/.test(request.path)),
      false,
    );
  },
);

test('another member sees no personal entries or search passages', { timeout: 60000 }, async t => {
  const env = await environment(t, { entries: [entry('Private handbook')], otherMember: true });
  const { page, library } = env;
  try {
    await library.getByText('No personal entries yet').waitFor();
    assert.equal(await library.getByText('Private handbook').count(), 0);
    await library.getByRole('searchbox', { name: 'Search Knowledge' }).fill('manager');
    const searched = page.waitForResponse(response => response.url().includes('/knowledge/search?query=manager'));
    await library.getByRole('button', { name: 'Search', exact: true }).click();
    assert.equal((await searched).status(), 200);
    await library.getByText('No matching passages.').waitFor();
  } catch (error) {
    await captureBrowserFailure(page, 'knowledge-member-search');
    throw error;
  }
});

test('stalled entries stop automatic checks and manual Refresh restarts them', { timeout: 60000 }, async t => {
  const pending = entry('Stalled report', { parsing: 'queued' });
  const env = await environment(t, { entries: [pending, entry('Ready handbook')], clock: true });
  const { page, library } = env;
  await page.clock.fastForward(300000);
  await library.getByText('Automatic checks stopped. Refresh entries to check again.').waitFor();
  assert.ok(env.documentReads().length <= 12, 'automatic document reads have an upper bound');
  assert.equal(env.listReads, 2, 'automatic checks do not reload the library');
  await captureBuilderScreenshot(page, 'knowledge-polling-stopped');
  const stopped = env.documentReads().length;
  await page.clock.fastForward(300000);
  assert.equal(env.documentReads().length, stopped);
  pending.parsing = 'ready';
  await page.clock.resume();
  await library.getByRole('button', { name: 'Refresh entries', exact: true }).click();
  await library.getByText('Queued', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(env.listReads, 4, 'manual Refresh reloads both cursor pages');
  assert.equal(await library.getByText('Automatic checks stopped. Refresh entries to check again.').count(), 0);
  await captureBuilderScreenshot(page, 'knowledge-polling-refreshed');
});
