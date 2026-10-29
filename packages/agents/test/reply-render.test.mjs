import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { canvasDesignErrors, parseReplyRender } from '../src/reply-render.ts';
import {
  completionReply,
  formats,
  isCompletionRequest,
  lastText,
  nativeReply,
  nativeRoutes,
  offeredTools,
  toolResults,
} from './native-fixture.mjs';

const reply = (components, placement = 'canvas') => ({
  placement,
  title: 'Cache choice',
  summary: 'Valkey is the best default.',
  messages: [
    { version: 'v0.9.1', createSurface: { surfaceId: 'report', catalogId: 'tulipfarm/chat@1' } },
    { version: 'v0.9.1', updateComponents: { surfaceId: 'report', components } },
  ],
});
// A report with Callout, Metric, Chart, Card, Badge and List: no design problems.
const designed = [
  { id: 'root', component: 'Column', children: ['callout', 'metrics', 'chart', 'card'] },
  { id: 'callout', component: 'Callout', tone: 'success', title: 'Use Valkey', text: 'It is fast and open.' },
  { id: 'metrics', component: 'Row', children: ['best', 'cheap'] },
  { id: 'best', component: 'Metric', label: 'Best default', value: 'Valkey' },
  { id: 'cheap', component: 'Metric', label: 'Lowest cost', value: 'Memcached' },
  {
    id: 'chart',
    component: 'Chart',
    type: 'bar',
    title: 'Scores',
    category: 'name',
    series: [{ key: 'score', label: 'Score' }],
    rows: [{ name: 'Valkey', score: 9 }],
    max: 10,
  },
  { id: 'card', component: 'Card', title: 'Valkey', children: ['badge', 'list'] },
  { id: 'badge', component: 'Badge', text: 'Recommended', tone: 'success' },
  { id: 'list', component: 'List', children: ['item'] },
  { id: 'item', component: 'Text', text: 'Redis compatible' },
];
const replace = (id, component) => designed.map(item => (item.id === id ? { id, ...component } : item));
const visualKinds = /kinds of visual component/;

test('a designed canvas report and any chat layout have no design errors', () => {
  assert.deepEqual(canvasDesignErrors(reply(designed)), []);
  const wall = [{ id: 'root', component: 'Text', text: `## Report\n${'word '.repeat(200)}` }];
  assert.equal(canvasDesignErrors(reply(wall)).length, 3);
  assert.deepEqual(canvasDesignErrors(reply(wall, 'chat')), []);
});

test('each canvas design rule names the component that broke it', () => {
  const cases = [
    [replace('item', { component: 'Text', text: '# Strengths' }), /^item: Text contains a Markdown heading/],
    [replace('callout', { component: 'Text', text: 'x'.repeat(301) }), /^callout: Text has 301 characters/],
    [replace('item', { component: 'Text', text: 'x'.repeat(91) }), /^item: List item has 91 characters/],
    [
      [
        ...replace('list', { component: 'List', children: ['item', 'a', 'b', 'c'] }),
        ...['a', 'b', 'c'].map(id => ({ id, component: 'Text', text: id })),
      ],
      /^list: List has 4 items/,
    ],
    [
      [
        ...replace('card', { component: 'Card', title: 'Valkey', children: ['badge', 'list', 'table'] }),
        {
          id: 'table',
          component: 'Table',
          label: 'Setup',
          columns: [{ key: 'note', label: 'Note' }],
          rows: [{ note: 'x'.repeat(81) }, { note: 'short' }],
        },
      ],
      /^table: 1 Table cells are longer than 80/,
    ],
    [
      replace('cheap', { component: 'Metric', label: 'Memcached', value: '7 / 10' }).map(item =>
        item.id === 'best' ? { ...item, value: '8.5/10' } : item,
      ),
      /^best, cheap: these Metrics repeat scores/,
    ],
  ];
  for (const [components, expected] of cases) {
    const errors = canvasDesignErrors(reply(components));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], expected);
  }
  const plain = [
    { id: 'root', component: 'Column', children: ['metric', 'text'] },
    { id: 'metric', component: 'Metric', label: 'Score', value: '8/10' },
    { id: 'text', component: 'Text', text: 'Short.' },
  ];
  assert.deepEqual(
    canvasDesignErrors(reply(plain)).map(error => visualKinds.test(error)),
    [true],
    'one score Metric without a Chart is not a repeat',
  );
});

