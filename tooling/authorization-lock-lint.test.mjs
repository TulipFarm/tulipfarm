import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const cases = {
  'hard-coded-around-callback': [
    `async function transaction<T>(workspaceId: string, operation: (tx: Tx) => Promise<T>) {
      return runtime.transaction(workspaceId, async tx => {
        await lockAuthorization(tx, 'write');
        return operation(tx);
      });
    }`,
    true,
  ],
  'hard-coded-resolver-around-callback': [
    `const transaction = <T>(workspaceId: string, user: string, action: (tx: Tx, actor: Actor) => Promise<T>) =>
      runtime.transaction(workspaceId, async tx => action(tx, await lockAndResolveHuman(tx, user, 'write')));`,
    true,
  ],
  'hard-coded-passed-through': [
    `function transaction<T>(workspaceId: string, operation: (tx: Tx) => Promise<T>) {
      return runtime.transaction(workspaceId, async tx => {
        await lockKnowledgeAuthorization(tx, 'write');
        return store.run(tx, operation);
      });
    }`,
    true,
  ],
  'defaulted-mode': [
    `function transaction<T>(workspaceId: string, operation: (tx: Tx) => Promise<T>, mode: 'read' | 'write' = 'write') {
      return runtime.transaction(workspaceId, async tx => {
        await lockAuthorization(tx, mode);
        return operation(tx);
      });
    }`,
    true,
  ],
  'defaulted-flag': [
    `function memberTransaction<T>(workspaceId: string, operation: (tx: Tx) => Promise<T>, write = true) {
      return store.transaction(workspaceId, write, operation);
    }`,
    true,
  ],
  'required-mode': [
    `function transaction<T>(workspaceId: string, mode: 'read' | 'write', operation: (tx: Tx) => Promise<T>) {
      return runtime.transaction(workspaceId, async tx => {
        await lockAuthorization(tx, mode);
        return operation(tx);
      });
    }
    export const rename = (id: string) => transaction(id, 'write', async tx => tx.client.query('SELECT 1'));`,
    false,
  ],
  'policy-change-without-callback': [
    `export async function addMember(tx: Tx, userId: string) {
      await lockAuthorization(tx, 'write');
      await tx.client.query('INSERT INTO tf_memberships (user_id) VALUES ($1)', [userId]);
    }`,
    false,
  ],
  'write-default-unrelated-to-callbacks': [
    `export function storageConfig(mode: 'write' | 'read' = 'write') {
      return { mode };
    }`,
    false,
  ],
  'callback-helper-with-read-lock': [
    `function read<T>(workspaceId: string, operation: (tx: Tx) => Promise<T>) {
      return runtime.transaction(workspaceId, async tx => {
        await lockAuthorization(tx, 'read');
        return operation(tx);
      });
    }`,
    false,
  ],
};

test('helpers that run callbacks must take the authorization lock mode from their callers', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tulip-lock-lint-'));
  try {
    const config = JSON.parse(await readFile(path.join(root, '.oxlintrc.json'), 'utf8'));
    config.jsPlugins = [
      fileURLToPath(import.meta.resolve('@shadcn/lint')),
      path.join(root, 'tooling/design-system-lint.mjs'),
    ];
    await writeFile(path.join(directory, '.oxlintrc.json'), JSON.stringify(config));
    const source = path.join(directory, 'packages/example/src');
    await mkdir(source, { recursive: true });
    for (const [name, [code]] of Object.entries(cases)) await writeFile(path.join(source, `${name}.ts`), code);

    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/oxlint/bin/oxlint'),
        '--config',
        path.join(directory, '.oxlintrc.json'),
        '-A',
        'all',
        '-D',
        'tulipfarm/authorization-lock-mode',
        '-f',
        'unix',
        source,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    const output = result.stdout + result.stderr;
    for (const [name, [, rejected]] of Object.entries(cases)) {
      const reported = output.split('\n').filter(line => line.includes(`/${name}.ts:`));
      assert.equal(reported.length > 0, rejected, `${name}:\n${output}`);
      for (const line of reported) assert.match(line, /only membership, team and grant changes pass 'write'/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
