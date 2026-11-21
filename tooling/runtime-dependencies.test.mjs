import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { glob, readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Production images install only `dependencies`, so a value import of a dev dependency
// fails at startup with ERR_MODULE_NOT_FOUND. Vite bundles its apps, so they are exempt.
const imports =
  /^\s*(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

const typeOnly = clause => {
  const names = clause.trim().match(/^\{([^}]*)\}$/)?.[1];
  return (
    names !== undefined &&
    names
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
      .every(name => name.startsWith('type '))
  );
};

const packageName = specifier =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

test('runtime sources import only packages listed in dependencies', async () => {
  const root = new URL('../', import.meta.url);
  const misplaced = [];
  for await (const manifest of glob('{apps,packages}/*/package.json', { cwd: root })) {
    const dir = manifest.slice(0, -'/package.json'.length);
    if (existsSync(new URL(`${dir}/vite.config.ts`, root))) continue;
    const pkg = JSON.parse(await readFile(new URL(manifest, root), 'utf8'));
    const runtime = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
    const devOnly = new Set(Object.keys(pkg.devDependencies ?? {}).filter(name => !runtime.has(name)));
    if (devOnly.size === 0) continue;
    for await (const file of glob(`${dir}/src/**/*.{ts,tsx}`, {
      cwd: root,
      exclude: name => /node_modules|__tests__|\.test\.|\.spec\.|\.d\.ts$/.test(name),
    })) {
      const source = await readFile(new URL(file, root), 'utf8');
      for (const [, clause, from, dynamic] of source.matchAll(imports)) {
        if (clause !== undefined && typeOnly(clause)) continue;
        const name = packageName(from ?? dynamic);
        if (devOnly.has(name)) misplaced.push(`${file} imports ${name}, a devDependency of ${pkg.name}`);
      }
    }
  }
  assert.deepEqual(misplaced, [], 'move these packages from devDependencies to dependencies');
});
