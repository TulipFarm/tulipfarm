import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { readBuildInfo } from '../src/node.ts';

test('packaged identity is validated independently of telemetry or runtime release overrides', t => {
  const dir = mkdtempSync(join(tmpdir(), 'build-info-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = pathToFileURL(join(dir, 'version.json'));
  assert.deepEqual(readBuildInfo('api', file, false), { app: 'api', version: 'development', commit: 'development' });
  assert.throws(() => readBuildInfo('api', file, true), /Missing build identity/);
  const expected = { app: 'api', version: '2026.10.2.1', commit: 'a'.repeat(40) };
  writeFileSync(file, JSON.stringify(expected));
  assert.deepEqual(readBuildInfo('api', file, true), expected);
  assert.throws(() => readBuildInfo('worker', file, true), /does not belong/);
  for (const version of ['2026.2.30.1', '2026.13.1.1', '1.0.0', 'development']) {
    writeFileSync(file, JSON.stringify({ ...expected, version }));
    assert.throws(() => readBuildInfo('api', file, true));
  }
});

test('container identity generator has an explicit local path and a strict release default', t => {
  const dir = mkdtempSync(join(tmpdir(), 'generated-build-info-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const output = join(dir, 'version.json');
  const generator = fileURLToPath(new URL('../generate.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.RELEASE_VERSION;
  delete env.RELEASE_COMMIT;
  for (const app of ['api', 'worker', 'storage-maintenance', 'snippet-broker']) {
    const run = (args = [], releaseEnv = {}) =>
      spawnSync(process.execPath, [generator, app, output, ...args], {
        env: { ...env, ...releaseEnv },
        encoding: 'utf8',
      });
    assert.notEqual(run().status, 0);
    assert.equal(run(['--local']).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { app, version: 'development', commit: 'development' });
    assert.deepEqual(readBuildInfo(app, pathToFileURL(output), false), {
      app,
      version: 'development',
      commit: 'development',
    });
    assert.throws(() => readBuildInfo(app, pathToFileURL(output), true));
    assert.notEqual(run([], { RELEASE_VERSION: 'development', RELEASE_COMMIT: 'development' }).status, 0);
    assert.notEqual(run(['--production']).status, 0);
    assert.equal(run([], { RELEASE_VERSION: '2026.10.2.1', RELEASE_COMMIT: 'a'.repeat(40) }).status, 0);
    assert.deepEqual(readBuildInfo(app, pathToFileURL(output), true), {
      app,
      version: '2026.10.2.1',
      commit: 'a'.repeat(40),
    });
  }
});
