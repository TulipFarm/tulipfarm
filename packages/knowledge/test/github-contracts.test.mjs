import test from 'node:test';
import assert from 'node:assert/strict';
import {
  githubCorpusKinds,
  githubCorpusLimits,
  githubCorpusSelectionSchema,
  githubExcludePatternProblem,
  githubKnowledgeSettingsSchema,
  githubPathOptedOut,
} from '../dist/github-contracts.js';

const repositories = count =>
  Array.from({ length: count }, (_, index) => `acme/repo-${String(index).padStart(4, '0')}`).sort();

test('a GitHub selection names up to 1,000 repositories and indexes full history without a cutoff', () => {
  assert.equal(githubCorpusLimits.repositories, 1000);
  const selection = githubCorpusSelectionSchema.parse({ repositories: repositories(1000), kinds: ['docs'] });
  assert.equal(selection.repositories.length, 1000);
  assert.equal(selection.after, undefined);
  assert.equal(
    githubCorpusSelectionSchema.safeParse({ repositories: repositories(1001), kinds: ['docs'] }).success,
    false,
  );
  assert.equal(
    githubCorpusSelectionSchema.safeParse({ repositories: repositories(2), kinds: ['docs'], after: '2001-01-01' })
      .success,
    true,
  );
  assert.equal(
    githubCorpusSelectionSchema.safeParse({ repositories: repositories(2), kinds: ['docs'], window: 'rolling-90d' })
      .success,
    false,
  );
});

test('an all-repositories selection names no repositories and every content kind is available', () => {
  assert.deepEqual([...githubCorpusKinds].sort(), ['code', 'commits', 'discussions', 'docs', 'issues', 'pulls']);
  assert.equal(
    githubCorpusSelectionSchema.safeParse({ scope: 'all', repositories: [], kinds: [...githubCorpusKinds].sort() })
      .success,
    true,
  );
  assert.equal(
    githubCorpusSelectionSchema.safeParse({ scope: 'all', repositories: ['acme/handbook'], kinds: ['docs'] }).success,
    false,
  );
  assert.equal(githubCorpusSelectionSchema.safeParse({ repositories: [], kinds: ['docs'] }).success, false);
  assert.equal(githubCorpusSelectionSchema.safeParse({ scope: 'all', repositories: [], kinds: [] }).success, false);
});

test('exclude patterns compile, stay bounded and reject catastrophic shapes', () => {
  for (const pattern of [
    '\\.min\\.js$',
    '^vendor/',
    '(^|/)node_modules/',
    '.*/test/.*',
    '\\.(png|jpe?g|gif)$',
    'x{1,5}',
  ])
    assert.equal(githubExcludePatternProblem(pattern), null, pattern);
  for (const pattern of [
    '(a+)+',
    '(a|a)*',
    '((a)?)*',
    '(\\w)\\1',
    '(?<x>a)\\k<x>',
    'a?a?a?a?a?b',
    'x{2,}y*',
    'a?a?.*b',
  ])
    assert.equal(githubExcludePatternProblem(pattern), 'unsafe', pattern);
  assert.equal(githubExcludePatternProblem('['), 'invalid');
  assert.equal(githubExcludePatternProblem('a'.repeat(githubCorpusLimits.excludePatternLength + 1)), 'length');
  const selection = (excludePaths, kinds = ['docs']) =>
    githubCorpusSelectionSchema.safeParse({ repositories: ['acme/handbook'], kinds, excludePaths });
  assert.equal(selection(['(a+)+']).success, false);
  assert.equal(
    selection(Array.from({ length: githubCorpusLimits.excludePatterns + 1 }, (_, i) => `^d${i}/`)).success,
    false,
  );
  assert.equal(selection(['^vendor/']).success, true);
});

test('opted-out paths match anywhere in the repository path within a bounded time', () => {
  const selection = { excludePaths: ['.*/test/.*', '^vendor/', '\\.min\\.js$'] };
  assert.equal(githubPathOptedOut(selection, 'src/test/a.ts'), true);
  assert.equal(githubPathOptedOut(selection, 'vendor/lib.js'), true);
  assert.equal(githubPathOptedOut(selection, 'web/app.min.js'), true);
  assert.equal(githubPathOptedOut(selection, 'src/vendor/a.ts'), false);
  assert.equal(githubPathOptedOut({}, 'src/test/a.ts'), false);
  // The costliest accepted shapes stay within a few milliseconds per test on the longest tested path.
  const patterns = ['a?.*b', 'a?a?a?a?b', 'a{0,16}b', '\\w+b'];
  for (const pattern of patterns) assert.equal(githubExcludePatternProblem(pattern), null, pattern);
  const started = performance.now();
  for (let index = 0; index < 20; index++) githubPathOptedOut({ excludePaths: patterns }, 'a'.repeat(1024 - index));
  assert.ok(performance.now() - started < 1000);
});

test('source settings carry kinds, patterns, an optional cutoff and the repositories left out', () => {
  const base = { commandId: crypto.randomUUID(), kinds: ['code', 'docs'], excludePaths: [], after: null };
  assert.equal(githubKnowledgeSettingsSchema.safeParse({ ...base, excludedRepositories: ['1', '2'] }).success, true);
  assert.equal(
    githubKnowledgeSettingsSchema.safeParse({ ...base, after: '2020-02-30', excludedRepositories: [] }).success,
    false,
  );
  assert.equal(
    githubKnowledgeSettingsSchema.safeParse({
      ...base,
      excludedRepositories: Array.from({ length: 1001 }, (_, i) => String(i + 1)),
    }).success,
    false,
  );
});
