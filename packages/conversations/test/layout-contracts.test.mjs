import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkLayout,
  layoutFromReply,
  layoutText,
  packageInstallRequest,
  replyRenderInputSchema,
  textLayout,
} from '../src/layout-contracts.ts';

const surfaceId = '11111111-1111-4111-8111-111111111111';
const reply = (components, extra = {}) =>
  replyRenderInputSchema.parse({
    placement: 'chat',
    title: 'Signups',
    summary: 'Signups grew this week.',
    messages: [
      { version: 'v0.9.1', createSurface: { surfaceId: 'model-chosen', catalogId: 'other/catalog' } },
      { version: 'v0.9.1', updateComponents: { surfaceId: 'model-chosen', components } },
    ],
    ...extra,
  });
const valid = [
  { id: 'root', component: 'Column', children: ['text', 'metric'] },
  { id: 'text', component: 'Text', text: 'Most came from **search**.' },
  { id: 'metric', component: 'Metric', label: 'Signups', value: 42 },
];
const errors = check => (check.ok ? [] : check.errors.map(error => error.message));

test('package install requests require an unquoted plain-text command, not its rich-text projection', () => {
  const url = 'https://packages.tulipfarm.ai/packages/leave-management/1.0.0/';
  const text = `Install ${url}`;
  const expected = { name: 'leave-management', version: '1.0.0', url: `${url}package.json` };
  const part = content => ({
    kind: 'text',
    text,
    ...(content ? { content: { version: 1, doc: { type: 'doc', content } } } : {}),
  });
  const paragraph = {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Install ' },
      { type: 'text', text: url },
    ],
  };
  assert.deepEqual(packageInstallRequest([part()]), expected);
  assert.deepEqual(
    packageInstallRequest([part([paragraph])], 'normal', null),
    expected,
    'converted package pills remain text',
  );
  for (const content of [
    [{ type: 'codeBlock', content: [{ type: 'text', text }] }],
    [{ type: 'blockquote', content: [paragraph] }],
    [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text }] }],
    [paragraph, { type: 'paragraph' }],
    [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'code' }] }] }],
    [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href: url } }] }] }],
    [{ type: 'paragraph', content: [{ type: 'text', text: 'Different text' }] }],
  ])
    assert.equal(packageInstallRequest([part(content)]), null);
  assert.equal(packageInstallRequest([{ kind: 'text', text: `Please explain how to ${text}` }]), null);
  assert.equal(packageInstallRequest([part()], 'plan'), null);
  assert.equal(packageInstallRequest([part()], 'normal', surfaceId), null);
  for (const extra of [
    { kind: 'attachment', attachmentId: surfaceId },
    { kind: 'file', fileId: surfaceId },
    { kind: 'skill', skillId: 'package-install', revision: 'latest' },
    { kind: 'text', text: 'More context' },
  ])
    assert.equal(packageInstallRequest([part(), extra]), null);
});

test('a reply layout takes the reply surface and catalog, whatever the model sent', () => {
  const built = layoutFromReply(reply(valid), surfaceId);
  assert.equal(built.ok, true);
  const [create, update] = built.layout.messages;
  assert.deepEqual(create.createSurface, { surfaceId, catalogId: 'tulipfarm/chat@1' });
  assert.equal(update.updateComponents.surfaceId, surfaceId);
  assert.equal(checkLayout(built.layout, surfaceId).ok, true);
  assert.deepEqual(errors(checkLayout(built.layout, '22222222-2222-4222-8222-222222222222')), [
    'The surface ID must be 22222222-2222-4222-8222-222222222222',
  ]);
});

test('layouts outside the TulipFarm catalog or its link rules are refused', () => {
  const refused = components => layoutFromReply(reply(components), surfaceId);
  assert.match(errors(refused([{ id: 'root', component: 'Image', src: 'https://example.com/a.png' }]))[0], /Image/);
  assert.match(errors(refused([{ id: 'root', component: 'Text', text: '[go](javascript:alert(1))' }]))[0], /Link/);
  assert.equal(errors(refused([{ id: 'text', component: 'Text', text: 'No root' }])).length, 1);
  assert.equal(
    refused([{ id: 'root', component: 'Embed', ref: { kind: 'plan', planId: surfaceId } }]).ok,
    true,
    'Embed is part of the catalog',
  );
  assert.equal(refused([{ id: 'root', component: 'Embed', ref: { kind: 'plan', planId: 'not-a-uuid' } }]).ok, false);
  assert.equal(replyRenderInputSchema.safeParse({ ...reply(valid), placement: 'sidebar' }).success, false);
  assert.equal(replyRenderInputSchema.safeParse({ ...reply(valid), summary: '   ' }).success, false);
  assert.equal(checkLayout({ ...layoutFromReply(reply(valid), surfaceId).layout, protocol: 'a2ui/1.0' }).ok, false);
});

test('layout text is the summary followed by the surface, without repeating a summary-only body', () => {
  const built = layoutFromReply(reply(valid), surfaceId).layout;
  assert.equal(layoutText(built), 'Signups grew this week.\n\nMost came from **search**.\n\nSignups: 42');
  assert.equal(layoutText(textLayout('Just this.', surfaceId)), 'Just this.');
});

test('long layout text and text-layout summaries are cut within their limits at a whole character', () => {
  const layout = textLayout('😀'.repeat(20000), surfaceId, { title: 'Long' });
  assert.equal(layout.summary.length, 1999);
  assert.ok(layout.summary.endsWith('😀…'));
  const text = layoutText(layout);
  assert.ok(new TextEncoder().encode(text).length <= 65536);
  assert.ok(text.endsWith('…'));
  assert.doesNotMatch(text, /[\uD800-\uDBFF]…$/u);
});
