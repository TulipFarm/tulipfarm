import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySlackOutboundMentions, postBotMessage, scanSlackOutboundMentions } from '../dist/index.js';

test('scans and rewrites cross-platform @handles while ignoring code, URLs, emails, scoped packages and broadcasts', () => {
  const input = [
    '🔀 New pull request in TulipFarm/deploy by @dhruvjainin',
    '',
    'cc **@DhruvJainIn**, (@alex_dev.), and <@U09KNOWN> vs <@U09OTHER>.',
    'Skip: dhruv@tulipfarm.ai, @tulipfarm/sprout, `@dhruvjainin`, ``@dhruvjainin``, \\@dhruvjainin, \\<@U09KNOWN>,',
    '@channel @here @everyone <!channel> <!here> <#C123> [PR by @dhruvjainin](https://github.com/TulipFarm/deploy/pull/185)',
    'https://github.com/@dhruvjainin',
    '```ts',
    'const author = "@dhruvjainin";',
    'const raw = "<@U09KNOWN>";',
    '```',
  ].join('\n');

  assert.deepEqual(
    scanSlackOutboundMentions(input).map(span => (span.kind === 'handle' ? `@${span.handle}` : `<@${span.userId}>`)),
    ['@dhruvjainin', '@DhruvJainIn', '@alex_dev', '<@U09KNOWN>', '<@U09OTHER>'],
  );

  const resolved = applySlackOutboundMentions(input, {
    byHandle: new Map([
      ['dhruvjainin', { externalId: 'U01DHRUV' }],
      ['alex_dev', { externalId: 'W02ALEX' }],
    ]),
    knownExternalIds: new Set(['U09KNOWN']),
  });

  assert.deepEqual([...resolved.mentionUserIds].sort(), ['U01DHRUV', 'U09KNOWN', 'W02ALEX']);
  assert.match(resolved.text, /by <@U01DHRUV>/);
  assert.match(resolved.text, /cc \*\*<@U01DHRUV>\*\*, \(<@W02ALEX>\.\), and <@U09KNOWN> vs <@U09OTHER>\./);
  assert.match(resolved.text, /dhruv@tulipfarm\.ai/);
  assert.match(resolved.text, /@tulipfarm\/sprout/);
  assert.match(resolved.text, /`@dhruvjainin`/);
  assert.match(resolved.text, /\[PR by @dhruvjainin\]\(https:\/\/github\.com\/TulipFarm\/deploy\/pull\/185\)/);
  assert.match(resolved.text, /https:\/\/github\.com\/@dhruvjainin/);
  assert.match(resolved.text, /const author = "@dhruvjainin";/);
});

test('ignores malformed target Slack IDs when applying outbound mentions', () => {
  const resolved = applySlackOutboundMentions('Ping @alice and @bob', {
    byHandle: new Map([
      ['alice', { externalId: 'not-a-slack-id' }],
      ['bob', { externalId: 'U01BOB' }],
    ]),
    knownExternalIds: new Set(),
  });
  assert.equal(resolved.text, 'Ping @alice and <@U01BOB>');
  assert.deepEqual([...resolved.mentionUserIds], ['U01BOB']);
});

test('postBotMessage renders authorized mentionUserIds as rich-text user pills and preserves fallback text', async () => {
  let body;
  const outcome = await postBotMessage({
    token: 'xoxb-test',
    channel: 'C123',
    text: 'New PR by <@U01DHRUV> (not <@U99UNKNOWN> or <!channel>)',
    mentionUserIds: new Set(['U01DHRUV']),
    fetcher: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ ok: true, channel: 'C123', ts: '1700000000.000001' });
    },
  });
  assert.equal(outcome.kind, 'sent');
  assert.equal(outcome.text, 'New PR by <@U01DHRUV> (not <@U99UNKNOWN> or <!channel>)');
  assert.equal(body.text, 'New PR by <@U01DHRUV> (not <@U99UNKNOWN> or <!channel>)');
  assert.deepEqual(body.blocks[0].elements[0].elements, [
    { type: 'text', text: 'New PR by ' },
    { type: 'user', user_id: 'U01DHRUV' },
    { type: 'text', text: ' (not <@U99UNKNOWN> or <!channel>)' },
  ]);
});
