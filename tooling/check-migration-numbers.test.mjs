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
  assert.deepEqual(migrationProblems('s', ['0001_a.sql', '0002_b.sql', 'LATEST', 'README.md'], '0002_b.sql\n'), []);
  assert.deepEqual(migrationProblems('s', ['0001_a.sql', '0002_b.sql', '0002_c.sql'], '0002_c.sql'), [
    's: 0002_b.sql and 0002_c.sql share number 2',
  ]);
  assert.deepEqual(migrationProblems('s', ['0001_a.sql', '0003_c.sql'], '0003_c.sql'), ['s: number 0002 is missing']);
  assert.deepEqual(migrationProblems('s', ['0001_a.sql', '2_b.sql'], '2_b.sql'), ['s/2_b.sql: invalid name']);
});

test('LATEST must name the newest migration, and the message says what to write', () => {
  assert.deepEqual(migrationProblems('s', ['0001_a.sql', '0002_b.sql'], '0001_a.sql\n'), [
    's/LATEST: names 0001_a.sql, but the newest migration is 0002_b.sql; write 0002_b.sql to it',
  ]);
  assert.deepEqual(migrationProblems('s', ['0001_a.sql'], undefined), [
    's/LATEST: names nothing, but the newest migration is 0001_a.sql; write 0001_a.sql to it',
  ]);
});

function scratchRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'migration-numbers-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  const add = (stream, name) => {
    mkdirSync(join(repo, stream), { recursive: true });
    writeFileSync(join(repo, stream, name), 'SELECT 1;\n');
    writeFileSync(join(repo, stream, 'LATEST'), `${name}\n`);
    git('add', '.');
    git('commit', '-qm', name);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ci@example.com');
  git('config', 'user.name', 'CI');
  git('config', 'commit.gpgsign', 'false');
  for (const stream of streams) add(stream, '0001_baseline.sql');
  return { repo, git, add };
}

test('two branches that each add the next migration cannot both merge', t => {
  const { repo, git, add } = scratchRepo(t);
  git('checkout', '-qb', 'intent-user');
  add(streams[1], '0002_github_intent_user.sql');
  git('checkout', '-qb', 'bot-grants', 'main');
  add(streams[1], '0002_github_bot_grants.sql');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'merge intent-user', 'intent-user');

  const merge = spawnSync('git', ['merge', '--no-ff', '-m', 'merge bot-grants', 'bot-grants'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(merge.status, 1);
  assert.match(merge.stdout, /CONFLICT \(content\): Merge conflict in packages\/workspace-storage\/common\/LATEST/);
});

test('--base catches a migration number that main took after the branch was cut', t => {
  const { repo, git, add } = scratchRepo(t);
  const check = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });

  git('checkout', '-qb', 'feature');
  add(streams[0], '0002_feature.sql');
  git('checkout', '-q', 'main');
  add(streams[0], '0002_other.sql');
  git('checkout', '-q', 'feature');

  assert.equal(check().status, 0, 'the branch alone is valid');
  const stale = check('--base', 'main');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /0002_feature\.sql and 0002_other\.sql share number 2/);

  assert.throws(() => git('merge', '-q', 'main'), 'main and the branch both rewrote LATEST');
  git('mv', join(streams[0], '0002_feature.sql'), join(streams[0], '0003_feature.sql'));
  writeFileSync(join(repo, streams[0], 'LATEST'), '0003_feature.sql\n');
  git('add', '.');
  git('commit', '-qm', 'merge main and renumber');
  assert.equal(check('--base', 'main').status, 0, 'renumbering after main fixes it');
});
