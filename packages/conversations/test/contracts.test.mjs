import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  chatTitleSchema,
  defaultConversationModel,
  displayPartSchema,
  initialTitle,
  sendMessageSchema,
  renameChatSchema,
} from '../src/contracts.ts';
import { chatDocumentReferences, chatDocumentSchema, chatDocumentText } from '../src/rich-content.ts';

test('malformed link destinations return validation errors instead of throwing', () => {
  for (const href of ['', 'not a URL', 'https://', 'javascript:alert(1)', 'data:text/html,hello']) {
    const content = {
      version: 1,
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href } }] }] },
        ],
      },
    };
    assert.equal(chatDocumentSchema.safeParse(content).success, false, href);
  }
});

test('rich chat documents preserve formatting text and inline file positions through a strict public contract', () => {
  const localFileId = randomUUID();
  const googleFileId = 'google-file-1';
  const document = {
    version: 1,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Quarterly review', marks: [{ type: 'bold' }] }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Compare ' },
            { type: 'fileReference', attrs: { source: 'tulipfarm', id: localFileId } },
            { type: 'text', text: ' with ' },
            { type: 'fileReference', attrs: { source: 'google', id: googleFileId } },
            {
              type: 'text',
              text: '.',
              marks: [{ type: 'italic' }, { type: 'link', attrs: { href: 'https://example.com/report' } }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Revenue', marks: [{ type: 'code' }] }] }],
            },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'const total = 42;\nreturn total;' }] },
      ],
    },
  };
  assert.deepEqual(chatDocumentSchema.parse(document), document);
  assert.equal(
    chatDocumentText(document),
    `Quarterly review\n\nCompare \uFFFC with \uFFFC.\n\n- Revenue\n\nconst total = 42;\nreturn total;`,
  );
  assert.deepEqual(chatDocumentReferences(document), [
    { source: 'tulipfarm', id: localFileId },
    { source: 'google', id: googleFileId },
  ]);
  const parsed = sendMessageSchema.parse({
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [
      { kind: 'text', text: chatDocumentText(document), content: document },
      { kind: 'file', fileId: localFileId },
      {
        kind: 'google-file',
        fileId: googleFileId,
        name: 'Report',
        mimeType: 'application/pdf',
        expectedIntegration: { integrationId: randomUUID(), accountId: 'account', generation: 1 },
      },
    ],
  });
  assert.deepEqual(parsed.parts[0], { kind: 'text', text: chatDocumentText(document), content: document });
});

test('rich chat code blocks accept the editor language attribute and reject anything else', () => {
  const codeBlock = attrs => ({
    version: 1,
    doc: { type: 'doc', content: [{ type: 'codeBlock', attrs, content: [{ type: 'text', text: 'ls -la' }] }] },
  });
  assert.deepEqual(chatDocumentSchema.parse(codeBlock({ language: 'ts' })), codeBlock({ language: 'ts' }));
  assert.deepEqual(chatDocumentSchema.parse(codeBlock({ language: null })), codeBlock({ language: null }));
  assert.equal(chatDocumentText(codeBlock({ language: 'ts' })), 'ls -la');
  assert.equal(chatDocumentSchema.safeParse(codeBlock({ language: '' })).success, false);
  assert.equal(chatDocumentSchema.safeParse(codeBlock({ language: 'x'.repeat(65) })).success, false);
  assert.equal(chatDocumentSchema.safeParse(codeBlock({ language: 'ts', theme: 'dark' })).success, false);
});

test('rich chat documents reject unsafe links, unknown nodes, mismatched text and hidden file authorization', () => {
  const fileId = randomUUID();
  const base = {
    version: 1,
    doc: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'fileReference', attrs: { source: 'tulipfarm', id: fileId } }] },
      ],
    },
  };
  const input = { commandId: randomUUID(), messageId: randomUUID() };
  assert.equal(chatDocumentSchema.safeParse({ ...base, version: 2 }).success, false);
  assert.equal(
    chatDocumentSchema.safeParse({
      version: 1,
      doc: { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.com/a.png' } }] },
    }).success,
    false,
  );
  assert.equal(
    chatDocumentSchema.safeParse({
      version: 1,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
          },
        ],
      },
    }).success,
    false,
  );
  assert.equal(
    sendMessageSchema.safeParse({
      ...input,
      parts: [
        { kind: 'text', text: 'wrong', content: base },
        { kind: 'file', fileId },
      ],
    }).success,
    false,
  );
  assert.equal(
    sendMessageSchema.safeParse({ ...input, parts: [{ kind: 'text', text: chatDocumentText(base), content: base }] })
      .success,
    false,
  );
  assert.equal(
    sendMessageSchema.safeParse({
      ...input,
      parts: [
        {
          kind: 'text',
          text: 'plain',
          content: {
            version: 1,
            doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }] },
          },
        },
        { kind: 'file', fileId },
      ],
    }).success,
    false,
  );
});

