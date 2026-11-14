import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { appSchema } from '../src/schema.ts';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const files = readdirSync(new URL('../apps/', import.meta.url)).filter(file => file.endsWith('.json'));
const apps = files.map(file => [file, read(`../apps/${file}`)]);
const lobehub = new Set(read('../icon-keys/lobehub.json'));
const simpleIcons = new Set(read('../icon-keys/simple-icons.json'));

test('every app matches the schema and is named after its id', () => {
  for (const [file, app] of apps) {
    const result = appSchema.safeParse(app);
    assert.ok(
      result.success,
      `${file}: ${result.error?.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
    assert.equal(file, `${app.id}.json`);
  }
});

test('icon keys exist in @lobehub/icons and simple-icons', () => {
  for (const [file, { icons }] of apps) {
    if (icons.lobehub) assert.ok(lobehub.has(icons.lobehub), `${file}: unknown lobehub key ${icons.lobehub}`);
    if (icons.simpleIcons)
      assert.ok(simpleIcons.has(icons.simpleIcons), `${file}: unknown simple-icons slug ${icons.simpleIcons}`);
  }
});

test('names, hosted servers and registry names are unique', () => {
  for (const pick of [app => app.name.toLowerCase(), app => app.remote?.url, app => app.registryName]) {
    const seen = new Map();
    for (const [file, app] of apps) {
      const value = pick(app);
      if (!value) continue;
      assert.ok(!seen.has(value), `${file} and ${seen.get(value)} share ${value}`);
      seen.set(value, file);
    }
  }
});
