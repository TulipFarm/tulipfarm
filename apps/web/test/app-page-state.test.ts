import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  componentStatus,
  confirming,
  initialPage,
  pageLocked,
  pageReducer,
  sourcesRead,
  type PageContent,
  type PageEvent,
  type PageView,
} from '../src/features/apps/pages/state.ts';

const content = (draft = false): PageContent => ({
  draft,
  navigation: [{ slug: 'deals', title: 'Deals' }],
  page: {
    slug: 'deals',
    title: 'Deals',
    surface: [],
    actions: [
      { id: 'save', label: 'Save', kind: 'run-workflow', availability: 'available' },
      { id: 'open', label: 'Open', kind: 'open-page', availability: 'available' },
      { id: 'record', label: 'Record', kind: 'open-record', availability: 'available' },
      { id: 'ask', label: 'Ask', kind: 'ask-agent', availability: 'available' },
    ],
  },
});

const run = (events: PageEvent[], view: PageView = initialPage('a')) => events.reduce(pageReducer, view);
const opened = (draft = false) => run([{ type: 'opened', key: 'a', content: content(draft) }]);
const press = (
  requestId: string,
  context: Record<string, unknown> = { name: 'Acme' },
  actionId = 'save',
): PageEvent => ({
  type: 'press',
  actionId,
  context,
  requestId,
});

test('each source keeps its own state, and a component shows the one that most stops it', () => {
  const view = run(
    [
      {
        type: 'loaded',
        model: null,
        sources: {
          open: { status: 'ready', loadedAt: '2026-01-01T10:00:00.000Z' },
          none: { status: 'empty', loadedAt: '2026-01-01T10:00:02.000Z' },
          hidden: { status: 'restricted', loadedAt: '2026-01-01T10:00:01.000Z' },
        },
      },
    ],
    opened(),
  );
  assert.equal(view.kind, 'open');
  if (view.kind !== 'open') return;
  assert.equal(view.data.loadedAt, '2026-01-01T10:00:02.000Z');
  assert.equal(componentStatus(view.data, ['open']), 'ready');
  assert.equal(componentStatus(view.data, ['none']), 'empty');
  assert.equal(componentStatus(view.data, ['open', 'hidden']), 'restricted');
  assert.equal(componentStatus(view.data, ['gone']), 'unavailable');
  const first = opened();
  assert.equal(first.kind, 'open');
  if (first.kind !== 'open') return;
  assert.equal(componentStatus(first.data, ['open']), 'loading');
  const failed = run([{ type: 'load-failed', status: 503 }], first);
  assert.equal(failed.kind, 'open');
  if (failed.kind !== 'open') return;
  assert.equal(componentStatus(failed.data, ['open']), 'failed');
});

test('a first 404 is an unknown page, but a 404 or 403 after opening means access ended for good', () => {
  assert.equal(run([{ type: 'open-failed', key: 'a', status: 404, message: '' }]).kind, 'not-found');
  assert.equal(run([{ type: 'open-failed', key: 'a', status: 503, message: 'Down' }]).kind, 'failed');
  assert.equal(run([{ type: 'open-failed', key: 'a', status: 404, message: '' }], opened()).kind, 'ended');
  assert.equal(run([{ type: 'load-failed', status: 403 }], opened()).kind, 'ended');
  assert.equal(
    run([press('r1'), { type: 'refused', actionId: 'save', status: 404, message: '' }], opened()).kind,
    'ended',
  );
  const ended = run([{ type: 'load-failed', status: 404 }], opened());
  assert.deepEqual(run([{ type: 'open', key: 'b' }, { type: 'load' }, press('r2')], ended), { kind: 'ended' });
});

test('an answer for a page the viewer already left changes nothing', () => {
  const view = run([
    { type: 'open', key: 'b' },
    { type: 'opened', key: 'a', content: content() },
  ]);
  assert.deepEqual(view, { kind: 'opening', key: 'b' });
});

test('a press locks the page until the server answers, and a second press waits', () => {
  const sent = run([press('r1'), press('r2')], opened());
  assert.equal(pageLocked(sent), true);
  assert.equal(sent.kind, 'open');
  if (sent.kind !== 'open') return;
  assert.equal(sent.presses.save?.requestId, 'r1');
  const done = run([{ type: 'accepted', actionId: 'save', result: { kind: 'run-workflow', runId: 'run' } }], sent);
  assert.equal(pageLocked(done), false);
  assert.equal(done.kind, 'open');
  if (done.kind !== 'open') return;
  assert.equal(done.presses.save?.state, 'running');
});

test('pressing again after a failure with the same values retries with the same request ID', () => {
  const failed = run(
    [press('r1'), { type: 'refused', actionId: 'save', status: 400, message: 'Check the details and try again.' }],
    opened(),
  );
  assert.equal(failed.kind, 'open');
  if (failed.kind !== 'open') return;
  assert.deepEqual(
    { state: failed.presses.save?.state, message: failed.presses.save?.message },
    { state: 'failed', message: 'Check the details and try again.' },
  );
  const retried = run([press('r2')], failed);
  assert.equal(retried.kind, 'open');
  if (retried.kind !== 'open') return;
  assert.equal(retried.presses.save?.requestId, 'r1');
  const changed = run([press('r3', { name: 'Globex' })], failed);
  assert.equal(changed.kind, 'open');
  if (changed.kind !== 'open') return;
  assert.equal(changed.presses.save?.requestId, 'r3');
});

test('in a draft a press waits for the editor to confirm, and cancelling leaves the button idle', () => {
  const asked = run([press('r1')], opened(true));
  assert.equal(confirming(asked)?.requestId, 'r1');
  assert.equal(pageLocked(asked), false);
  const sent = run([{ type: 'confirm', actionId: 'save' }], asked);
  assert.equal(pageLocked(sent), true);
  const cancelled = run([{ type: 'cancel', actionId: 'save' }], asked);
  assert.equal(cancelled.kind, 'open');
  if (cancelled.kind !== 'open') return;
  assert.deepEqual(cancelled.presses, {});
});

test('in a draft only workflow and agent actions ask to confirm; opening a page or record goes straight through', () => {
  const states = (view: PageView) =>
    view.kind === 'open' ? Object.fromEntries(Object.values(view.presses).map(p => [p.actionId, p.state])) : null;
  const draft = run([press('r1', {}, 'open'), press('r2', {}, 'record'), press('r3', {}, 'ask')], opened(true));
  assert.deepEqual(states(draft), { open: 'sent', record: 'sent', ask: 'confirming' });
  assert.deepEqual(states(run([press('r4', {}, 'save')], opened(true))), { save: 'confirming' });
  assert.deepEqual(states(run([press('r5', {}, 'ask')], opened(false))), { ask: 'sent' });
});

test('a component reads the sources its own bindings name, including a list template', () => {
  assert.deepEqual(
    sourcesRead({
      text: { '@path': '/sources/open/value/total' },
      children: { componentId: 'row', path: '/sources/a~1b/value/records' },
      label: { '@path': '/params/row' },
    }),
    ['open', 'a/b'],
  );
  assert.deepEqual(sourcesRead({ text: 'Plain' }), []);
});