test('the design option rejects only canvas design problems, and invalid layouts are always rejected', () => {
  const wall = reply([{ id: 'root', component: 'Text', text: 'x'.repeat(400) }]);
  const accepted = parseReplyRender(wall);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.text, `Valkey is the best default.\n\n${'x'.repeat(400)}`);
  const redesign = parseReplyRender(wall, { design: true });
  assert.equal(redesign.ok, false);
  assert.match(redesign.error, /reply_render again/);
  assert.match(redesign.error, /root: Text has 400 characters/);
  assert.equal(parseReplyRender({ ...wall, placement: 'chat' }, { design: true }).ok, true);
  assert.equal(parseReplyRender(reply(designed), { design: true }).ok, true);

  const unknown = parseReplyRender(reply([{ id: 'root', component: 'Image', src: 'https://example.com/a.png' }]));
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /^Invalid layout\. Fix these/);
  assert.match(parseReplyRender({ ...wall, title: '' }).error, /^Invalid layout: /);
});

const layoutTurn = async (t, format, replies) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (isCompletionRequest(body)) return Response.json(completionReply(format));
    requests.push(body);
    assert.ok(replies.length, 'no further model round expected');
    return Response.json(nativeReply(format, replies.shift()));
  });
  const result = await inferWithTools(
    nativeRoutes[format],
    [{ role: 'user', text: 'Which cache should we use?' }],
    () => assert.fail('No business tool expected'),
    undefined,
    false,
    null,
    { layout: true },
  );
  return { result, requests };
};
const render = input => ({ calls: [{ name: 'reply_render', input }] });
const chatReply = reply([{ id: 'root', component: 'Text', text: 'Valkey.' }], 'chat');
const invalidReply = reply([{ id: 'root', component: 'Image', src: 'https://example.com/a.png' }], 'chat');

for (const format of formats) {
  test(`${format}: an invalid layout goes back as a tool error, and a later valid one is the answer`, async t => {
    const { result, requests } = await layoutTurn(t, format, [render(invalidReply), render(chatReply)]);
    assert.deepEqual(result, { text: chatReply.summary, layout: chatReply });
    assert.equal(requests.length, 2);
    assert.ok(offeredTools(format, requests[0]).some(tool => tool.name === 'reply_render'));
    const [error] = toolResults(format, requests[1]);
    assert.match(error.output, /Invalid layout\. Fix these/);
  });
}

test('a plain-text answer gets one request for a layout; a second one is kept as text', async t => {
  const corrected = await layoutTurn(t, 'anthropic', [{ text: 'Use Valkey.' }, render(chatReply)]);
  assert.deepEqual(corrected.result, { text: chatReply.summary, layout: chatReply });
  assert.match(lastText('anthropic', corrected.requests[1]), /calling reply_render/);
  t.mock.restoreAll();

  const kept = await layoutTurn(t, 'anthropic', [{ text: 'Use Valkey.' }, { text: 'Valkey, really.' }]);
  assert.deepEqual(kept.result, { text: 'Valkey, really.' });
  assert.equal(kept.requests.length, 2);
});

test('after three invalid layouts the reply is saved as its summary with a layout-failed mark', async t => {
  const { result, requests } = await layoutTurn(t, 'anthropic', [
    render(invalidReply),
    render(invalidReply),
    render(invalidReply),
  ]);
  assert.deepEqual(result, { text: invalidReply.summary, layoutFailed: true });
  assert.equal(requests.length, 3);
});

test('a text-heavy canvas report is sent back for a redesign once, then accepted', async t => {
  const wall = reply([{ id: 'root', component: 'Text', text: `## Findings\n${'Valkey is fast. '.repeat(30)}` }]);
  const { result, requests } = await layoutTurn(t, 'anthropic', [render(wall), render(wall)]);
  assert.deepEqual(result, { text: wall.summary, layout: wall });
  assert.equal(requests.length, 2);
  const [error] = toolResults('anthropic', requests[1]);
  assert.equal(error.error, true);
  assert.match(error.output, /reads like a chat reply/);
});

test('reply_render must be called alone', async t => {
  const { result, requests } = await layoutTurn(t, 'anthropic', [
    {
      calls: [
        { name: 'reply_render', input: chatReply },
        { name: 'bud_state', input: { name: 'Bud', state: 'Waving' } },
      ],
    },
    render(chatReply),
  ]);
  assert.deepEqual(result, { text: chatReply.summary, layout: chatReply });
  assert.match(toolResults('anthropic', requests[1])[0].output, /call reply_render alone/);
});