test('ordered exact text stays unchanged while titles collapse whitespace and preserve graphemes', () => {
  const parts = [
    { kind: 'text', text: '  hello\n' },
    { kind: 'text', text: ' 👨‍👩‍👧‍👦 e\u0301  ' },
  ];
  assert.deepEqual(sendMessageSchema.parse({ commandId: randomUUID(), messageId: randomUUID(), parts }).parts, parts);
  assert.equal(initialTitle(parts), 'hello 👨‍👩‍👧‍👦 e\u0301');
  assert.equal(initialTitle([{ kind: 'text', text: 'e\u0301'.repeat(51) }]), 'e\u0301'.repeat(50));
  assert.equal(initialTitle([{ kind: 'text', text: ' \n ' }]), 'New chat');
});

test('messages without a selected model use Claude Sonnet', () => {
  assert.equal(defaultConversationModel, 'claude-sonnet');
  assert.equal(
    sendMessageSchema.parse({
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Hello' }],
    }).model,
    'claude-sonnet',
  );
});

test('chat titles allow 50 visible characters and reject invalid Unicode', () => {
  for (const character of ['a', 'e\u0301', '👨‍👩‍👧‍👦']) {
    assert.equal(chatTitleSchema.parse(character.repeat(50)), character.repeat(50));
    assert.equal(chatTitleSchema.safeParse(character.repeat(51)).success, false);
  }
  for (const title of ['', '  ', '\0', '\ud800']) assert.equal(chatTitleSchema.safeParse(title).success, false);
});

test('untrusted input cannot select authors, cards, attachments, invalid Unicode or oversized text', () => {
  const input = { commandId: randomUUID(), messageId: randomUUID(), parts: [{ kind: 'text', text: 'valid' }] };
  for (const parts of [
    [],
    [{ kind: 'approval', text: 'approved' }],
    [{ kind: 'attachment', id: randomUUID() }],
    [{ kind: 'text', text: '\0' }],
    [{ kind: 'text', text: '\ud800' }],
    [{ kind: 'text', text: '😀'.repeat(20000) }],
  ]) {
    assert.equal(sendMessageSchema.safeParse({ ...input, parts }).success, false);
  }
  assert.equal(sendMessageSchema.safeParse({ ...input, author: 'assistant' }).success, false);
  assert.equal(
    renameChatSchema.parse({ commandId: randomUUID(), expectedRevision: 0, title: '  My title  ' }).title,
    'My title',
  );
});

test('a message requests at most one exact skill revision and cannot name it', () => {
  const input = { commandId: randomUUID(), messageId: randomUUID() };
  const skill = { kind: 'skill', skillId: randomUUID(), revision: 'a'.repeat(64) };
  const text = { kind: 'text', text: 'Acme Corp wants a demo.' };
  assert.deepEqual(sendMessageSchema.parse({ ...input, parts: [skill, text] }).parts, [skill, text]);
  assert.deepEqual(
    sendMessageSchema.parse({ ...input, parts: [{ kind: 'skill', skillId: 'agent-authoring', revision: '2' }] }).parts,
    [{ kind: 'skill', skillId: 'agent-authoring', revision: '2' }],
  );
  assert.deepEqual(
    sendMessageSchema
      .safeParse({ ...input, parts: [{ ...skill, name: 'Qualify lead' }] })
      .error.issues.map(issue => issue.code),
    ['unrecognized_keys'],
  );
  assert.deepEqual(
    sendMessageSchema
      .safeParse({ ...input, parts: [skill, { ...skill, skillId: randomUUID() }, text] })
      .error.issues.map(issue => issue.message),
    ['At most one skill'],
  );
  for (const invalid of [
    { skillId: randomUUID().toUpperCase() },
    { skillId: 'Agent-authoring' },
    { revision: '0' },
    { revision: 'A'.repeat(64) },
  ]) {
    assert.equal(
      sendMessageSchema.safeParse({ ...input, parts: [{ ...skill, ...invalid }] }).success,
      false,
      JSON.stringify(invalid),
    );
  }
});

test('history shows the requested skill and the skill a reply used by name and exact revision', () => {
  const reference = { skillId: randomUUID(), revision: 'a'.repeat(64), name: 'Qualify lead' };
  assert.deepEqual(displayPartSchema.parse({ kind: 'skill', ...reference }), { kind: 'skill', ...reference });
  assert.deepEqual(displayPartSchema.parse({ kind: 'skill-use', ...reference, revision: '2' }), {
    kind: 'skill-use',
    ...reference,
    revision: '2',
  });
  assert.equal(
    displayPartSchema.safeParse({ kind: 'skill-use', skillId: reference.skillId, revision: reference.revision })
      .success,
    false,
  );
});

test('a message without text takes its title from the picked skill before attachment and file fallbacks', () => {
  const skill = { kind: 'skill', skillId: randomUUID(), revision: 'a'.repeat(64) };
  assert.equal(initialTitle([skill], 'Qualify  lead '), 'Qualify lead');
  assert.equal(
    initialTitle([skill, { kind: 'attachment', attachmentId: randomUUID() }], 'Qualify lead'),
    'Qualify lead',
  );
  assert.equal(
    initialTitle([skill, { kind: 'text', text: 'Acme Corp wants a demo.' }], 'Qualify lead'),
    'Acme Corp wants a demo.',
  );
  assert.equal(initialTitle([skill], 'q'.repeat(120)), 'q'.repeat(50));
  assert.equal(initialTitle([{ kind: 'file', fileId: randomUUID() }]), 'Files');
});
