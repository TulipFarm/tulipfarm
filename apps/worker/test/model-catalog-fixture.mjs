import { readFileSync } from 'node:fs';
import { shippedModelCatalogPath } from '@tulipfarm/config';

const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));

/** An inline catalog (MODEL_CATALOG) of the shipped models `ids`, with `defaultId` as the default. */
export function modelCatalogOf(ids, defaultId = ids.includes('claude-sonnet') ? 'claude-sonnet' : ids[0]) {
  return JSON.stringify({
    ...shipped,
    models: ids.map(id => ({ ...shipped.models.find(model => model.id === id), default: id === defaultId })),
  });
}

/** Serves only the shipped models `ids` until the returned function restores the previous catalog. */
export function useModelCatalog(ids = ['claude-haiku', 'claude-sonnet'], defaultId) {
  const previous = { MODEL_CATALOG: process.env.MODEL_CATALOG, MODEL_CATALOG_FILE: process.env.MODEL_CATALOG_FILE };
  delete process.env.MODEL_CATALOG_FILE;
  process.env.MODEL_CATALOG = modelCatalogOf(ids, defaultId);
  return () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
}
