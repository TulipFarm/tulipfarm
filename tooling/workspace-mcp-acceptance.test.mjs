import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const runner = resolve('tooling/workspace-mcp-acceptance.mjs');
async function run(directory) {
  const child = spawn(process.execPath, [runner], {
    env: { PATH: directory, MCP_EVIDENCE_DIRECTORY: directory },
    stdio: 'ignore',
  });
  return new Promise(resolve => child.once('close', resolve));
}
test('acceptance runner replaces stale evidence and records missing executable failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-runner-missing-'));
  await writeFile(join(directory, 'checks.json'), '[{"verdict":"PASS"}]');
  assert.equal(await run(directory), 1);
  const records = JSON.parse(await readFile(join(directory, 'checks.json'), 'utf8'));
  assert.equal(records.length, 1);
  assert.equal(records[0].verdict, 'FAIL');
  assert.match(records[0].startError, /ENOENT/);
});
test('acceptance runner records final stdout after process closure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-runner-output-'));
  const executable = join(directory, 'pnpm');
  await writeFile(executable, '#!/bin/sh\nprintf "final verification output\\n"\nexit 7\n');
  await chmod(executable, 0o755);
  assert.equal(await run(directory), 1);
  const records = JSON.parse(await readFile(join(directory, 'checks.json'), 'utf8'));
  assert.equal(records[0].code, 7);
  assert.equal(records[0].verdict, 'FAIL');
  assert.equal(await readFile(join(directory, 'aggregate.log'), 'utf8'), 'final verification output\n');
});
