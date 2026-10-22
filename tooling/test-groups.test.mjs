import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));

async function testedWorkspaces() {
  const names = [];
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = await readJson(`${parent}/${entry.name}/package.json`).catch(() => undefined);
      if (manifest?.scripts?.test) names.push(manifest.name);
    }
  }
  return names.sort();
}

async function testGroups() {
  const { scripts } = await readJson('package.json');
  return Object.entries(scripts)
    .filter(([name, command]) => name.startsWith('test:') && command.startsWith('turbo run test '))
    .map(([name, command]) => ({ name, filters: [...command.matchAll(/--filter=(\S+)/g)].map(match => match[1]) }));
}

test('every tested workspace runs in exactly one CI test group', async () => {
  const groups = await testGroups();
  assert.ok(groups.length > 1);
  const grouped = groups.flatMap(group => group.filters).sort();
  assert.deepEqual(grouped, [...new Set(grouped)], 'a workspace is in more than one test group');
  assert.deepEqual(grouped, await testedWorkspaces());
});

test('the CI matrix runs every test group alongside lint and typecheck', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const matrix = /^\s+task: \[(.*)\]$/m.exec(workflow)?.[1];
  assert.ok(matrix, 'CI matrix task list not found');
  const tasks = matrix.split(',').map(task => task.trim().replace(/^'(.*)'$/, '$1'));
  assert.deepEqual(tasks.sort(), ['lint', 'typecheck', ...(await testGroups()).map(group => group.name)].sort());
});
