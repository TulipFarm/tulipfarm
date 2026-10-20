import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { developmentBuild, productionBuildSchema } from '../packages/build-info/src/index.ts';

const commit = 'c'.repeat(40);
const version = '2026.10.2.99';
const env = { ...process.env, RELEASE_VERSION: version, RELEASE_COMMIT: commit };
for (const app of ['web', 'database'])
  assert.equal(existsSync(`apps/${app}/version.json`), false, 'Refusing to overwrite existing metadata');
function run(command, args, runEnv = env) {
  const result = spawnSync(command, args, { env: runEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
try {
  run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@tulipfarm/web', '--force'], process.env);
  assert.deepEqual(JSON.parse(readFileSync('apps/web/dist/version.json', 'utf8')), developmentBuild('web'));
  for (const app of ['web', 'database'])
    run('node', ['packages/build-info/generate.mjs', app, `apps/${app}/version.json`]);
  run('pnpm', ['--filter', '@tulipfarm/web', 'build:release']);
  const web = productionBuildSchema.parse(JSON.parse(readFileSync('apps/web/dist/version.json', 'utf8')));
  assert.deepEqual(web, { app: 'web', version, commit });
  const bundles = readdirSync('apps/web/dist/assets')
    .filter(file => file.endsWith('.js'))
    .map(file => readFileSync(`apps/web/dist/assets/${file}`, 'utf8'))
    .join('\n');
  assert.ok(bundles.includes(version));
  assert.ok(bundles.includes(commit));
  assert.deepEqual(JSON.parse(run('node', ['apps/database/src/cli.ts', '--version'])), {
    app: 'database',
    version,
    commit,
  });
  process.stdout.write(
    'Development web JSON, production web JSON, bundled constant, and database CLI identity verified.\n',
  );
} finally {
  for (const app of ['web', 'database']) rmSync(`apps/${app}/version.json`, { force: true });
}
