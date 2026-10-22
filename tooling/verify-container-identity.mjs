import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const version = '2026.10.2.99';
const commit = 'c'.repeat(40);
function run(args, timeout = 900000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  return result.stdout;
}
run(['info', '--format', '{{.ServerVersion}}'], 15000);
for (const [app, dockerfile, target, localTarget] of [
  ['api', 'apps/api/Dockerfile', undefined, 'local'],
  ['worker', 'apps/worker/Dockerfile', 'worker', 'local-worker'],
  ['storage-maintenance', 'apps/worker/Dockerfile', 'storage-maintenance', 'local-storage-maintenance'],
  ['snippet-broker', 'apps/snippet-broker/Dockerfile', undefined, 'local'],
]) {
  const image = `tulipfarm-version-proof-${app}:local`;
  run([
    'build',
    '-f',
    dockerfile,
    '--build-arg',
    `RELEASE_VERSION=${version}`,
    '--build-arg',
    `RELEASE_COMMIT=${commit}`,
    ...(target ? ['--target', target] : []),
    '-t',
    image,
    '.',
  ]);
  const raw = run([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    `import { readBuildInfo } from '@tulipfarm/build-info/node'; process.stdout.write(JSON.stringify(readBuildInfo('${app}',new URL('file:///app/version.json'))))`,
  ]);
  assert.deepEqual(JSON.parse(raw), { app, version, commit });
  process.stdout.write(`${app} container identity verified.\n`);
  const missing = spawnSync('docker', ['build', '-f', dockerfile, ...(target ? ['--target', target] : []), '.'], {
    encoding: 'utf8',
    timeout: 900000,
    killSignal: 'SIGKILL',
  });
  assert.equal(missing.error, undefined);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /ZodError/);
  run(['build', '-f', dockerfile, '--target', localTarget, '-t', image, '.']);
  const local = run([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    `import { readBuildInfo } from '@tulipfarm/build-info/node'; process.stdout.write(JSON.stringify(readBuildInfo('${app}',new URL('file:///app/version.json'))))`,
  ]);
  assert.deepEqual(JSON.parse(local), { app, version: 'development', commit: 'development' });
  process.stdout.write(`${app} local target and strict production default verified.\n`);
}
