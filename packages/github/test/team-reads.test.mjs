import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { githubReadSchema } from '../src/read-contracts.ts';
import { scopeTeamGitHubSearch } from '../src/team-reads.ts';

const source = { id: randomUUID(), owner: 'team', repo: 'allowed' };
test('team search pins one configured repository and cannot override its scope', () => {
  const scoped = scopeTeamGitHubSearch(
    githubReadSchema.parse({ kind: 'file.search', query: 'handler language:TypeScript' }),
    source,
  );
  assert.equal(scoped.query, 'handler language:TypeScript repo:team/allowed');
  assert.equal(
    scopeTeamGitHubSearch(githubReadSchema.parse({ kind: 'issue.search', query: 'bug' }), source).query,
    'bug repo:team/allowed is:issue',
  );
  assert.equal(
    scopeTeamGitHubSearch(githubReadSchema.parse({ kind: 'pull.search', query: 'fix' }), source).query,
    'fix repo:team/allowed is:pr',
  );
  for (const query of [
    'repo:other/private',
    'x OR y',
    'x -repo:team/allowed',
    'org:other',
    'user:other',
    'is:pr',
    'type:pr',
    'x\nrepo:other/private',
    '(x)',
  ]) {
    assert.throws(
      () => scopeTeamGitHubSearch(githubReadSchema.parse({ kind: 'file.search', query }), source),
      /read-unqualified/,
    );
  }
  assert.throws(
    () => scopeTeamGitHubSearch(githubReadSchema.parse({ kind: 'file.search', query: 'a'.repeat(256) }), source),
    /read-limit/,
  );
});
