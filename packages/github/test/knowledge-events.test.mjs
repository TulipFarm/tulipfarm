import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubKnowledgeEvents, githubKnowledgeTrigger, mergeGitHubKnowledgeChanges } from '../src/knowledge-events.ts';

const repository = { id: 7001, full_name: 'acme/handbook', default_branch: 'main' };
const changed = (...repositories) => ({ kind: 'changed', repositories, all: false });

test('content events make the delivering repository stale by its numeric ID, never its name', () => {
  for (const event of [
    'issues',
    'issue_comment',
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'discussion',
    'discussion_comment',
  ])
    assert.deepEqual(
      githubKnowledgeTrigger(event, { action: 'edited', repository, issue: { title: 'Ignored content' } }),
      changed('7001'),
      event,
    );
  assert.deepEqual(githubKnowledgeTrigger('issues', { repository: { id: '7002' } }), changed('7002'));
  assert.deepEqual(githubKnowledgeTrigger('issues', { repository: { full_name: 'acme/handbook' } }), {
    kind: 'rejected',
    reason: 'payload-invalid',
  });
});

test('pushes count only on the default branch', () => {
  assert.deepEqual(githubKnowledgeTrigger('push', { ref: 'refs/heads/main', repository }), changed('7001'));
  for (const ref of ['refs/heads/feature', 'refs/tags/v1', 'refs/heads/main-old'])
    assert.deepEqual(githubKnowledgeTrigger('push', { ref, repository }), {
      kind: 'ignored',
      reason: 'non-default-branch',
    });
  assert.deepEqual(githubKnowledgeTrigger('push', { repository }), { kind: 'rejected', reason: 'payload-invalid' });
});

test('repository lifecycle changes count, other repository actions do not', () => {
  for (const action of ['renamed', 'deleted', 'transferred', 'privatized', 'publicized', 'edited', 'archived'])
    assert.deepEqual(githubKnowledgeTrigger('repository', { action, repository }), changed('7001'), action);
  assert.deepEqual(githubKnowledgeTrigger('repository', { action: 'created', repository }), {
    kind: 'ignored',
    reason: 'unsupported-action',
  });
});

test('installation changes mark every repository they add or remove', () => {
  assert.deepEqual(
    githubKnowledgeTrigger('installation', { action: 'deleted', repositories: [{ id: 1 }, { id: 2 }, { id: 1 }] }),
    changed('1', '2'),
  );
  assert.deepEqual(
    githubKnowledgeTrigger('installation_repositories', {
      action: 'added',
      repositories_added: [{ id: 3 }],
      repositories_removed: [{ id: 4 }],
    }),
    changed('3', '4'),
  );
  assert.deepEqual(githubKnowledgeTrigger('installation', { action: 'suspend' }), {
    kind: 'ignored',
    reason: 'no-repository',
  });
  assert.deepEqual(
    githubKnowledgeTrigger('installation', {
      repositories: Array.from({ length: 1001 }, (_, index) => ({ id: index + 1 })),
    }),
    { kind: 'changed', repositories: [], all: true },
  );
});

test('pings, unsupported events and invalid repository IDs change nothing', () => {
  assert.deepEqual(githubKnowledgeTrigger('ping', { zen: 'Keep it simple' }), { kind: 'ignored', reason: 'ping' });
  assert.deepEqual(githubKnowledgeTrigger('star', { repository }), { kind: 'ignored', reason: 'unsupported-event' });
  assert.deepEqual(githubKnowledgeTrigger('issues', { repository: { id: '0' } }), {
    kind: 'ignored',
    reason: 'no-repository',
  });
  assert.deepEqual(githubKnowledgeTrigger('issues', { repository: { id: '1; DROP' } }), {
    kind: 'ignored',
    reason: 'no-repository',
  });
  assert.ok(githubKnowledgeEvents.includes('installation_repositories'));
});

test('pending deliveries merge into one deduplicated set of repositories', () => {
  assert.deepEqual(
    mergeGitHubKnowledgeChanges([
      { repositories: ['1', '2'], all: false },
      { repositories: ['2', '3'], all: false },
    ]),
    { repositories: ['1', '2', '3'], all: false },
  );
  assert.deepEqual(
    mergeGitHubKnowledgeChanges([
      { repositories: ['1'], all: false },
      { repositories: [], all: true },
    ]),
    { repositories: [], all: true },
  );
  assert.deepEqual(mergeGitHubKnowledgeChanges([]), { repositories: [], all: false });
});
