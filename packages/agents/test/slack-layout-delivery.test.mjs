import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutProtocol, tulipfarmCatalogId } from '@tulipfarm/conversations/layout-contracts';
import { reportText, slackLayoutPresentation } from '../src/slack-layout-delivery.ts';
import { parseSlackRender } from '../src/slack-render.ts';

const rendered = parseSlackRender(
  {
    placement: 'chat',
    title: 'Q3 report',
    summary: 'Revenue rose.',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Summary blocks only' } }],
    report: '# Q3\n\n| Region | Revenue |\n| --- | --- |\n| EU | $90 |',
  },
  { interactive: true },
);
const layout = { protocol: layoutProtocol, catalogId: tulipfarmCatalogId, ...rendered.input };

test('a report without a canvas is posted in full instead of its summary blocks', async () => {
  const message = await slackLayoutPresentation({
    layout,
    token: 'xoxb-test',
    canvas: false,
    audience: { channel: 'C1' },
    feedback: false,
  });
  const text = JSON.stringify(message.blocks);
  assert.match(text, /\| EU \| \$90 \|/);
  assert.doesNotMatch(text, /Summary blocks only/);
});

test('a long report is cut at a paragraph with a note', () => {
  const paragraph = 'x'.repeat(4000);
  const cut = reportText([paragraph, paragraph, paragraph, paragraph].join('\n\n'));
  assert.ok(cut.length <= 12000);
  assert.match(cut, /^x{4000}\n\nx{4000}\n\n_The report is cut here/);
});
