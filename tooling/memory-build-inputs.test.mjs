import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packages = [
  ['@tulipfarm/memory-core', 'packages/memory-core'],
  ['@tulipfarm/memory-postgres', 'packages/memory-postgres'],
  ['@tulipfarm/knowledge', 'packages/knowledge'],
  ['@tulipfarm/conversations', 'packages/conversations'],
  ['@tulipfarm/api', 'apps/api'],
  ['@tulipfarm/worker', 'apps/worker'],
];

function sourceFiles(directory, prefix = 'src') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(directory, path) : [path];
  });
}

async function commandOutput(args) {
  const child = spawn('pnpm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Command interrupted: ${signal}`));
      else resolve(code);
    });
  });
  assert.equal(code, 0, Buffer.concat(stderr).toString());
  return Buffer.concat(stdout).toString();
}

test('memory extraction builds retain every compiler input while test tasks retain their test files', async () => {
  const tasks = JSON.parse(
    await commandOutput([
      'exec',
      'turbo',
      'run',
      'build',
      'test',
      '--dry=json',
      ...packages.map(([name]) => `--filter=${name}`),
    ]),
  ).tasks;
  for (const [name, directory] of packages) {
    const path = join(root, directory);
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    const config = JSON.parse(readFileSync(join(path, 'tsconfig.json'), 'utf8'));
    assert.equal(manifest.scripts.build, 'tsc -p tsconfig.json');
    assert.deepEqual(config.include, ['src']);
    const build = tasks.find(task => task.taskId === `${name}#build`);
    const tests = tasks.find(task => task.taskId === `${name}#test`);
    assert.ok(build, name);
    assert.ok(tests, name);
    for (const input of ['package.json', 'tsconfig.json', ...sourceFiles(path)]) {
      assert.ok(Object.hasOwn(build.inputs, input), `${name}: missing build input ${input}`);
    }
    const compilerFiles = await commandOutput(['exec', 'tsc', '-p', `${directory}/tsconfig.json`, '--listFilesOnly']);
    for (const file of compilerFiles.trim().split('\n')) {
      assert.ok(isAbsolute(file), `${name}: unexpected compiler output ${file}`);
      const input = relative(path, file).split(sep).join('/');
      if (!input.startsWith('../') && !input.startsWith('node_modules/')) {
        assert.ok(Object.hasOwn(build.inputs, input), `${name}: missing compiler input ${input}`);
      }
    }
    assert.ok(
      !Object.keys(build.inputs).some(input => input.startsWith('test/')),
      `${name}: uncompiled test build inputs`,
    );
    const testFiles = readdirSync(join(path, 'test')).filter(file => file.endsWith('.mjs'));
    assert.ok(testFiles.length > 0, name);
    for (const file of testFiles) {
      assert.ok(Object.hasOwn(tests.inputs, `test/${file}`), `${name}: missing test input ${file}`);
    }
  }
});
