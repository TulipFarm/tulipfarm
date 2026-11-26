import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  completeGitHubPullRequestEvent,
  extractGitHubObservedHandles,
  githubEventInputByteLimit,
  GitHubEventError,
  matchesGitHubEvent,
  normalizeGitHubEvent,
} from '../src/events.ts';

const pull = () => ({
  number: 42,
  title: 'Private PR title',
  html_url: 'https://github.com/acme/widget/pull/42',
  user: { login: 'author' },
  state: 'open',
  merged: false,
  merged_at: null,
  body: 'Private body not approved for export',
  base: { ref: 'main', repo: { id: 10 } },
  head: { ref: 'feature', repo: null },
});
const payload = () => ({
  action: 'opened',
  installation: { id: 20 },
  number: 42,
  repository: {
    id: 10,
    full_name: 'acme/widget',
    html_url: 'https://github.com/acme/widget',
    private: true,
    owner: { id: 30, type: 'Organization' },
  },
  pull_request: pull(),
  secret: 'never retained',
});
const filter = () => ({
  repositories: { kind: 'repositories', repositoryIds: ['10'] },
  events: [{ event: 'pull_request', actions: ['opened'] }],
  baseBranches: { kind: 'selected', names: ['main'] },
  headBranches: { kind: 'selected', names: ['feature'] },
});
const failure = code => error => error instanceof GitHubEventError && error.code === code;

test('normalization retains bounded approved fields and stable IDs, not the raw provider body', () => {
  const event = normalizeGitHubEvent('pull_request', payload());
  assert.equal(event.kind, 'event');
  assert.equal(event.repositoryId, '10');
  assert.equal(event.installationId, '20');
  assert.equal(event.privateRepository, true);
  assert.equal(event.fields['pullRequest.headBranch'], 'feature', 'a deleted fork does not erase its recorded branch');
  assert.equal(event.fields['pullRequest.author'], 'author');
  assert.equal(JSON.stringify(event).includes('not approved'), false);
  assert.equal(JSON.stringify(event).includes('never retained'), false);
  assert.equal(matchesGitHubEvent(event, filter()), true);
  for (const patch of [
    { repositories: { kind: 'repositories', repositoryIds: ['11'] } },
    { events: [{ event: 'pull_request', actions: ['closed'] }] },
    { baseBranches: { kind: 'selected', names: ['release'] } },
    { headBranches: { kind: 'selected', names: ['other'] } },
  ])
    assert.equal(matchesGitHubEvent(event, { ...filter(), ...patch }), false);
  const organization = {
    ...filter(),
    repositories: { kind: 'organization', organizationId: '30', includeFuture: true },
  };
  assert.equal(matchesGitHubEvent(event, organization), true);
  assert.equal(matchesGitHubEvent({ ...event, repositoryId: '99' }, organization), true);
  assert.equal(matchesGitHubEvent({ ...event, ownerKind: 'user' }, organization), false);
  assert.equal(matchesGitHubEvent({ ...event, ownerId: '31' }, organization), false);
});

test('merged is derived only from a closed PR with consistent merge evidence', () => {
  const body = payload();
  body.action = 'closed';
  body.pull_request.state = 'closed';
  assert.equal(normalizeGitHubEvent('pull_request', body).action, 'closed');
  body.pull_request.merged = true;
  body.pull_request.merged_at = '2026-10-13T00:00:00Z';
  const merged = normalizeGitHubEvent('pull_request', body);
  assert.equal(merged.action, 'merged');
  assert.equal(merged.fields['event.action'], 'merged');
  assert.equal(merged.fields['pullRequest.state'], 'merged');
  assert.equal(
    matchesGitHubEvent(merged, { ...filter(), events: [{ event: 'pull_request', actions: ['closed'] }] }),
    false,
  );
  delete body.pull_request.merged;
  assert.throws(() => normalizeGitHubEvent('pull_request', body), failure('event-invalid'));
  body.action = 'merged';
  assert.deepEqual(normalizeGitHubEvent('pull_request', body), { kind: 'ignored', reason: 'unsupported-action' });
});

