import assert from 'node:assert/strict';
import test from 'node:test';
import { searchAccessTargets } from '../src/source-access.ts';

test('search provenance pins concrete provider objects rather than rerunning search membership', () => {
  assert.deepEqual(
    searchAccessTargets(
      { kind: 'repository.search' },
      { items: [{ url: 'https://api.github.com/repos/octocat/private' }] },
    ),
    [{ kind: 'repository.read', owner: 'octocat', repo: 'private' }],
  );
  assert.deepEqual(
    searchAccessTargets(
      { kind: 'issue.search' },
      { items: [{ url: 'https://api.github.com/repos/octocat/private/issues/7' }] },
    ),
    [{ kind: 'issue.read', owner: 'octocat', repo: 'private', number: 7 }],
  );
  assert.deepEqual(
    searchAccessTargets(
      { kind: 'pull.search' },
      { items: [{ url: 'https://api.github.com/repos/octocat/private/pulls/8' }] },
    ),
    [{ kind: 'pull.read', owner: 'octocat', repo: 'private', number: 8 }],
  );
  assert.deepEqual(
    searchAccessTargets(
      { kind: 'file.search' },
      { items: [{ url: 'https://api.github.com/repos/octocat/private/contents/docs/read%20me.md?ref=main' }] },
    ),
    [{ kind: 'file.read', owner: 'octocat', repo: 'private', path: 'docs/read me.md', ref: 'main' }],
  );
  for (const url of [
    'https://evil.test/repos/octocat/private',
    'https://api.github.com/user',
    'https://api.github.com/repos/octocat/private/issues/0',
  ]) {
    assert.equal(searchAccessTargets({ kind: 'issue.search' }, { items: [{ url }] }), undefined);
  }
  assert.equal(searchAccessTargets({ kind: 'issue.search' }, { items: [{ title: 'Unidentifiable' }] }), undefined);
});
