import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { appCss, appTokens, preset, sproutDefines } from './sprout-theme.ts';

// Third-party brand marks keep their owners' colors.
const ownColors = new Set([
  '--brand-google-blue',
  '--brand-google-green',
  '--brand-google-red',
  '--brand-google-yellow',
]);

test('the app loads Sprout’s tulipfarm theme on the document root', () => {
  assert.match(
    appCss,
    /@import '@tulipfarm\/sprout\/styles\.css';\n@import '@tulipfarm\/sprout\/themes\/tulipfarm\.css';/,
  );
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<html [^>]*data-sprout-theme="tulipfarm"/);
});

test('every app color token reads a Sprout token instead of keeping its own value', () => {
  for (const [name, value] of Object.entries(appTokens)) {
    if (name === 'color-scheme' || ownColors.has(name)) continue;
    const sprout = value.match(/^var\((--sprout-[\w-]+)\)$/)?.[1];
    assert.ok(sprout, `${name}: ${value} should be var(--sprout-…)`);
    assert.ok(sproutDefines(sprout), `${name} reads ${sprout}, which Sprout does not define`);
  }
});

test('no stylesheet overrides a token Sprout’s tulipfarm theme sets', () => {
  const themed = new Set([...preset.matchAll(/(--sprout-[\w-]+):/g)].map(([, name]) => name));
  const dir = new URL('../src/', import.meta.url);
  const sheets = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.css'));
  for (const file of sheets) {
    const css = readFileSync(new URL(file, dir), 'utf8');
    for (const [, name] of css.matchAll(/(--sprout-[\w-]+)\s*:/g))
      assert.ok(!themed.has(name!), `${file} sets ${name}; change it in Sprout’s tulipfarm theme instead`);
  }
});
