import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverDraft } from '../src/features/apps/edit/server-draft.ts';

// oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
const built = 'preview-ready' as const;
const head = { revision: 3, headCommit: 'c2', buildId: 'b2', commit: 'c2' };

test('a built or live head that the pane cannot show is a server draft', () => {
  assert.equal(serverDraft({ ...head, state: built, previewBuildId: null }), true);
  assert.equal(serverDraft({ ...head, state: 'live', previewBuildId: 'b1' }), true);
});

test('a file build the pane shows, or a draft with no built head, is not a server draft', () => {
  assert.equal(serverDraft({ ...head, state: built, previewBuildId: 'b2' }), false);
  assert.equal(serverDraft({ ...head, state: 'live', previewBuildId: 'b2' }), false);
  assert.equal(
    serverDraft({ revision: 3, headCommit: 'c2', state: 'building', buildId: 'b3', previewBuildId: 'b2' }),
    false,
  );
  assert.equal(
    serverDraft({ revision: 3, headCommit: 'c2', state: 'saved', commit: 'c2', previewBuildId: null }),
    false,
  );
});
