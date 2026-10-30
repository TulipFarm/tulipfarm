import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSlackRender } from '../src/slack-render.ts';

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
