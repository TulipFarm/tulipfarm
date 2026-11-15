import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appManifest, untar } from '../src/app-files.ts';
import { selectAppPublisher } from '@tulipfarm/apps/sites';

async function tarOf(build) {
  const root = await mkdtemp(join(tmpdir(), 'app-files-'));
  try {
    await build(root);
    return execFileSync('tar', ['-cf', '-', '-C', root, '.'], {
      env: { PATH: process.env.PATH, COPYFILE_DISABLE: '1' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('build output becomes a manifest of its regular files sorted by path', async () => {
  const archive = await tarOf(async root => {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<h1>Hi</h1>');
    await writeFile(join(root, 'assets', 'site.css'), 'h1{}');
  });
  const unpacked = untar(archive);
  assert.equal(unpacked.ok, true);
  const manifest = appManifest(unpacked.files);
  assert.equal(manifest.ok, true);
  assert.deepEqual(manifest.files, [
    {
      path: 'assets/site.css',
      sha256: 'ae17b2b38ebdd0b621842031a87768161a7cd97da97f0fd6616a7190f6b02637',
      bytes: 4,
      contentType: 'text/css; charset=utf-8',
    },
    {
      path: 'index.html',
      sha256: '0f8ca7467b0a55599c03aad0aed980d35f15acafcfa344cfdcd152af3044f7e8',
      bytes: 11,
      contentType: 'text/html; charset=utf-8',
    },
  ]);
  assert.equal(manifest.bytes, 15);
});

test('build output with a link or a path outside its folder fails the build', async () => {
  const linked = await tarOf(async root => {
    await writeFile(join(root, 'index.html'), 'ok');
    await symlink('/etc/passwd', join(root, 'secrets'));
  });
  const unpacked = untar(linked);
  assert.equal(unpacked.ok, false);
  assert.equal(unpacked.failure.code, 'build-failed');

  const escaped = appManifest([{ path: '../outside.html', content: Buffer.from('x') }]);
  assert.equal(escaped.ok, false);
  assert.equal(escaped.failure.message, 'The build made a file outside its folder: ../outside.html');
  assert.equal(appManifest([{ path: '/etc/passwd', content: Buffer.from('x') }]).ok, false);
});

test('the built-in publisher needs a sites domain apart from the web app', () => {
  const storage = {};
  const database = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.equal(selectAppPublisher({}, storage, database), undefined);
  assert.throws(
    () =>
      selectAppPublisher(
        { TULIPFARM_APP_SITES_DOMAIN: 'sites.example.com', WEB_ORIGIN: 'https://app.example.com' },
        storage,
        database,
      ),
    /different domain/,
  );
  const publisher = selectAppPublisher(
    { TULIPFARM_APP_SITES_DOMAIN: 'example-sites.net', WEB_ORIGIN: 'https://app.example.com' },
    storage,
    database,
  );
  assert.equal(typeof publisher?.serve, 'function');
});
