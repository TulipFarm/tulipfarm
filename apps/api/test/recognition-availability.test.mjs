import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModelCatalog, shippedModelCatalogPath } from '@tulipfarm/config';
import { readFileSync } from 'node:fs';
import { recognitionAvailability } from '@tulipfarm/agents/image-settings';

const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));
const catalog = roles =>
  loadModelCatalog({
    ANTHROPIC_API_KEY: 'k',
    MODEL_CATALOG: JSON.stringify({
      ...shipped,
      models: shipped.models
        .filter(entry => entry.id === 'claude-sonnet')
        .map(entry => ({ ...entry, default: true, roles })),
    }),
  });
const untouched = {
  transaction: () => assert.fail('without the images flag, availability is the catalog role alone'),
};

test('Knowledge re-reads are queued only when a served model reads images', async t => {
  const previous = process.env.FEATURE_FLAG_IMAGES;
  process.env.FEATURE_FLAG_IMAGES = 'false';
  t.after(() => {
    if (previous === undefined) delete process.env.FEATURE_FLAG_IMAGES;
    else process.env.FEATURE_FLAG_IMAGES = previous;
  });
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  assert.equal(catalog([]).role('document-vision'), null);
  assert.equal(await recognitionAvailability(untouched, catalog([]))(workspaceId), false);
  assert.equal(await recognitionAvailability(untouched, catalog(['document-vision']))(workspaceId), true);
});
