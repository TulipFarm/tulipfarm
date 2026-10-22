import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  githubEventSelectionSchema,
  githubRepositorySelectionSchema,
  githubBranchSelectionSchema,
  githubEventFieldsSchema,
} from '../src/event-contracts.ts';

test('repository scope distinguishes a fixed list from explicit future-organization consent', () => {
  assert.deepEqual(githubRepositorySelectionSchema.parse({ kind: 'repositories', repositoryIds: ['20', '10'] }), {
    kind: 'repositories',
    repositoryIds: ['10', '20'],
  });
  assert.equal(githubRepositorySelectionSchema.safeParse({ kind: 'repositories', repositoryIds: [] }).success, false);
  assert.equal(
    githubRepositorySelectionSchema.safeParse({ kind: 'repositories', repositoryIds: ['10', '10'] }).success,
    false,
  );
  assert.equal(
    githubRepositorySelectionSchema.safeParse({ kind: 'organization', organizationId: '10' }).success,
    false,
  );
  assert.equal(
    githubRepositorySelectionSchema.safeParse({ kind: 'organization', organizationId: '10', includeFuture: false })
      .success,
    false,
  );
  assert.equal(
    githubRepositorySelectionSchema.safeParse({ kind: 'organization', organizationId: '10', includeFuture: true })
      .success,
    true,
  );
  for (const id of ['0', '-1', '01', '1.5', '1e3', 'org-name']) {
    assert.equal(
      githubRepositorySelectionSchema.safeParse({ kind: 'repositories', repositoryIds: [id] }).success,
      false,
      id,
    );
  }
});

test('event selection is explicit, unique, and bounded to PR events and their supported actions', () => {
  assert.deepEqual(
    githubEventSelectionSchema.parse([
      { event: 'pull_request_review', actions: ['submitted'] },
      { event: 'pull_request', actions: ['merged', 'opened'] },
    ]),
    [
      { event: 'pull_request', actions: ['merged', 'opened'] },
      { event: 'pull_request_review', actions: ['submitted'] },
    ],
  );
  for (const value of [
    [],
    [{ event: 'push', actions: ['created'] }],
    [{ event: 'pull_request', actions: [] }],
    [{ event: 'pull_request_review', actions: ['merged'] }],
    [{ event: 'pull_request', actions: ['opened', 'opened'] }],
    [
      { event: 'pull_request', actions: ['opened'] },
      { event: 'pull_request', actions: ['closed'] },
    ],
  ])
    assert.equal(githubEventSelectionSchema.safeParse(value).success, false);
});

test('branch selection never treats an empty list or a wildcard as all branches', () => {
  assert.deepEqual(githubBranchSelectionSchema.parse({ kind: 'selected', names: ['release/v1', 'main'] }), {
    kind: 'selected',
    names: ['main', 'release/v1'],
  });
  assert.equal(githubBranchSelectionSchema.safeParse({ kind: 'all' }).success, true);
  for (const names of [[], ['main', 'main'], ['*'], ['main\n'], ['main\0'], ['main branch']]) {
    assert.equal(githubBranchSelectionSchema.safeParse({ kind: 'selected', names }).success, false);
  }
});

test('normalized message fields reject arbitrary payloads, unsafe URLs, and wrong types', () => {
  assert.equal(
    githubEventFieldsSchema.safeParse({ 'pullRequest.number': 42, 'pullRequest.title': 'A change' }).success,
    true,
  );
  for (const value of [
    { payload: { secret: 'not a supported field' } },
    { 'pullRequest.number': '42' },
    { 'pullRequest.url': 'not-a-url' },
    { 'comment.url': 'https://' },
    { 'pullRequest.url': 'https://example.test/steal' },
    { 'pullRequest.url': 'https://user@github.com/org/repo/pull/42' },
    { 'pullRequest.url': 'https://github.com:444/org/repo/pull/42' },
    { 'pullRequest.url': 'https://github.com/org/repo/pull/42?token=secret' },
    { 'pullRequest.title': 'x'.repeat(4001) },
  ])
    assert.equal(githubEventFieldsSchema.safeParse(value).success, false);
});
