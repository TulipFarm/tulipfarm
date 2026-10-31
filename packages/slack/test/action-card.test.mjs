import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slackActionCard } from '../dist/index.js';

const action = {
  id: 'a1',
  digest: 'd1',
  status: 'pending',
  expiresAt: '2026-10-31T12:00:00Z',
  channel: 'C0TECH',
};

test('shows the channel as a Slack mention and the message as formatted rich text', () => {
  const card = slackActionCard('w1', {
    ...action,
    action: { tool: 'slack.message.send', text: '**Summary**\n- Adds `packages.install`' },
  });
  assert.deepEqual(card.blocks[1], { type: 'section', text: { type: 'mrkdwn', text: 'Destination <#C0TECH>' } });
  assert.equal(card.blocks[2].type, 'rich_text');
  assert.match(JSON.stringify(card.blocks[2]), /"bold":true/);
  assert.match(card.text, /\*\*Summary\*\*/);
});

test('keeps reactions as exact plain text', () => {
  const card = slackActionCard('w1', {
    ...action,
    action: { tool: 'slack.reaction.add', reaction: 'eyes', messageTs: '1.000001' },
  });
  assert.deepEqual(card.blocks[2], {
    type: 'section',
    text: { type: 'plain_text', text: 'Reaction eyes on message 1.000001' },
  });
});
