/* oxlint-disable tulipfarm/product-copy -- Draft state identifiers, not application copy. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { draftState } from '../src/store/index.ts';

const commit = 'c'.repeat(40);
const draft = { appId: 'app', revision: 3, headCommit: commit, lease: null, previewBuildId: 'build-2', failure: null };
const headBuild = {
  id: 'build-2',
  appId: 'app',
  commit,
  recipe: {},
  builder: 'builder',
  status: { status: 'succeeded', manifestDigest: 'd', files: 1, bytes: 1 },
  manifestKey: 'key',
};
const release = buildId => ({
  id: 'release-1',
  appId: 'app',
  number: 1,
  buildId,
  commit,
  manifestDigest: 'd',
  staged: true,
});

test('a built draft that is already live has no changes to publish', () => {
  assert.deepEqual(draftState(draft, headBuild, release('build-2')), { state: 'live', buildId: 'build-2', commit });
});

test('a built draft differing from the live release is ready to publish', () => {
  assert.deepEqual(draftState(draft, headBuild, release('build-1')), {
    state: 'preview-ready',
    buildId: 'build-2',
    commit,
  });
});

test('a built draft with nothing live is ready to publish', () => {
  assert.deepEqual(draftState(draft, headBuild, null), { state: 'preview-ready', buildId: 'build-2', commit });
});

test('a newer build of the draft wins over the live release', () => {
  const running = { ...headBuild, id: 'build-3', status: { status: 'running', startedAt: '2026-01-01T00:00:00Z' } };
  assert.deepEqual(draftState(draft, running, release('build-2')), { state: 'building', buildId: 'build-3' });
});

test('the agent and the editor see the same state for a live draft', () => {
  const publishedEarlier = { ...draft, previewBuildId: 'build-1' };
  assert.deepEqual(draftState(publishedEarlier, headBuild, release('build-2')), {
    state: 'live',
    buildId: 'build-2',
    commit,
  });
});
