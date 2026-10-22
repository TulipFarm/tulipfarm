import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { changedFiles, planChecks } from './check.mjs';

const compiled = {
  build: 'tsc -p tsconfig.json',
  typecheck: 'tsc -p tsconfig.json --noEmit',
  test: 'node --test test/*.test.mjs',
};
const workspaces = [
  { name: '@test/core', directory: 'packages/core', scripts: compiled, dependencies: [] },
  { name: '@test/api', directory: 'apps/api', scripts: compiled, dependencies: ['@test/core'] },
  {
    name: '@test/web',
    directory: 'apps/web',
    scripts: { build: 'vite build', typecheck: 'tsc --noEmit', test: 'node --test' },
    dependencies: ['@test/core'],
  },
  { name: '@test/unrelated', directory: 'packages/unrelated', scripts: compiled, dependencies: [] },
];

test('source changes verify the owner and transitive dependents without redundant tsc passes', () => {
  const plan = planChecks(['packages/core/src/index.ts'], workspaces);
  assert.deepEqual(plan.packages, ['@test/api', '@test/core', '@test/web']);
  assert.deepEqual(plan.commands[0], {
    command: 'pnpm',
    args: [
      'exec',
      'turbo',
      'run',
      '@test/core#build',
      '@test/core#test',
      '@test/api#build',
      '@test/api#test',
      '@test/web#build',
      '@test/web#test',
      '@test/web#typecheck',
      '--concurrency=2',
      '--output-logs=errors-only',
    ],
  });
});

test('test-only changes stay in their workspace; docs avoid builds entirely', () => {
  const testOnly = planChecks(['apps/web/test/example.test.ts'], workspaces);
  assert.deepEqual(testOnly.packages, ['@test/web']);
  assert.ok(
    testOnly.commands.some(({ args }) => args.includes('tooling/check-compatibility-pins.test.mjs')),
    'test changes check compatibility pins',
  );
  assert.ok(
    !testOnly.commands.some(({ args }) => args.includes('tooling/check-settings-registry.test.mjs')),
    'test changes do not read configuration',
  );
  const source = planChecks(['packages/core/src/index.ts'], workspaces);
  assert.ok(
    source.commands.some(({ args }) => args.includes('tooling/check-settings-registry.test.mjs')),
    'source changes check the settings registry',
  );
  const configuration = planChecks(['docs/self-hosting/configuration.md'], workspaces);
  assert.ok(
    configuration.commands.some(({ args }) => args.includes('tooling/check-settings-registry.test.mjs')),
    'generated configuration documents stay current',
  );
  const docs = planChecks(['AGENTS.md'], workspaces);
  assert.deepEqual(docs.packages, []);
  assert.deepEqual(docs.commands, [
    { command: 'pnpm', args: ['exec', 'oxfmt', '--check', '--no-error-on-unmatched-pattern', '--', 'AGENTS.md'] },
    { command: 'node', args: ['tooling/check-doc-links.mjs', 'AGENTS.md'] },
  ]);
});

test('dependent traversal is independent of changed-file order', () => {
  const graph = [
    ...workspaces,
    { name: '@test/client', directory: 'packages/client', scripts: compiled, dependencies: ['@test/api'] },
  ];
  const plan = planChecks(['apps/api/test/example.test.mjs', 'packages/core/src/index.ts'], graph);
  assert.deepEqual(plan.packages, ['@test/api', '@test/client', '@test/core', '@test/web']);
});

test('global and unknown inputs fail broad', () => {
  for (const file of [
    'pnpm-lock.yaml',
    'turbo.json',
    '.github/workflows/check.yml',
    'new-root-script.sh',
    'packages/deleted/src/index.ts',
  ]) {
    const plan = planChecks([file], workspaces);
    assert.equal(plan.full, true, file);
    assert.equal(plan.packages.length, 4);
    assert.ok(plan.commands[0].args.includes('//#lint:repo'));
  }
  const tooling = planChecks(['tooling/check.mjs'], workspaces);
  assert.deepEqual(tooling.packages, []);
  assert.ok(tooling.commands[0].args.includes('//#lint:repo'));
});

test('changed files include committed, staged, unstaged, deleted, renamed and untracked paths', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'check-diff-'));
  const git = args => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const commit = message =>
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      message,
    ]);
  try {
    git(['init', '-q']);
    for (const file of ['committed', 'staged', 'unstaged', 'deleted', 'old-name'])
      await writeFile(join(cwd, file), 'before');
    git(['add', '.']);
    commit('baseline');
    git(['branch', 'baseline']);
    await writeFile(join(cwd, 'committed'), 'after');
    git(['add', 'committed']);
    commit('change');
    await writeFile(join(cwd, 'staged'), 'after');
    git(['add', 'staged']);
    await writeFile(join(cwd, 'unstaged'), 'after');
    await rm(join(cwd, 'deleted'));
    git(['mv', 'old-name', 'new-name']);
    await writeFile(join(cwd, 'untracked'), 'new');
    assert.deepEqual(changedFiles('baseline', cwd), [
      'committed',
      'deleted',
      'new-name',
      'old-name',
      'staged',
      'unstaged',
      'untracked',
    ]);
    assert.throws(() => changedFiles('missing-base', cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const mode of ['interrupt', 'parent exit'])
  test(
    `logged run cleans up descendants on ${mode}`,
    { skip: process.platform === 'win32', timeout: 15000 },
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'check-cancel-'));
      let wrapper;
      let descendant;
      try {
        await mkdir(join(cwd, 'reports'));
        const pidFile = join(cwd, 'descendant.pid');
        const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',\`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)\`],{stdio:'inherit'}); console.log('started fixture');${mode === 'parent exit' ? 'setTimeout(()=>process.exit(0),500)' : 'setInterval(()=>{},1000)'}`;
        wrapper = spawn(process.execPath, [resolve('tooling/check-logged.mjs'), process.execPath, '-e', script], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        wrapper.stdout.on('data', chunk => {
          output += chunk;
        });
        wrapper.stderr.on('data', chunk => {
          output += chunk;
        });
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            descendant = Number(await readFile(pidFile, 'utf8'));
            break;
          } catch {
            await delay(25);
          }
        }
        assert.ok(descendant, output);
        const closed = once(wrapper, 'close');
        if (mode === 'interrupt') wrapper.kill('SIGTERM');
        const [code] = await closed;
        assert.equal(code, mode === 'interrupt' ? 143 : 0, output);
        assert.match(output, /started fixture/);
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(descendant, 0);
            await delay(25);
          } catch (error) {
            assert.equal(error.code, 'ESRCH');
            return;
          }
        }
        assert.fail('The test descendant survived cancellation');
      } finally {
        wrapper?.kill('SIGKILL');
        if (descendant) {
          try {
            process.kill(descendant, 'SIGKILL');
          } catch {}
        }
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
