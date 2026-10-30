import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrationProblems, streams } from './check-migration-numbers.mjs';

const script = fileURLToPath(new URL('check-migration-numbers.mjs', import.meta.url));

test('a stream must be numbered from 0001 without duplicates or gaps', () => {
  assert.deepEqual(migrationProblems('s', ['0001_a.sql', '0002_b.sql', 'README.md']), []);
  assert.deepEqual(migrationProblems('s', ['0001_a.sql', '0002_b.sql', '0002_c.sql']), [
    's: 0002_b.sql and 0002_c.sql share number 2',
  ]);
  assert.deepEqual(migrationProblems('s', ['0001_a.sql', '0003_c.sql']), ['s: number 0002 is missing']);
  assert.deepEqual(migrationProblems('s', ['0001_a.sql', '2_b.sql']), ['s/2_b.sql: invalid name']);
});

test('--base catches a migration number that main took after the branch was cut', t => {
  const repo = mkdtempSync(join(tmpdir(), 'migration-numbers-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const add = (stream, name) => {
    mkdirSync(join(repo, stream), { recursive: true });
    writeFileSync(join(repo, stream, name), 'SELECT 1;\n');
    git('add', '.');
    git('commit', '-qm', name);
  };
  const check = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ci@example.com');
  git('config', 'user.name', 'CI');
  git('config', 'commit.gpgsign', 'false');
  for (const stream of streams) add(stream, '0001_baseline.sql');
  git('checkout', '-qb', 'feature');
  add(streams[0], '0002_feature.sql');
  git('checkout', '-q', 'main');
  add(streams[0], '0002_other.sql');
  git('checkout', '-q', 'feature');

  assert.equal(check().status, 0, 'the branch alone is valid');
  const stale = check('--base', 'main');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /0002_feature\.sql and 0002_other\.sql share number 2/);

  git('mv', join(streams[0], '0002_feature.sql'), join(streams[0], '0003_feature.sql'));
  git('commit', '-qm', 'renumber');
  assert.equal(check('--base', 'main').status, 0, 'renumbering after main fixes it');
});
