import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkLayout,
  layoutFromReply,
  layoutText,
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