test('review events handle nullable bodies without inventing template values', () => {
  const body = payload();
  body.action = 'submitted';
  delete body.pull_request.merged;
  body.review = {
    state: 'approved',
    body: null,
    pull_request_url: 'https://api.github.com/repos/acme/widget/pulls/42',
  };
  const event = normalizeGitHubEvent('pull_request_review', body);
  assert.equal(event.fields['review.state'], 'approved');
  assert.equal(Object.hasOwn(event.fields, 'review.body'), false);
  body.review.body = 'Looks good';
  assert.equal(normalizeGitHubEvent('pull_request_review', body).fields['review.body'], 'Looks good');
  body.review.pull_request_url = 'https://api.github.com/repos/acme/widget/pulls/43';
  assert.throws(() => normalizeGitHubEvent('pull_request_review', body), failure('event-context-mismatch'));
});

test('issue comments are ignored for issues and wait for bound PR context before matching', () => {
  const body = payload();
  body.action = 'created';
  delete body.pull_request;
  delete body.number;
  body.issue = {
    number: 42,
    title: 'Title when comment arrived',
    html_url: 'https://github.com/acme/widget/pull/42',
    user: { login: 'author' },
  };
  body.comment = { body: 'A comment', html_url: 'https://github.com/acme/widget/pull/42#issuecomment-123' };
  assert.deepEqual(normalizeGitHubEvent('issue_comment', body), { kind: 'ignored', reason: 'not-a-pull-request' });
  body.issue.pull_request = { url: 'https://api.github.com/repos/acme/widget/pulls/42' };
  const pending = normalizeGitHubEvent('issue_comment', body);
  assert.equal(pending.kind, 'pull-request-required');
  assert.equal(Object.hasOwn(pending.fields, 'pullRequest.baseBranch'), false);
  const completed = completeGitHubPullRequestEvent(pending, pull());
  assert.equal(completed.kind, 'event');
  assert.equal(completed.fields['pullRequest.title'], 'Title when comment arrived');
  assert.equal(completed.fields['pullRequest.baseBranch'], 'main');
  assert.equal(
    matchesGitHubEvent(completed, { ...filter(), events: [{ event: 'issue_comment', actions: ['created'] }] }),
    true,
  );
  assert.throws(
    () => completeGitHubPullRequestEvent(pending, { ...pull(), number: 43 }),
    failure('event-context-mismatch'),
  );
  assert.throws(
    () => completeGitHubPullRequestEvent(pending, { ...pull(), base: { ref: 'main', repo: { id: 99 } } }),
    failure('event-context-mismatch'),
  );
  assert.throws(
    () =>
      completeGitHubPullRequestEvent(
        { ...pending, fields: { ...pending.fields, 'pullRequest.baseBranch': 'unverified' } },
        pull(),
      ),
    failure('event-invalid'),
  );
});

test('comment links, repository identity, missing branch context and unsafe numeric IDs fail closed', () => {
  const body = payload();
  body.action = 'created';
  body.comment = { body: 'Inline', html_url: 'https://github.com/acme/widget/pull/42#discussion_r123' };
  assert.equal(normalizeGitHubEvent('pull_request_review_comment', body).fields['comment.body'], 'Inline');
  body.comment.html_url = 'https://github.com/acme/other/pull/42#discussion_r123';
  assert.throws(() => normalizeGitHubEvent('pull_request_review_comment', body), failure('event-context-mismatch'));
  const noBranch = payload();
  delete noBranch.pull_request.base;
  assert.throws(() => normalizeGitHubEvent('pull_request', noBranch), failure('event-invalid'));
  const wrongId = payload();
  wrongId.repository.id = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => normalizeGitHubEvent('pull_request', wrongId), failure('event-invalid'));
  const wrongNumber = payload();
  wrongNumber.number = 43;
  assert.throws(() => normalizeGitHubEvent('pull_request', wrongNumber), failure('event-context-mismatch'));
  const tooLong = payload();
  tooLong.pull_request.title = 'x'.repeat(4001);
  assert.throws(() => normalizeGitHubEvent('pull_request', tooLong), failure('event-invalid'));
  const tooLarge = payload();
  tooLarge.pull_request.title = '\0'.repeat(4000);
  tooLarge.pull_request.user.login = '\0'.repeat(4000);
  assert.throws(() => normalizeGitHubEvent('pull_request', tooLarge), failure('event-input-too-large'));
  assert.deepEqual(normalizeGitHubEvent('push', {}), { kind: 'ignored', reason: 'unsupported-event' });
});

