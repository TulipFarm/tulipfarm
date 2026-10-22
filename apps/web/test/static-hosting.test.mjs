import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';

// A missing chunk must 404 rather than fall back to index.html, while application routes keep
// the single-page fallback. Static hosts that fall back per directory use assets/404.html;
// the self-host Caddyfile serves /assets/* without a fallback.
test('the artifact 404s missing assets and keeps the route fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-static-hosting-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(root, 'main.js'), 'document.title = "built";');
  await build({
    root,
    configFile: false,
    envDir: false,
    logLevel: 'silent',
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  });

  await access(join(root, 'dist/assets/404.html'));
  await assert.rejects(access(join(root, 'dist/404.html')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'dist/_headers')), { code: 'ENOENT' });
  const caddy = await readFile(new URL('../../../self-host/Caddyfile', import.meta.url), 'utf8');
  const assets = caddy.match(/handle @assets \{([^}]*)\}/)?.[1] ?? '';
  assert.match(assets, /Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(assets, /file_server/);
  assert.doesNotMatch(assets, /try_files/);
});
