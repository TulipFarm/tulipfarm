import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatDocumentSchema, chatDocumentText, type ChatDocument } from '@tulipfarm/conversations/rich-content';
import { editorDocument, parseChatDraft, type ChatDraft } from '../src/features/chat/editor-document.ts';

const draftWithMark = (href: string): ChatDraft => ({
  version: 1,
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Contact <hello@example.com>',
            marks: [
              { type: 'bold' },
              {
                type: 'link',
                attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: 'Contact' },
              },
            ],
          },
        ],
      },
    ],
  },
});

test('editor-only link attributes are removed without changing the draft, label or destination', () => {
  for (const href of ['mailto:hello@example.com', 'http://website.com', 'https://example.com/a_(b)?q=1&next=2#part']) {
    const draft = draftWithMark(href);
    const before = structuredClone(draft);
    assert.equal(chatDocumentSchema.safeParse(draft).success, false);
    const result = parseChatDraft(draft);
    assert.equal(result.success, true);
    if (!result.success) throw result.error;
    assert.equal(chatDocumentText(result.data), 'Contact <hello@example.com>');
    assert.deepEqual(result.data.doc.content, [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Contact <hello@example.com>',
            marks: [{ type: 'bold' }, { type: 'link', attrs: { href } }],
          },
        ],
      },
    ]);
    assert.deepEqual(draft, before);
    assert.deepEqual(parseChatDraft(result.data), result);
  }
});

test('ordered list presentation attributes and non-text marks do not invalidate messages', () => {
  const draft: ChatDraft = {
    version: 1,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 3, type: null },
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }] }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'hardBreak', marks: [{ type: 'bold' }] },
            {
              type: 'fileReference',
              attrs: { source: 'tulipfarm', id: '44444444-4444-4444-8444-444444444444' },
              marks: [{ type: 'bold' }],
            },
          ],
        },
      ],
    },
  };
  const result = parseChatDraft(draft);
  assert.equal(result.success, true);
  if (!result.success) throw result.error;
  assert.equal(chatDocumentText(result.data), '3. third\n\n\n\uFFFC');
  assert.deepEqual(result.data.doc.content[1], {
    type: 'paragraph',
    content: [
      { type: 'hardBreak' },
      { type: 'fileReference', attrs: { source: 'tulipfarm', id: '44444444-4444-4444-8444-444444444444' } },
    ],
  });
});

test('normalization does not bypass unsafe URLs, unknown marks, invalid text or content limits', () => {
  for (const href of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/file',
    'ftp://example.com',
    'not a URL',
  ]) {
    assert.equal(parseChatDraft(draftWithMark(href)).success, false, href);
  }
  for (const text of ['\0', '\uD800', 'x'.repeat(140_000)]) {
    assert.equal(
      parseChatDraft({
        version: 1,
        doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      }).success,
      false,
    );
  }
  const draft = draftWithMark('https://example.com');
  draft.doc.content![0]!.content![0]!.marks!.push({ type: 'unknown' });
  assert.equal(parseChatDraft(draft).success, false);
});

test('persisted optional fields become editor JSON without a cast or a changed message', () => {
  const document: ChatDocument = {
    version: 1,
    doc: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: undefined },
        { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'code', marks: undefined }] },
      ],
    },
  };
  assert.deepEqual(editorDocument(document.doc), {
    type: 'doc',
    content: [
      { type: 'paragraph' },
      { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'code' }] },
    ],
  });
  assert.equal(parseChatDraft(document).success, true);
});
