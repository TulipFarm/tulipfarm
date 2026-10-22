import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5464';
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const definition = {
  version: 1,
  name: 'Review',
  trigger: { kind: 'manual' },
  steps: [{ id: 'review', kind: 'human', prompt: 'Review it.', timeoutSeconds: 86400 }],
};
const workflow = { id: id('a'), revision: id('b'), definition, archivedAt: null, enabled: false, activeRevision: null };
const other = { ...workflow, id: id('c'), definition: { ...definition, name: 'Other' } };
const archived = { ...other, archivedAt: '2026-10-10T00:00:00Z' };
const runId = id('d');
let server, browser;

before(async () => {
  server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5464', '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  for (
    let i = 0;
    !(await fetch(origin).then(
      r => r.ok,
      () => false,
    ));
    i++
  ) {
    assert.ok(i < 300 && server.exitCode === null, 'Vite must start');
    await delay(100);
  }
  browser = await chromium.launch();
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    server?.kill('SIGTERM');
  }
});

async function mount(t, input = {}) {
  const page = await browser.newPage();
  t.after(async () => {
    try {
      await page.evaluate(() => window.harness?.close());
    } finally {
      await page.close();
    }
  });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  t.after(() => assert.deepEqual(errors, []));
  await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: '<div id="hook"></div>' }));
  await page.goto(origin);
  await page.evaluate(async input => {
    const { mountEditingSession } = await import('/test/workflow-editing-session.fixture.mjs');
    window.harness = await mountEditingSession(input);
  }, input);
  return {
    page,
    snapshot: () => page.evaluate(() => window.harness.snapshot()),
    call: (method, ...args) => page.evaluate(({ method, args }) => window.harness.call(method, args), { method, args }),
    update: changes => page.evaluate(changes => window.harness.update(changes), changes),
  };
}

test('draft identity, form/JSON edits, save acceptance and observed revisions cross the screen hook', async t => {
  const h = await mount(t, { workflows: [workflow, other] });
  const initial = await h.snapshot();
  assert.equal(initial.view, 'list');
  assert.equal(initial.dirty, false);
  assert.equal(initial.draftBaseRevision, null);
  await h.call('choose', workflow);
  assert.equal((await h.snapshot()).draftId, workflow.id);
  await h.call('toggleAdvanced');
  assert.equal((await h.snapshot()).dirty, false, 'entering JSON alone is not an edit');
  await h.call('editJSON', '{');
  assert.match(await h.call('toggleAdvanced'), /JSON edits are retained/);
  assert.equal((await h.snapshot()).advanced, '{');
  await h.call('editJSON', JSON.stringify({ ...definition, name: 'Local JSON' }));
  assert.equal(await h.call('toggleAdvanced'), '');
  assert.equal((await h.snapshot()).draft.name, 'Local JSON');
  const newer = { ...workflow, revision: id('e'), definition: { ...definition, name: 'Remote' } };
  await h.update({ workflows: [newer, other] });
  let state = await h.snapshot();
  assert.equal(state.selected.revision, newer.revision);
  assert.equal(state.draftBaseRevision, workflow.revision);
  assert.equal(state.draft.name, 'Local JSON');
  await h.call('observed', { ...newer, enabled: true, activeRevision: newer.revision });
  state = await h.snapshot();
  assert.equal(state.selected.activeRevision, newer.revision);
  assert.equal(state.draftBaseRevision, workflow.revision);
  assert.equal(state.dirty, true);
  await h.call('toggleAdvanced');
  await h.call('saved', { ...newer, revision: id('f'), activeRevision: newer.revision });
  state = await h.snapshot();
  assert.equal(state.draftId, workflow.id);
  assert.equal(state.draftBaseRevision, id('f'));
  assert.equal(state.draft.name, 'Remote');
  assert.equal(state.advanced, null);
  assert.equal(state.dirty, false);
  assert.equal(state.selected.activeRevision, newer.revision);
  await h.call('editDraft', { ...state.draft, name: 'Form draft' });
  assert.equal((await h.snapshot()).dirty, true);
  await h.update({ workflows: null });
  assert.equal((await h.snapshot()).selected.revision, id('f'), 'loading and failed refresh retain selection');
  await h.update({ workflows: [] });
  state = await h.snapshot();
  assert.equal(state.selected, null);
  assert.equal(state.draft.name, 'Form draft');
  assert.equal(state.draftBaseRevision, id('f'));
});

test('list selection, explicit reload and creation own the whole dirty-switch decision', async t => {
  const h = await mount(t, { initialProvider: true, workflows: [workflow, other] });
  assert.equal((await h.snapshot()).view, 'definition');
  await h.call('choose', workflow);
  await h.call('editDraft', { ...definition, name: 'Local' });
  await h.call('showView', 'list');
  await h.call('choose', other);
  let state = await h.snapshot();
  assert.equal(state.switching, true);
  assert.equal(state.selected.id, workflow.id);
  const opened = state.events.filter(([event]) => event === 'open').length;
  await h.call('cancelSwitch');
  state = await h.snapshot();
  assert.equal(state.draft.name, 'Local');
  assert.equal(state.events.filter(([event]) => event === 'open').length, opened);
  await h.call('choose', workflow);
  assert.equal((await h.snapshot()).switching, true, 'explicit reload also confirms a dirty same-workflow draft');
  await h.call('confirmSwitch');
  state = await h.snapshot();
  assert.equal(state.draft.name, definition.name);
  assert.equal(state.view, 'definition');
  assert.equal(state.dirty, false);
  await h.call('toggleAdvanced');
  await h.call('editJSON', ' ');
  await h.call('choose', null);
  assert.equal((await h.snapshot()).switching, true);
  await h.call('confirmSwitch');
  state = await h.snapshot();
  assert.equal(state.selected, null);
  assert.notEqual(state.draftId, workflow.id);
  assert.equal(state.draftBaseRevision, null);
  assert.equal(state.advanced, null);
  assert.equal(state.dirty, false);
  const draftId = state.draftId;
  await h.call('choose', null);
  assert.notEqual((await h.snapshot()).draftId, draftId);
});

