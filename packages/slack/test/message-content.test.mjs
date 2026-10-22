import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeSlackContent,
  slackMessageText,
  matchesSlackSnapshot,
  slackThreadPrompt,
} from '../src/message-content.ts';
import { messageSchema, classifyEvent } from '../src/contracts.ts';
import { sameSlackMessage } from '../src/message-source.ts';

const normalize = message => normalizeSlackContent({ text: '', ...message });
const rich = text => [
  { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] },
];
const base = { type: 'message', channel: 'CTEST', user: 'UJOHN', ts: '1.000001' };

test('Grafana-style empty-text alerts preserve title, body, fields, footer and links', () => {
  const message = normalize({
    attachments: [
      {
        fallback: 'Alert fallback',
        title: 'FIRING: worker failed: 55P03',
        title_link: 'https://example.test/alert',
        text: 'Database lock could not be acquired',
        fields: [
          { title: 'Service', value: 'worker' },
          { title: 'Code', value: '55P03' },
        ],
        footer: 'Grafana',
        actions: [{ value: 'SECRET' }],
      },
    ],
  });
  assert.equal(message.text, '');
  assert.equal(
    message.content,
    'FIRING: worker failed: 55P03 (https://example.test/alert)\nDatabase lock could not be acquired\nService: worker\nCode: 55P03\nGrafana\nAlert fallback',
  );
  assert.equal(JSON.stringify(message).includes('SECRET'), false);
  assert.equal(normalize({ attachments: [{ fallback: 'Fallback-only alert' }] }).content, 'Fallback-only alert');
  assert.equal(
    normalize({ attachments: [{ fallback: 'The alert body', footer: 'Grafana' }] }).content,
    'Grafana\nThe alert body',
  );
});

test('blocks supplement rather than replace incomplete fallback text', () => {
  const message = normalize({
    text: 'Alert',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Failure' } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Database locked' },
        fields: [{ type: 'plain_text', text: 'Code: 55P03' }],
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Runbook' },
          url: 'https://example.test/runbook',
          value: 'DO NOT EXPOSE',
        },
      },
    ],
  });
  assert.equal(message.content, 'Alert\nFailure\nDatabase locked\nCode: 55P03\nRunbook (https://example.test/runbook)');
  assert.equal(normalize({ text: 'Hello', blocks: rich('Hello') }).content, 'Hello');
});

test('rich lists, quotes, code, styles, mentions, emoji, dates and tables remain readable', () => {
  const content = normalize({
    blocks: [
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Saturday', style: { strike: true } },
              { type: 'text', text: ' Sunday ' },
              { type: 'user', user_id: 'UJACK' },
              { type: 'channel', channel_id: 'CTEAM' },
              { type: 'usergroup', usergroup_id: 'SGROUP' },
              { type: 'broadcast', range: 'here' },
              { type: 'emoji', name: 'wave' },
              { type: 'link', text: 'Plan', url: 'https://example.test' },
            ],
          },
          { type: 'rich_text_quote', elements: [{ type: 'text', text: 'I am John (a quote, not the sender)' }] },
          { type: 'rich_text_list', style: 'ordered', offset: 1, elements: rich('Bring snacks') },
          { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'const day = "Sunday";' }] },
          { type: 'date', timestamp: 0, fallback: 'Thursday', format: '{date_short}' },
        ],
      },
      {
        type: 'table',
        rows: [
          [
            { type: 'raw_text', text: 'John' },
            { type: 'raw_text', text: 'Saturday' },
          ],
        ],
      },
    ],
  }).content;
  for (const value of [
    '~~Saturday~~',
    'Sunday',
    '<@UJACK>',
    '<#CTEAM>',
    '<!subteam^SGROUP>',
    '<!here>',
    ':wave:',
    'Plan (https://example.test)',
    '> I am John',
    '2. Bring snacks',
    '```',
    'Thursday',
    '1970-01-01',
    'John | Saturday',
  ])
    assert.ok(content.includes(value), value);
});

test('media and files are explicit metadata, never invented contents or private download URLs', () => {
  const content = normalize({
    blocks: [
      { type: 'image', alt_text: 'Lock chart', image_url: 'https://private.test/image' },
      {
        type: 'video',
        title: { type: 'plain_text', text: 'Demo' },
        description: { type: 'plain_text', text: 'A recording' },
        video_url: 'https://private.test/video',
      },
      { type: 'file', external_id: 'FILE123' },
    ],
    files: [
      {
        title: 'report.pdf',
        mimetype: 'application/pdf',
        permalink: 'https://example.test/file',
        url_private_download: 'SECRET',
      },
    ],
  }).content;
  assert.match(content, /Lock chart/);
  assert.match(content, /Demo/);
  assert.match(content, /report.pdf/);
  assert.match(content, /contents not read/);
  assert.doesNotMatch(content, /private.test|SECRET/);
});

