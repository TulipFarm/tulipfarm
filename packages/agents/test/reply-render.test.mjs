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
  use,
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

const layoutTurn = async (t, format, replies, { route = nativeRoutes[format], layout = true, progress } = {}) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (isCompletionRequest(body)) return Response.json(completionReply(format));
    requests.push(body);
    assert.ok(replies.length, 'no further model round expected');
    return Response.json(nativeReply(format, replies.shift()));
  });
  const result = await inferWithTools(
    route,
    [{ role: 'user', text: 'Which cache should we use?' }],
    () => assert.fail('No business tool expected'),
    undefined,
    false,
    null,
    { layout, ...(progress ? { progress } : {}) },
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

const slack = { slack: { interactive: true } };
const slackReply = {
  placement: 'chat',
  title: 'Hello',
  summary: 'Warm greeting and offer to help with one question',
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Hello! What can I help you with today?' } }],
};
const slackRender = { calls: [{ name: 'slack_render', input: slackReply }] };

test('on the web a plain-text answer is final as streamed, with no second request for a layout', async t => {
  const statuses = [];
  const { result, requests } = await layoutTurn(t, 'anthropic', [{ text: 'Use Valkey.\n\n1. Fast\n2. Open' }], {
    progress: update => statuses.push(update.status),
  });
  assert.deepEqual(result, { text: 'Use Valkey.\n\n1. Fast\n2. Open' });
  assert.equal(requests.length, 1);
  assert.equal(statuses.at(-1), 'done');
  assert.ok(!statuses.includes('finishing'));
});

test('Slack: a plain-text answer gets one required request for a layout', async t => {
  const { result, requests } = await layoutTurn(t, 'anthropic', [{ text: 'Hello!' }, slackRender], { layout: slack });
  assert.equal(result.text, slackReply.summary);
  assert.deepEqual(result.layout.slack.blocks, slackReply.blocks);
  assert.match(lastText('anthropic', requests[1]), /calling slack_render/);
});

const requiredChoice = {
  anthropic: body => body.tool_choice,
  azure: body => body.tool_choice,
  responses: body => body.tool_choice,
  google: body => body.toolConfig.functionCallingConfig,
};
const forcedChoice = name => ({
  anthropic: { type: 'tool', name },
  azure: { type: 'function', function: { name } },
  responses: { type: 'function', name },
  google: { mode: 'ANY', allowedFunctionNames: [name] },
});
const autoChoice = { anthropic: { type: 'auto' }, azure: 'auto', responses: 'auto', google: { mode: 'AUTO' } };

for (const format of formats)
  test(`${format}: the Slack layout request after a plain-text answer requires the layout tool`, async t => {
    const route = { ...nativeRoutes[format], capabilities: { toolChoice: 'forced' } };
    const { requests } = await layoutTurn(t, format, [{ text: 'Hello!' }, slackRender], { route, layout: slack });
    assert.deepEqual(requiredChoice[format](requests[0]), autoChoice[format]);
    assert.deepEqual(requiredChoice[format](requests[1]), forcedChoice('slack_render')[format]);
  });

test('a route that accepts only an automatic tool choice is asked for the layout in the message alone', async t => {
  const route = { ...nativeRoutes.azure, capabilities: { toolChoice: 'auto' } };
  const { result, requests } = await layoutTurn(t, 'azure', [{ text: 'Hello!' }, slackRender], {
    route,
    layout: slack,
  });
  assert.deepEqual(result.layout.slack.blocks, slackReply.blocks);
  assert.equal(requests[1].tool_choice, 'auto');
  assert.match(lastText('azure', requests[1]), /calling slack_render/);
  t.mock.restoreAll();

  // Claude Sonnet, Opus and Fable are catalogued with an automatic tool choice.
  const claude = await layoutTurn(t, 'anthropic', [{ text: 'Hello!' }, slackRender], { layout: slack });
  assert.deepEqual(claude.requests[1].tool_choice, { type: 'auto' });
});

const writtenCall = `call slack_render with placement is chat title is Hello summary is Warm greeting and offer to help with one question. blocks is ${JSON.stringify(slackReply.blocks)}`;

test('Slack: a slack_render call written as prose is read back as the layout, never posted as text', async t => {
  const { result, requests } = await layoutTurn(t, 'azure', [{ text: writtenCall }], { layout: slack });
  assert.equal(requests.length, 1);
  assert.equal(result.text, slackReply.summary);
  assert.deepEqual(result.layout.slack.blocks, slackReply.blocks);
  assert.doesNotMatch(JSON.stringify(result), /call slack_render/);
});

test('Slack: a slack_render call written as JSON is read back as the layout', async t => {
  const text = `slack_render ${JSON.stringify({ name: 'slack_render', arguments: slackReply })}`;
  const { result, requests } = await layoutTurn(t, 'anthropic', [{ text }], { layout: slack });
  assert.equal(requests.length, 1);
  assert.deepEqual(result.layout.slack.blocks, slackReply.blocks);
});

test('Slack: a layout call written as text without a usable layout requires the real call next', async t => {
  const { result, requests } = await layoutTurn(
    t,
    'azure',
    [{ text: 'call slack_render with title is Hello' }, { calls: [{ name: 'slack_render', input: slackReply }] }],
    { layout: slack },
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].tool_choice, { type: 'function', function: { name: 'slack_render' } });
  assert.deepEqual(result.layout.slack.blocks, slackReply.blocks);
});

test('Slack: plain text after the required layout request is laid out as the answer, not posted bare', async t => {
  const { result, requests } = await layoutTurn(t, 'azure', [{ text: 'Hello!' }, { text: 'Hello! How can I help?' }], {
    layout: slack,
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].tool_choice, { type: 'function', function: { name: 'slack_render' } });
  assert.deepEqual(result.layout.slack.blocks, [{ type: 'markdown', text: 'Hello! How can I help?' }]);
  assert.equal(result.layout.placement, 'chat');
});

test('chat completions resend a plain-text answer without an empty tool_calls list', async t => {
  const { requests } = await layoutTurn(t, 'azure', [{ text: 'Hello!' }, slackRender], { layout: slack });
  const answer = requests[1].messages.find(message => message.role === 'assistant');
  assert.deepEqual(answer, { role: 'assistant', content: 'Hello!' });
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
      calls: [{ name: 'reply_render', input: chatReply }, use('web.search', { query: 'tulips' })],
    },
    render(chatReply),
  ]);
  assert.deepEqual(result, { text: chatReply.summary, layout: chatReply });
  assert.match(toolResults('anthropic', requests[1])[0].output, /call reply_render alone/);
});

test('Slack: a layout call written as text on the tool-free final step is read back, not posted', async t => {
  let rounds = 0,
    finals = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (isCompletionRequest(body)) return Response.json(completionReply('azure'));
    rounds++;
    assert.ok(rounds <= 5, 'loop is bounded');
    if (!body.tools) {
      finals++;
      return Response.json(nativeReply('azure', { text: writtenCall }));
    }
    return Response.json(nativeReply('azure', { calls: [use('web.fetch', { url: 'https://example.com/same' })] }));
  });
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Hey' }],
    async () => ({}),
    undefined,
    false,
    null,
    { layout: slack },
  );
  assert.deepEqual(result.layout.slack.blocks, slackReply.blocks);
  assert.doesNotMatch(result.text, /call slack_render/);
  assert.equal(finals, 1);
});