test('link restoration waits for reads, preserves same-workflow drafts and avoids link echoes', async t => {
  const link = { workflow: workflow.id, view: 'runs', run: runId };
  const h = await mount(t, { link });
  assert.deepEqual((await h.snapshot()).events, []);
  await h.update({ workflows: [workflow, other] });
  let state = await h.snapshot();
  assert.equal(state.selected.id, workflow.id);
  assert.equal(state.view, 'runs');
  assert.deepEqual(state.events, [['open'], ['run', runId]]);
  await h.call('showView', 'definition');
  await h.call('editDraft', { ...definition, name: 'Kept draft' });
  await h.update({ link });
  state = await h.snapshot();
  assert.equal(state.draft.name, 'Kept draft');
  assert.equal(state.switching, false);
  const eventCount = state.events.length;
  await h.update({ link: { ...link } });
  assert.equal((await h.snapshot()).events.length, eventCount);
  await h.update({ link: {} });
  state = await h.snapshot();
  assert.equal(state.view, 'list');
  assert.equal(state.draft.name, 'Kept draft');
  await h.call('showView', 'runs');
  state = await h.snapshot();
  assert.deepEqual(state.events.at(-1), ['link', link], 'the linked run survives view changes');
});

test('a different linked workflow confirms before reset; decline restores URL and accept keeps existing default-view timing', async t => {
  const h = await mount(t, { link: { workflow: workflow.id }, workflows: [workflow, other] });
  await h.call('editDraft', { ...definition, name: 'Kept draft' });
  const target = { workflow: other.id, view: 'runs', run: runId };
  await h.update({ link: target });
  let state = await h.snapshot();
  assert.equal(state.switching, true);
  assert.equal(state.selected.id, workflow.id);
  assert.equal(state.draft.name, 'Kept draft');
  assert.deepEqual(state.events.at(-1), ['link', { workflow: workflow.id }]);
  await h.call('cancelSwitch');
  assert.equal((await h.snapshot()).draft.name, 'Kept draft');
  await h.update({ link: target });
  await h.call('confirmSwitch');
  state = await h.snapshot();
  assert.equal(state.selected.id, other.id);
  assert.equal(state.draftId, other.id);
  assert.equal(state.draftBaseRevision, other.revision);
  assert.equal(state.view, 'definition', 'confirmed dirty navigation opens the default view, as before');
  assert.equal(state.dirty, false);
  assert.deepEqual(state.events.at(-1), ['link', { workflow: other.id }]);
});

test('archived lookup, missing links and failed lookup keep their existing feedback and reconciliation', async t => {
  const h = await mount(t, { link: { workflow: archived.id, view: 'runs' }, workflows: [workflow] });
  assert.deepEqual((await h.snapshot()).events, [['lookup']]);
  await h.update({ archivedState: 'ready', archivedWorkflows: [archived] });
  let state = await h.snapshot();
  assert.equal(state.view, 'runs');
  assert.equal(state.selected.id, archived.id);
  assert.deepEqual(state.events.slice(1), [['archived'], ['open']]);
  const updated = { ...archived, generation: 2 };
  await h.update({ workflows: [], archivedWorkflows: [updated] });
  assert.equal((await h.snapshot()).selected.generation, 2);
  await h.update({ link: { workflow: id('e') } });
  state = await h.snapshot();
  assert.match(state.events.find(([event]) => event === 'message')[1], /not available to you/);
  assert.equal(state.selected.id, archived.id);
  await h.update({ archivedState: 'error', archivedWorkflows: null, link: { workflow: id('f') } });
  assert.match(
    (await h.snapshot()).events.filter(([event]) => event === 'message').at(-1)[1],
    /archived workflows did not load/,
  );
  const parsed = await h.page.evaluate(async () => {
    const { workflowPageSearch } = await import('/src/features/workflows/page-search.ts');
    return workflowPageSearch.parse({ workflow: 'invalid', run: 'invalid', view: 'invalid' });
  });
  await h.update({ link: parsed });
  assert.equal((await h.snapshot()).view, 'list');
});

test('access loss and archive reset drafts without also acting like a selection change', async t => {
  const h = await mount(t, { workflows: [workflow] });
  await h.call('choose', workflow);
  await h.call('openRun', runId);
  await h.call('editDraft', { ...definition, name: 'Private draft' });
  await h.call('toggleAdvanced');
  await h.call('clear');
  let state = await h.snapshot();
  assert.equal(state.selected, null);
  assert.equal(state.advanced, null);
  assert.equal(state.draftBaseRevision, null);
  assert.notEqual(state.draftId, workflow.id);
  assert.equal(state.dirty, false);
  assert.equal(state.view, 'runs', 'access loss does not perform the archive view change');
  assert.equal(state.events.filter(([event]) => event === 'open').length, 1);
  await h.call('choose', workflow);
  await h.call('archived');
  state = await h.snapshot();
  assert.equal(state.view, 'list');
  assert.equal(state.selected, null);
  assert.equal(state.dirty, false);
  assert.deepEqual(state.events.at(-1), ['link', {}]);
});
