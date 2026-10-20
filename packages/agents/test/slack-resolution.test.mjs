import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverTools, parseToolCall } from '../src/tools.ts';

test('chat can resolve Slack channel and user names before choosing a destination', () => {
  assert.ok(discoverTools({ kind: 'chat' }).some(tool => tool.name === 'slack.resolve'));
  assert.deepEqual(
    parseToolCall({ tool: 'slack.resolve', kind: 'channel', name: '#slack-bot-test' }, { kind: 'chat' }),
    { tool: 'slack.resolve', kind: 'channel', name: '#slack-bot-test' },
  );
  assert.deepEqual(parseToolCall({ tool: 'slack.resolve', kind: 'user', name: '@dhruv' }, { kind: 'chat' }), {
    tool: 'slack.resolve',
    kind: 'user',
    name: '@dhruv',
  });
  assert.throws(() => parseToolCall({ tool: 'slack.resolve', kind: 'channel', name: '#' }, { kind: 'chat' }));
});
