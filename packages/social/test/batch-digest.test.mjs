import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  batchDigest,
  batchDigestInput,
  canonicalContent,
  contentDigest,
  contentDigestInput,
} from '../dist/batch-digest.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const media = { fileId: id(100), contentDigest: 'b'.repeat(64), role: 'primary' };
const choices = {
  privacy: 'SELF_ONLY',
  allowComments: false,
  allowDuet: false,
  allowStitch: false,
  commercialContent: { disclosed: false, yourBrand: false, brandedContent: false },
  creatorInfo: {
    nickname: 'c',
    maxVideoPostDurationSec: 60,
    privacyLevelOptions: ['SELF_ONLY'],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
  },
};
const variants = [
  {
    channelId: id(3),
    channelVersion: 1,
    content: { platform: 'x', text: 'Hello', media: [], replySettings: 'everyone' },
    publishAt: null,
  },
  {
    channelId: id(1),
    channelVersion: 2,
    target: { kind: 'board', boardId: 'b1' },
    content: { platform: 'pinterest', title: 'Pin', description: '', media: [media] },
    publishAt: '2026-06-02T00:00:00.000Z',
  },
  {
    channelId: id(2),
    channelVersion: 1,
    content: { platform: 'tiktok', caption: 'Hi', media: [media] },
    publishAt: null,
  },
];

test('the canonical content is sorted by channelId with every bound field and no review choices', () => {
  const input = contentDigestInput(variants);
  assert.deepEqual(
    input.map(variant => variant.channelId),
    [id(1), id(2), id(3)],
  );
  for (const entry of input)
    assert.deepEqual(Object.keys(entry).sort(), ['channelId', 'channelVersion', 'content', 'publishAt', 'target']);
  assert.equal(input[2].target, null);
  assert.equal(JSON.parse(canonicalContent(variants)).length, 3);
  assert.equal(
    contentDigest(variants.map(variant => ({ ...variant, reviewChoices: choices }))),
    contentDigest(variants),
  );
});

test('the content digest is SHA-256 hex and independent of variant order', () => {
  const digest = contentDigest(variants);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(contentDigest([...variants].reverse()), digest);
  assert.equal(contentDigest([variants[1], variants[2], variants[0]]), digest);
});

test('object key order does not change the content digest', () => {
  const reordered = variants.map(variant => Object.fromEntries(Object.entries(variant).reverse()));
  assert.equal(contentDigest(reordered), contentDigest(variants));
});

test('changing any bound field changes the content digest', () => {
  const base = contentDigest(variants);
  const change = (index, patch) => contentDigest(variants.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  const changes = [
    change(0, { channelId: id(4) }),
    change(0, { channelVersion: 2 }),
    change(0, { content: { ...variants[0].content, text: 'Hello!' } }),
    change(0, { content: { ...variants[0].content, replySettings: 'following' } }),
    change(0, { publishAt: '2026-06-02T00:00:00.000Z' }),
    change(1, { target: { kind: 'board', boardId: 'b2' } }),
    change(1, { target: { kind: 'board', boardId: 'b1', sectionId: 's' } }),
    change(1, { content: { ...variants[1].content, media: [{ ...media, contentDigest: 'c'.repeat(64) }] } }),
    change(1, { content: { ...variants[1].content, media: [{ ...media, altText: 'tulips' }] } }),
    change(1, { content: { ...variants[1].content, media: [{ ...media, role: 'cover' }] } }),
    change(1, { content: { ...variants[1].content, media: [{ ...media, fileId: id(101) }] } }),
    contentDigest(variants.slice(1)),
  ];
  for (const [index, digest] of changes.entries()) assert.notEqual(digest, base, `change ${index}`);
  assert.equal(new Set(changes).size, changes.length);
});

test('the batch digest binds the content digest and the approved review choices sorted by variantId', () => {
  const content = contentDigest(variants);
  const first = { variantId: id(31), values: choices };
  const second = { variantId: id(30), values: { ...choices, allowComments: true } };
  assert.deepEqual(batchDigestInput(content), { contentDigest: content, reviewChoices: [] });
  assert.deepEqual(
    batchDigestInput(content, [first, second]).reviewChoices.map(choice => choice.variantId),
    [id(30), id(31)],
  );
  const base = batchDigest(content);
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.notEqual(base, content);
  assert.equal(batchDigest(content, []), base);
  assert.equal(batchDigest(content, null), base);
  assert.equal(batchDigest(content, [first, second]), batchDigest(content, [second, first]));
  const changes = [
    batchDigest('c'.repeat(64)),
    batchDigest(content, [first]),
    batchDigest(content, [first, second]),
    batchDigest(content, [{ ...first, values: { ...choices, privacy: 'SELF_ONLY', allowStitch: true } }]),
    batchDigest(content, [{ ...first, variantId: id(32) }]),
  ];
  for (const [index, digest] of changes.entries()) assert.notEqual(digest, base, `change ${index}`);
  assert.equal(new Set(changes).size, changes.length);
});
