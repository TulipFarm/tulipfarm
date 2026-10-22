import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build, preview } from 'vite';

test('local builds and static serving do not require release metadata; release builds fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-build-identity-'));
  const priorEnv = { ...process.env };
  t.after(async () => {
    process.env = priorEnv;
    await rm(root, { recursive: true, force: true });
  });
  delete process.env.TULIPFARM_RELEASE_BUILD;
  await copyFile(new URL('../vite.config.ts', import.meta.url), join(root, 'vite.config.ts'));
  await mkdir(join(root, 'src/lib'), { recursive: true });
  await copyFile(new URL('../src/lib/api-origin.ts', import.meta.url), join(root, 'src/lib/api-origin.ts'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(root, 'main.js'), 'globalThis.buildIdentity = __BUILD_INFO__;');
  const config = { root, envDir: false, logLevel: 'silent', build: { modulePreload: false } };
  const metadata = join(root, 'version.json');
  const development = { app: 'web', version: 'development', commit: 'development' };
  const release = { app: 'web', version: '2026.10.2.1', commit: 'a'.repeat(40) };

  async function servedIdentity(expected) {
    const server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } });
    try {
      const origin = server.resolvedUrls.local[0];
      const response = await fetch(new URL('version.json', origin));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
      const html = await fetch(origin).then(response => response.text());
      const asset = html.match(/src="([^"]+\.js)"/)[1];
      const js = await fetch(new URL(asset, origin)).then(response => response.text());
      const context = {};
      runInNewContext(js, context, { timeout: 1000 });
      assert.deepEqual(structuredClone(context.buildIdentity), expected);
    } finally {
      await new Promise((resolve, reject) => server.httpServer.close(error => (error ? reject(error) : resolve())));
    }
  }

  await build(config);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/version.json'), 'utf8')), development);
  await servedIdentity(development);
  await writeFile(metadata, JSON.stringify(release));
  await build(config);
  await servedIdentity(development);
  await rm(metadata);

  process.env.TULIPFARM_RELEASE_BUILD = '1';
  await assert.rejects(build(config), /Missing build identity for web/);
  for (const invalid of [development, { ...release, app: 'api' }, { ...release, commit: 'short' }]) {
    await writeFile(metadata, JSON.stringify(invalid));
    await assert.rejects(build(config));
  }
  await writeFile(metadata, JSON.stringify(release));
  await build(config);
  await rm(metadata);
  await servedIdentity(release);
});

test('the HTML preconnects to the credentialed API origin the client uses', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-preconnect-'));
  const priorEnv = { ...process.env };
  t.after(async () => {
    process.env = priorEnv;
    await rm(root, { recursive: true, force: true });
  });
  delete process.env.TULIPFARM_RELEASE_BUILD;
  await copyFile(new URL('../vite.config.ts', import.meta.url), join(root, 'vite.config.ts'));
  await mkdir(join(root, 'src/lib'), { recursive: true });
  await copyFile(new URL('../src/lib/api-origin.ts', import.meta.url), join(root, 'src/lib/api-origin.ts'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'index.html'), '<head></head><script type="module" src="/main.js"></script>');
  await writeFile(join(root, 'main.js'), '');
  const html = async env => {
    delete process.env.VITE_API_URL;
    Object.assign(process.env, env);
    await build({ root, logLevel: 'silent' });
    return readFile(join(root, 'dist/index.html'), 'utf8');
  };
  // Unset calls the API on the page's own origin, which needs no preconnect.
  assert.doesNotMatch(await html({}), /rel="preconnect"/);
  assert.match(
    await html({ VITE_API_URL: 'https://api.staging.example/v1-ignored' }),
    /<link rel="preconnect" href="https:\/\/api\.staging\.example" crossorigin="use-credentials">/,
  );
});
