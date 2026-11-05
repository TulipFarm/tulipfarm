import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSlackRender, slackRenderFromAnswer, slackRenderFromText } from '../src/slack-render.ts';
import { recoverLayoutCall } from '../src/tool-text.ts';

const base = {
  placement: 'chat',
  title: 'Pipeline',
  summary: 'Pipeline is up.',
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: '*Pipeline is up*' } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'More' }, value: 'Show more' },
        { type: 'button', text: { type: 'plain_text', text: 'Docs' }, url: 'https://example.com' },
        { type: 'button', text: { type: 'plain_text', text: 'Target' }, action_id: 'open_modal:target' },
      ],
    },
  ],
  modals: [
    {
      id: 'target',
      title: 'Target',
      submit: 'Save',
      blocks: [
        {
          type: 'input',
          block_id: 'amount',
          label: { type: 'plain_text', text: 'Amount' },
          element: { type: 'plain_text_input' },
        },
      ],
    },
  ],
};

test('slack_render routes every interactive element through TulipFarm actions', () => {
  const result = parseSlackRender(base, { interactive: true });
  assert.equal(result.ok, true);
  const ids = result.input.slack.blocks[1].elements.map(element => element.action_id);
  assert.match(ids[0], /^tf_followup:/);
  assert.match(ids[1], /^tf_link:/);
  assert.match(ids[2], /^tf_modal:target:/);
  assert.match(result.input.slack.modals[0].blocks[0].element.action_id, /^tf_input:/);
});

test('slack_render allows only links where replies are not interactive', () => {
  const result = parseSlackRender(
    {
      ...base,
      modals: undefined,
      blocks: [base.blocks[0], { ...base.blocks[1], elements: [base.blocks[1].elements[0]] }],
    },
    { interactive: false },
  );
  assert.equal(result.ok, false);
});

test('slack_render rejects a modal button without a matching modal', () => {
  const result = parseSlackRender({ ...base, modals: undefined }, { interactive: true });
  assert.equal(result.ok, false);
});

test('a canvas reply needs a report', () => {
  assert.equal(parseSlackRender({ ...base, placement: 'canvas' }, { interactive: true }).ok, false);
  assert.equal(parseSlackRender({ ...base, placement: 'canvas', report: '# Report' }, { interactive: true }).ok, true);
});

test('charts are data_visualization blocks, not text drawings', () => {
  const chart = {
    type: 'data_visualization',
    title: 'Monthly revenue',
    chart: {
      type: 'line',
      axis_config: { categories: ['Jan', 'Feb'] },
      series: [
        {
          name: 'Revenue',
          data: [
            { label: 'Jan', value: 40 },
            { label: 'Feb', value: 52 },
          ],
        },
      ],
    },
  };
  assert.equal(
    parseSlackRender({ ...base, modals: undefined, blocks: [base.blocks[0], chart] }, { interactive: true }).ok,
    true,
  );
  const drawn = { type: 'markdown', text: '```\nJan: 40k |■■■■\nFeb: 52k |■■■■■\n```' };
  const result = parseSlackRender({ ...base, modals: undefined, blocks: [drawn] }, { interactive: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /data_visualization/);
});

test('a chart that breaks a limit says which one', () => {
  const chart = {
    type: 'data_visualization',
    title: 'Revenue',
    chart: {
      type: 'bar',
      axis_config: { categories: ['Jan', 'Feb'] },
      series: [{ name: 'Revenue', data: [{ label: 'Jan', value: 40 }] }],
    },
  };
  const result = parseSlackRender({ ...base, modals: undefined, blocks: [chart] }, { interactive: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /one data point per category/);
});

const greeting = [{ type: 'section', text: { type: 'mrkdwn', text: 'Hello! What can I help you with today?' } }];

test('a slack_render call written as prose is read back as valid input', () => {
  const input = slackRenderFromText(
    `call slack_render with placement is chat title is Hello summary is Warm greeting and offer to help with one question. blocks is ${JSON.stringify(greeting)}`,
  );
  assert.deepEqual(input, {
    placement: 'chat',
    title: 'Hello',
    summary: 'Warm greeting and offer to help with one question',
    blocks: greeting,
  });
  assert.equal(parseSlackRender(input, { interactive: true }).ok, true);
});

test('a slack_render call written as JSON is read back, wrapped or not, with a title and summary by default', () => {
  for (const text of [
    `slack_render(${JSON.stringify({ blocks: greeting })})`,
    JSON.stringify({ name: 'slack_render', arguments: JSON.stringify({ blocks: greeting }) }),
    `{"tool": "slack_render", "input": ${JSON.stringify({ blocks: greeting, title: 'Hi' })}}`,
  ]) {
    const input = slackRenderFromText(text);
    assert.deepEqual(input.blocks, greeting, text);
    assert.equal(parseSlackRender(input, { interactive: true }).ok, true, text);
  }
  assert.equal(slackRenderFromText(`slack_render(${JSON.stringify({ blocks: greeting })})`).title, 'Answer');
  assert.equal(
    slackRenderFromText(`slack_render(${JSON.stringify({ blocks: greeting })})`).summary,
    'Hello! What can I help you with today?',
  );
});

test('text without a Block Kit array is not read back as a layout call', () => {
  assert.equal(slackRenderFromText('call slack_render with title is Hello summary is A greeting'), undefined);
  assert.equal(slackRenderFromText('call slack_render with blocks is [not json'), undefined);
  assert.equal(recoverLayoutCall('{"blocks": "none"}', { list: 'blocks', fields: ['title'] }), undefined);
  assert.deepEqual(recoverLayoutCall('title: "Hi", blocks = []', { list: 'blocks', fields: ['title'] }), {
    blocks: [],
    title: 'Hi',
  });
});

test('a plain answer is laid out as one markdown block; a long one keeps the full text as a canvas report', () => {
  const short = slackRenderFromAnswer('  **Valkey** is the best default. It is fast.  ');
  assert.deepEqual(short, {
    placement: 'chat',
    title: 'Answer',
    summary: 'Valkey is the best default.',
    blocks: [{ type: 'markdown', text: '**Valkey** is the best default. It is fast.' }],
  });
  assert.equal(parseSlackRender(short, { interactive: true }).ok, true);

  const answer = `${'Valkey is fast. '.repeat(100)}\n\n`.repeat(10).trim();
  const long = slackRenderFromAnswer(answer);
  assert.equal(long.placement, 'canvas');
  assert.equal(long.report, answer);
  assert.ok(long.blocks[0].text.length < answer.length);
  assert.equal(parseSlackRender(long, { interactive: true }).ok, true);
});
