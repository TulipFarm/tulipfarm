import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  definitionSchema,
  gmailTriggerSchema,
  triggerKinds,
  triggerSummary,
  triggerVariantSchema,
} from '../src/contracts.ts';
import {
  gmailTriggerEventSchema,
  matchesGmailTrigger,
  maxGmailBodyLength,
  parseGmailMessage,
  pollGmailMessages,
} from '../src/gmail-trigger.ts';

const encodeBase64Url = value => Buffer.from(value, 'utf8').toString('base64url');

test('gmailTriggerSchema validates defaults and strict fields', () => {
  const integrationId = randomUUID();
  const parsed = gmailTriggerSchema.parse({ kind: 'gmail', integrationId });
  assert.equal(parsed.kind, 'gmail');
  assert.equal(parsed.integrationId, integrationId);
  assert.equal(parsed.excludeOwnSent, true);
  assert.equal(parsed.minutes, 5);

  const variant = triggerVariantSchema.parse({
    kind: 'gmail',
    integrationId,
    labelIds: ['INBOX'],
    from: 'customer@example.com',
    to: 'team@example.com',
    subject: 'Welcome',
    repliesOnly: true,
    excludeOwnSent: false,
    minutes: 15,
  });
  assert.equal(variant.kind, 'gmail');
  assert.equal(variant.excludeOwnSent, false);
  assert.equal(variant.minutes, 15);
  assert.equal(variant.repliesOnly, true);

  assert.equal(triggerKinds.includes('gmail'), true);
  assert.equal(triggerKinds.length, 10);

  assert.equal(gmailTriggerSchema.safeParse({ kind: 'gmail', integrationId, extraField: true }).success, false);
  assert.equal(gmailTriggerSchema.safeParse({ kind: 'gmail', integrationId: 'not-a-uuid' }).success, false);
  assert.equal(gmailTriggerSchema.safeParse({ kind: 'gmail', integrationId, minutes: 0 }).success, false);
  assert.equal(gmailTriggerSchema.safeParse({ kind: 'gmail', integrationId, minutes: 1441 }).success, false);

  const def = definitionSchema.parse({
    version: 1,
    name: 'Customer replies',
    triggers: [{ id: 'inbox_reply', kind: 'gmail', integrationId, repliesOnly: true }],
    steps: [{ id: 'copy', kind: 'transform', fields: { from: { kind: 'input', path: ['from'] } } }],
  });
  assert.equal(def.triggers[0].kind, 'gmail');
  assert.equal(triggerSummary(def.triggers[0]), 'Gmail (replies)');
});

