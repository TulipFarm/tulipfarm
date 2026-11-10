import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

test('question and reply Markdown parsers keep compatible major versions', () => {
  const require = createRequire(import.meta.url);
  const web = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const sprout = JSON.parse(readFileSync(require.resolve('@tulipfarm/sprout/package.json'), 'utf8'));
  for (const name of ['react-markdown', 'remark-gfm']) {
    assert.equal(
      web.dependencies[name].match(/\d+/)?.[0],
      sprout.dependencies[name].match(/\d+/)?.[0],
      `${name} must match the reply renderer's major version`,
    );
  }
});