test('normalized input accepts exactly 32 KiB and rejects one byte more', () => {
  const body = payload();
  body.pull_request.title = '\0'.repeat(4000);
  body.pull_request.user.login = '';
  const remaining =
    githubEventInputByteLimit - Buffer.byteLength(JSON.stringify(normalizeGitHubEvent('pull_request', body)));
  body.pull_request.user.login = '\0'.repeat(Math.floor(remaining / 6)) + 'x'.repeat(remaining % 6);
  assert.equal(
    Buffer.byteLength(JSON.stringify(normalizeGitHubEvent('pull_request', body))),
    githubEventInputByteLimit,
  );
  body.pull_request.user.login += 'x';
  assert.throws(() => normalizeGitHubEvent('pull_request', body), failure('event-input-too-large'));
});

test('normalization accepts pull request and issue users with or without numeric IDs and rejects unsafe IDs', () => {
  const withId = payload();
  withId.pull_request.user = { id: 424242, login: 'dhruv' };
  const prEvent = normalizeGitHubEvent('pull_request', withId);
  assert.equal(prEvent.kind, 'event');
  assert.equal(prEvent.fields['pullRequest.author'], 'dhruv');

  const issueComment = payload();
  issueComment.action = 'created';
  delete issueComment.pull_request;
  delete issueComment.number;
  issueComment.issue = {
    number: 42,
    title: 'Commented PR',
    html_url: 'https://github.com/acme/widget/pull/42',
    user: { id: 424242, login: 'dhruv' },
    pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/42' },
  };
  issueComment.comment = { body: 'Ship it', html_url: 'https://github.com/acme/widget/pull/42#issuecomment-77' };
  assert.equal(normalizeGitHubEvent('issue_comment', issueComment).fields['pullRequest.author'], 'dhruv');

  const negativeId = payload();
  negativeId.pull_request.user = { id: -1, login: 'dhruv' };
  assert.throws(() => normalizeGitHubEvent('pull_request', negativeId), failure('event-invalid'));

  const unsafeId = payload();
  unsafeId.pull_request.user = { id: Number.MAX_SAFE_INTEGER + 1, login: 'dhruv' };
  assert.throws(() => normalizeGitHubEvent('pull_request', unsafeId), failure('event-invalid'));
});

test('extractGitHubObservedHandles extracts and deduplicates standard webhook users without throwing', () => {
  const observed = extractGitHubObservedHandles({
    sender: { id: 101, login: 'alice' },
    pull_request: {
      user: { id: 101, login: 'alice', name: 'Alice Example' },
      merged_by: { id: 102, login: 'bob', name: null },
    },
    issue: { user: { id: 103, login: 'carol' } },
    comment: { user: { id: 104, login: 'dave', type: 'User' } },
    review: { user: { id: 105, login: 'erin' } },
    pusher: { id: 106, login: 'frank', name: 'Frank' },
    commits: [
      { author: { id: 107, login: 'grace', name: 'Grace' } },
      { author: { id: 108, username: 'heidi', name: 'Heidi' } },
      { author: { id: 101, login: 'alice-duplicate' } },
      { author: { name: 'No ID', email: 'noid@example.com' } },
      null,
      'invalid-commit',
    ],
  });
  assert.deepEqual(observed, [
    { externalId: '101', handle: 'alice', displayName: 'Alice Example' },
    { externalId: '102', handle: 'bob', displayName: null },
    { externalId: '103', handle: 'carol' },
    { externalId: '104', handle: 'dave' },
    { externalId: '105', handle: 'erin' },
    { externalId: '106', handle: 'frank', displayName: 'Frank' },
    { externalId: '107', handle: 'grace', displayName: 'Grace' },
    { externalId: '108', handle: 'heidi', displayName: 'Heidi' },
  ]);

  assert.deepEqual(
    extractGitHubObservedHandles({
      sender: { login: 'missing-id' },
      pull_request: {
        user: { id: 201, login: 'dependabot[bot]', type: 'Bot' },
        merged_by: null,
      },
      issue: { user: { id: 0, login: 'zero-id' } },
      comment: { user: { id: -5, login: 'neg-id' } },
      review: { user: { id: Number.MAX_SAFE_INTEGER + 1, login: 'unsafe-id' } },
      pusher: { name: 'git-pusher', email: 'push@example.com' },
      commits: [
        { author: { id: 202, login: 'bad login' } },
        { author: { id: 203, login: 'org-actor', type: 'Organization' } },
      ],
    }),
    [],
  );

  for (const invalid of [null, undefined, 42, 'not-an-object', [], { sender: 'oops', commits: 'not-an-array' }]) {
    assert.deepEqual(extractGitHubObservedHandles(invalid), []);
  }
});
