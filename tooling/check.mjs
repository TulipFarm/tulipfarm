import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLogged } from './check-logged.mjs';

const tasks = ['build', 'test'];
const isDocument = file => file.endsWith('.md');
const isCode = file => /\.(?:[cm]?js|jsx|tsx?|cts|mts)$/.test(file);
const typecheckedByBuild = scripts =>
  /^tsc -p tsconfig\.json(?:$| && )/.test(scripts.build ?? '') && scripts.typecheck === 'tsc -p tsconfig.json --noEmit';

export function planChecks(files, workspaces, { full = false, concurrency = 2, continueAlways = false } = {}) {
  const commands = [];
  const selected = new Set();
  const reasons = [];
  let repositoryLint = full;
  let compose = full;
  const add = (command, args) => commands.push({ command, args });
  for (const file of files) {
    if (isDocument(file)) continue;
    const owner = workspaces.find(workspace => file.startsWith(`${workspace.directory}/`));
    if (owner) {
      selected.add(owner.name);
      if (!file.startsWith(`${owner.directory}/test/`)) {
        const pending = [owner.name];
        const visited = new Set(pending);
        while (pending.length) {
          const dependency = pending.pop();
          for (const workspace of workspaces) {
            if (!visited.has(workspace.name) && workspace.dependencies.includes(dependency)) {
              visited.add(workspace.name);
              selected.add(workspace.name);
              pending.push(workspace.name);
            }
          }
        }
      }
    } else if (file.startsWith('infra/')) {
      if (file.endsWith('compose.yaml')) compose = true;
    } else if (file === 'compose.yaml') {
      compose = true;
    } else if (file.startsWith('tooling/')) {
      repositoryLint = true;
      if (
        !/^tooling\/(?:check(?:-.*)?|verification(?:-preflight)?|design-system-lint|model-env|attachment-env|workspace-mcp-acceptance)\.(?:test\.)?mjs$/.test(
          file,
        )
      ) {
        full = true;
        reasons.push(`Shared verification entry point: ${file}`);
      }
    } else {
      full = true;
      reasons.push(`Shared or unclassified input: ${file}`);
    }
  }
  if (full) {
    for (const workspace of workspaces) selected.add(workspace.name);
    repositoryLint = compose = true;
  }
  const turbo = ['exec', 'turbo', 'run'];
  for (const workspace of workspaces.filter(workspace => selected.has(workspace.name))) {
    for (const task of tasks) if (workspace.scripts[task]) turbo.push(`${workspace.name}#${task}`);
    if (workspace.scripts.typecheck && !typecheckedByBuild(workspace.scripts))
      turbo.push(`${workspace.name}#typecheck`);
  }
  if (repositoryLint) turbo.push('//#lint:repo');
  if (turbo.length > 3) {
    turbo.push(`--concurrency=${concurrency}`, '--output-logs=errors-only');
    if (continueAlways) turbo.push('--continue=always');
    add('pnpm', turbo);
  }
  if (!repositoryLint) {
    const code = files.filter(file => isCode(file) && existsSync(file));
    for (let index = 0; index < code.length; index += 100) {
      add('pnpm', [
        'exec',
        'oxlint',
        '--deny-warnings',
        '--no-error-on-unmatched-pattern',
        '--threads=2',
        '--',
        ...code.slice(index, index + 100),
      ]);
    }
    const present = files.filter(file => existsSync(file));
    for (let index = 0; index < present.length; index += 100) {
      add('pnpm', [
        'exec',
        'oxfmt',
        '--check',
        '--no-error-on-unmatched-pattern',
        '--',
        ...present.slice(index, index + 100),
      ]);
    }
    if (files.some(file => /^(?:apps|packages)\/[^/]+\/(?:src|test|common)\//.test(file))) {
      add('node', ['--test', 'tooling/check-compatibility-pins.test.mjs']);
    }
    if (
      files.some(file =>
        /^(?:(?:apps|packages)\/[^/]+\/src\/|packages\/config\/|self-host\/|docs\/self-hosting\/configuration\.md$)/.test(
          file,
        ),
      )
    ) {
      add('node', ['--test', 'tooling/check-settings-registry.test.mjs']);
    }
  }
  const documents = files.filter(file => isDocument(file) && existsSync(file));
  if (documents.length) add('node', ['tooling/check-doc-links.mjs', ...documents]);
  if (!repositoryLint && files.some(file => !existsSync(file))) add('node', ['tooling/check-doc-links.mjs']);
  if (compose) {
    add('docker', ['compose', 'config', '--quiet']);
  }
  return { full, reasons, packages: [...selected].sort(), commands };
}

export function changedFiles(base = 'origin/main', cwd = process.cwd()) {
  const git = args =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  const ancestor = git(['merge-base', base, 'HEAD']).trim();
  return [
    ...new Set(
      [
        ...git(['diff', '--name-only', '--no-renames', '-z', ancestor, '--']).split('\0'),
        ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
      ].filter(Boolean),
    ),
  ].sort();
}

export async function readWorkspaces(root = process.cwd()) {
  const workspaces = [];
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(resolve(root, parent), { withFileTypes: true })) {
      const directory = `${parent}/${entry.name}`;
      const path = resolve(root, directory, 'package.json');
      if (!entry.isDirectory() || !existsSync(path)) continue;
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      workspaces.push({
        name: manifest.name,
        directory,
        scripts: manifest.scripts ?? {},
        dependencies: Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.peerDependencies,
          ...manifest.optionalDependencies,
        }),
      });
    }
  }
  return workspaces;
}

async function main() {
  let base = 'origin/main';
  let full = false;
  let dryRun = false;
  let concurrency = 2;
  let continueAlways = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--full') full = true;
    else if (arg === '--plan') dryRun = true;
    else if (arg.startsWith('--base=')) base = arg.slice(7);
    else if (/^--concurrency=[1-9]\d*$/.test(arg)) concurrency = Number(arg.split('=')[1]);
    else if (arg === '--continue=always') continueAlways = true;
    else
      throw new Error(
        `Unknown check option: ${arg}. Use --plan, --full, --base=<ref>, --concurrency=<n>, or --continue=always.`,
      );
  }
  const files = full ? [] : changedFiles(base);
  const plan = planChecks(files, await readWorkspaces(), { full, concurrency, continueAlways });
  if (dryRun) {
    console.log(JSON.stringify({ base: full ? null : base, files, ...plan }, null, 2));
    return;
  }
  console.log(
    `${plan.full ? 'Full' : 'Changed'} check: ${files.length} changed files, ${plan.packages.length} workspaces, ${plan.commands.length} commands. Use --plan for details.`,
  );
  for (const reason of plan.reasons) console.log(reason);
  if (!plan.commands.length)
    console.log('No changed executable inputs or documentation to check. Use --full for a clean-checkout audit.');
  for (const { command, args } of plan.commands) {
    const result = await runLogged(command, args, 'reports/check', process.env.GITHUB_STEP_SUMMARY);
    if (result.code !== 0) {
      process.exitCode = result.code;
      if (!continueAlways || result.code >= 128) break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
