import assert from 'node:assert/strict';
import { glob, readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Sources and tests import commonCompatibility so a stream bump cannot leave a reader rejected with incompatible_version.
// Tests that stub the runtime or build a historical stream may pin an older maximum.
const historicalPins = {
  'apps/api/test/security.test.mjs': [26],
  'apps/database/test/integration/workspace-operations-tombstone.test.mjs': [6],
  'apps/worker/test/workspace.integration.mjs': [1, 2],
  'packages/agents/test/store.integration.mjs': [26],
  'packages/workspace-storage/test/integration/runtime-deadline.test.mjs': [1],
  'packages/workspace-storage/test/integration/runtime.test.mjs': [1, 3],
};

const definition = 'packages/workspace-storage/src/runtime.ts';

test('sources and tests use the current common compatibility maximum unless they build a historical stream', async () => {
  const root = new URL('../', import.meta.url);
  const runtime = await readFile(new URL(definition, root), 'utf8');
  const current = Number(
    runtime.match(/commonCompatibility = Object\.freeze\(\{ minimum: \d+, maximum: (\d+) \}\)/)?.[1],
  );
  assert.ok(current > 0, `commonCompatibility.maximum is readable from ${definition}`);
  const stale = [];
  for await (const path of glob(['{apps,packages}/*/{src,test}/**/*.{mjs,ts,tsx}'], {
    cwd: root,
    exclude: name => name === 'node_modules',
  })) {
    if (path === definition) continue;
    const source = await readFile(new URL(path, root), 'utf8');
    for (const match of source.matchAll(/minimum:\s*[\w.]+,\s*maximum:\s*(\d+)/g)) {
      const maximum = Number(match[1]);
      if (maximum < current && !historicalPins[path]?.includes(maximum))
        stale.push(`${path}:${source.slice(0, match.index).split('\n').length} maximum ${maximum}`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `Stale compatibility pins below ${current}. Import the module's exported range, or list a historical-stream pin in tooling/check-compatibility-pins.test.mjs.`,
  );
});
