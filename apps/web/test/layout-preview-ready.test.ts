import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutPreviewHasRoot } from '../src/features/chat/layout-preview-ready.ts';

test('a streaming reply is not ready until a root component arrives', () => {
  assert.equal(layoutPreviewHasRoot([]), false);
  assert.equal(layoutPreviewHasRoot([{ components: [{ id: 'title' }] }]), false);
  assert.equal(layoutPreviewHasRoot([{ components: [{ id: 'root' }] }]), true);
});