test('parseGmailMessage extracts headers, multipart plain text, HTML fallback, and receivedAt', () => {
  const multipart = parseGmailMessage({
    id: 'msg-1',
    threadId: 'thread-1',
    internalDate: '1763000000000',
    snippet: 'Snippet text',
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'from', value: 'Customer <customer@example.com>' },
        { name: 'To', value: 'Team <team@example.com>, support@example.com' },
        { name: 'cc', value: 'Manager <cc@example.com>' },
        { name: 'SUBJECT', value: 'Re: Welcome to Example' },
        { name: 'In-Reply-To', value: '<welcome-1@example.com>' },
        { name: 'References', value: '<root@example.com> <welcome-1@example.com>' },
      ],
      parts: [
        {
          mimeType: 'text/html',
          body: { data: encodeBase64Url('<p>HTML version</p>') },
        },
        {
          mimeType: 'text/plain',
          body: { data: encodeBase64Url('Thanks for the welcome! Quick question.') },
        },
      ],
    },
  });

  assert.deepEqual(gmailTriggerEventSchema.parse(multipart), {
    messageId: 'msg-1',
    threadId: 'thread-1',
    from: 'Customer <customer@example.com>',
    to: ['Team <team@example.com>', 'support@example.com'],
    cc: ['Manager <cc@example.com>'],
    subject: 'Re: Welcome to Example',
    snippet: 'Snippet text',
    bodyText: 'Thanks for the welcome! Quick question.',
    receivedAt: new Date(1763000000000).toISOString(),
    inReplyTo: '<welcome-1@example.com>',
    references: ['<root@example.com>', '<welcome-1@example.com>'],
    labelIds: ['INBOX', 'UNREAD'],
  });

  const htmlOnly = parseGmailMessage({
    id: 'msg-2',
    threadId: 'thread-2',
    internalDate: '1763000005000',
    snippet: 'Fallback snippet',
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/html',
      headers: [
        { name: 'From', value: 'customer@example.com' },
        { name: 'To', value: 'team@example.com' },
        { name: 'Subject', value: 'Hello' },
      ],
      body: {
        data: encodeBase64Url(
          '<div><style>.x{color:red}</style><p>Hello &amp; welcome</p><br/><p>Second line</p></div>',
        ),
      },
    },
  });
  assert.equal(htmlOnly.bodyText, 'Hello & welcome\nSecond line');
  assert.equal(htmlOnly.inReplyTo, null);
  assert.deepEqual(htmlOnly.references, []);

  const huge = parseGmailMessage({
    id: 'msg-3',
    threadId: 'thread-3',
    internalDate: '1763000010000',
    snippet: 'Long body',
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [],
      body: { data: encodeBase64Url('a'.repeat(maxGmailBodyLength + 500)) },
    },
  });
  assert.equal(huge.bodyText.length, maxGmailBodyLength);
});

test('matchesGmailTrigger enforces excludeOwnSent loop protection and message filters', () => {
  const integrationId = randomUUID();
  const baseTrigger = gmailTriggerSchema.parse({ kind: 'gmail', integrationId });

  const customerReply = gmailTriggerEventSchema.parse({
    messageId: 'msg-reply',
    threadId: 'thread-1',
    from: 'Customer <customer@example.com>',
    to: ['Team <team@example.com>'],
    cc: ['ops@example.com'],
    subject: 'Re: Welcome to our product',
    snippet: 'Happy to chat!',
    bodyText: 'Happy to chat!',
    receivedAt: '2026-11-12T10:00:00.000Z',
    inReplyTo: '<welcome-1@example.com>',
    references: ['<welcome-1@example.com>'],
    labelIds: ['INBOX', 'UNREAD'],
  });

  const ownSentByLabel = {
    ...customerReply,
    messageId: 'msg-sent-label',
    from: 'alias@example.com',
    labelIds: ['SENT'],
  };
  const ownSentByFrom = {
    ...customerReply,
    messageId: 'msg-sent-from',
    from: 'Team <TEAM@EXAMPLE.COM>',
    labelIds: ['INBOX'],
  };
  const nonReply = {
    ...customerReply,
    messageId: 'msg-new',
    subject: 'New inquiry',
    inReplyTo: null,
    references: [],
  };

  assert.equal(matchesGmailTrigger(customerReply, baseTrigger, 'team@example.com'), true);
  assert.equal(matchesGmailTrigger(ownSentByLabel, baseTrigger, 'team@example.com'), false);
  assert.equal(matchesGmailTrigger(ownSentByFrom, baseTrigger, 'team@example.com'), false);

  const allowOwnSent = gmailTriggerSchema.parse({ kind: 'gmail', integrationId, excludeOwnSent: false });
  assert.equal(matchesGmailTrigger(ownSentByLabel, allowOwnSent, 'team@example.com'), true);
  assert.equal(matchesGmailTrigger(ownSentByFrom, allowOwnSent, 'team@example.com'), true);

  const repliesOnly = gmailTriggerSchema.parse({ kind: 'gmail', integrationId, repliesOnly: true });
  assert.equal(matchesGmailTrigger(customerReply, repliesOnly, 'team@example.com'), true);
  assert.equal(matchesGmailTrigger(nonReply, repliesOnly, 'team@example.com'), false);
  assert.equal(
    matchesGmailTrigger({ ...nonReply, subject: 'Re: Fresh thread' }, repliesOnly, 'team@example.com'),
    true,
  );

  const filtered = gmailTriggerSchema.parse({
    kind: 'gmail',
    integrationId,
    labelIds: ['INBOX', 'UNREAD'],
    from: 'CUSTOMER@example.com',
    to: 'ops@example.com',
    subject: 'welcome',
  });
  assert.equal(matchesGmailTrigger(customerReply, filtered, 'team@example.com'), true);
  assert.equal(matchesGmailTrigger({ ...customerReply, labelIds: ['INBOX'] }, filtered, 'team@example.com'), false);
  assert.equal(
    matchesGmailTrigger({ ...customerReply, from: 'other@example.com' }, filtered, 'team@example.com'),
    false,
  );
  assert.equal(
    matchesGmailTrigger({ ...customerReply, to: ['other@example.com'], cc: [] }, filtered, 'team@example.com'),
    false,
  );
  assert.equal(matchesGmailTrigger({ ...customerReply, subject: 'Invoice' }, filtered, 'team@example.com'), false);
});