test('future blocks expose bounded visible text and an unsupported-content marker, never arbitrary JSON', () => {
  const content = normalize({
    blocks: [
      {
        type: 'future_widget',
        text: { type: 'plain_text', text: 'Visible title' },
        internal_data: 'SECRET',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Open' }, url: 'javascript:alert(1)', value: 'SECRET' },
        ],
      },
    ],
  }).content;
  assert.match(content, /\[Unsupported Slack content: future_widget\]/);
  assert.match(content, /Visible title/);
  assert.match(content, /\[Unsupported link\]/);
  assert.doesNotMatch(content, /SECRET|javascript/);
});

test('forwarded messages retain their quoted speaker and legacy actions retain only labels and links', () => {
  const content = normalize({
    attachments: [
      {
        is_msg_unfurl: true,
        author_name: 'John',
        text: 'I will come on Saturday',
        message_blocks: [{ user: 'UJOHN', blocks: rich('Original message') }],
        actions: [{ text: 'Open thread', url: 'https://example.test/thread', value: 'PRIVATE ACTION VALUE' }],
      },
    ],
  }).content;
  assert.match(content, /Quoted or forwarded message; not a statement by the sender/);
  assert.match(content, /John\nI will come on Saturday\nUJOHN\nOriginal message/);
  assert.match(content, /Open thread \(https:\/\/example.test\/thread\)/);
  assert.doesNotMatch(content, /PRIVATE ACTION VALUE/);
});

test('rich payloads are bounded and malformed visible values are rejected', () => {
  assert.throws(() => normalize({ blocks: [{ type: 'text', text: { arbitrary: 'not text' } }] }));
  assert.throws(() => normalize({ blocks: rich('x'.repeat(40001)) }));
  let nested = { type: 'text', text: 'bottom' };
  for (let n = 0; n < 20; n++) nested = { type: 'rich_text', elements: [nested] };
  assert.throws(() => normalize({ blocks: [nested] }), /slack-message-content-limit/);
  assert.throws(() =>
    normalize({ blocks: [{ type: 'section', elements: Array(1001).fill({ type: 'text', text: 'x' }) }] }),
  );
});

test('rich-only events and file shares retain content through intake and saved payload parsing', () => {
  const raw = { ...base, blocks: rich('I will come on Saturday') };
  const message = messageSchema.parse(raw);
  assert.equal(message.text, '');
  assert.equal(slackMessageText(message), 'I will come on Saturday');
  assert.deepEqual(messageSchema.parse(message), message);
  assert.equal(
    classifyEvent({ event: { ...base, subtype: 'file_share', files: [{ title: 'agenda.pdf' }] } }).kind,
    'message',
  );
  assert.equal(classifyEvent({ event: { ...raw, bot_id: 'BBOT' } }).kind, 'ignored');
});

test('rich-only edits invalidate new snapshots while old plain-text snapshots remain readable', () => {
  const before = messageSchema.parse({ ...base, text: 'fallback', blocks: rich('Saturday') });
  const after = messageSchema.parse({ ...base, text: 'fallback', blocks: rich('Sunday') });
  assert.equal(sameSlackMessage(after, before), false);
  assert.equal(matchesSlackSnapshot(after, before), false);
  assert.equal(matchesSlackSnapshot(after, { user: base.user, ts: base.ts, text: 'fallback' }), true);
  assert.equal(matchesSlackSnapshot({ ...before, user: 'UJACK' }, before), false);
  const change = classifyEvent({
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'CTEST',
      event_ts: '2.000001',
      message: { ...base, blocks: rich('Sunday') },
    },
  });
  assert.equal(change.event.message.content, 'Sunday');
});

test('John Saturday and Jack Sunday stay tied to distinct sender IDs, not mentions or names', () => {
  const messages = [
    { user: 'UJOHN', ts: '1.000001', ...normalize({ blocks: rich("Hey I'm going to come on Saturday") }) },
    { user: 'UJACK', ts: '2.000001', text: "I'm going to come on Sunday. <@UJOHN>" },
  ];
  const prompt = slackThreadPrompt(messages, { UJOHN: 'John', UJACK: 'Jack' });
  const thread = JSON.parse(prompt.split('Current thread: ')[1]);
  assert.deepEqual(
    thread.map(({ user, text }) => [user, text]),
    [
      ['UJOHN', "Hey I'm going to come on Saturday"],
      ['UJACK', "I'm going to come on Sunday. <@UJOHN>"],
    ],
  );
  assert.match(prompt, /"UJOHN":"John","UJACK":"Jack"/);
  assert.match(prompt, /"I" refers to that message's sender/);
  assert.equal(matchesSlackSnapshot(messages[0], messages[0]), true);
  assert.ok(slackThreadPrompt(messages, { UJOHN: 'John', UJACK: 'John' }).includes('"user":"UJACK"'));
});