test('pollGmailMessages fetches unseen messages, filters own sent, shapes payloads, and advances cursor', async () => {
  const integrationId = randomUUID();
  const trigger = gmailTriggerSchema.parse({
    kind: 'gmail',
    integrationId,
    labelIds: ['INBOX'],
    repliesOnly: true,
    excludeOwnSent: true,
  });

  const messages = new Map([
    [
      'msg-own-sent',
      {
        id: 'msg-own-sent',
        threadId: 'thread-1',
        internalDate: '1763000001000',
        snippet: 'Welcome!',
        labelIds: ['INBOX', 'SENT'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Team <team@example.com>' },
            { name: 'To', value: 'customer@example.com' },
            { name: 'Subject', value: 'Re: Welcome' },
          ],
          body: { data: encodeBase64Url('Welcome aboard!') },
        },
      },
    ],
    [
      'msg-customer-reply',
      {
        id: 'msg-customer-reply',
        threadId: 'thread-1',
        internalDate: '1763000010000',
        snippet: 'Thanks!',
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Customer <customer@example.com>' },
            { name: 'To', value: 'Team <team@example.com>' },
            { name: 'Subject', value: 'Re: Welcome' },
            { name: 'In-Reply-To', value: '<msg-own-sent@example.com>' },
          ],
          body: { data: encodeBase64Url('Thanks for reaching out!') },
        },
      },
    ],
  ]);

  const requestedUrls = [];
  const fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    requestedUrls.push({ url, auth: init?.headers?.Authorization });
    if (url.includes('/users/me/messages?')) {
      return new Response(
        JSON.stringify({
          messages: [
            { id: 'msg-customer-reply', threadId: 'thread-1' },
            { id: 'msg-own-sent', threadId: 'thread-1' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const id = url.split('/users/me/messages/')[1]?.split('?')[0];
    return new Response(JSON.stringify(messages.get(id)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const first = await pollGmailMessages({
    accessToken: 'token-123',
    fetcher,
    trigger,
    accountEmail: 'team@example.com',
  });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].externalId, 'msg-customer-reply');
  assert.equal(first.events[0].payload.messageId, 'msg-customer-reply');
  assert.equal(first.events[0].payload.bodyText, 'Thanks for reaching out!');
  assert.equal(first.nextCursor.lastEpochSeconds, 1763000010);
  assert.deepEqual(first.nextCursor.seenMessageIds, ['msg-customer-reply', 'msg-own-sent']);

  const second = await pollGmailMessages({
    accessToken: 'token-123',
    fetcher,
    trigger,
    accountEmail: 'team@example.com',
    cursor: first.nextCursor,
  });
  assert.equal(second.events.length, 0);
  assert.equal(
    requestedUrls.some(entry => entry.url.includes('q=after%3A1763000009')),
    true,
  );
});
