import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildModelCatalog, modelCatalogRevision, readModelCatalogSource } from '../src/model-catalog-source.ts';
import {
  initialModelMapping,
  modelFamilies,
  modelFamilyEntrySchema,
  modelPricingEntrySchema,
} from '../src/model-continuity.ts';
import families from '../src/model-families.json' with { type: 'json' };
import pricing from '../src/model-pricing.json' with { type: 'json' };

const fixture = name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const read = name => JSON.parse(readFileSync(fixture(name), 'utf8'));
const shipped = {
  families: families.map(family => modelFamilyEntrySchema.parse(family)),
  models: pricing.models.map(model => modelPricingEntrySchema.parse(model)),
};
const schemas = { family: modelFamilyEntrySchema, model: modelPricingEntrySchema };
const build = (value, mode = 'extend') =>
  buildModelCatalog({ shipped, schemas, source: { label: 'MODEL_CATALOG', mode, value } });
const acme = read('model-catalog-replace.json');

function load(env, script) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const config = await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});
    ${script}`,
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    output: result.status === 0 ? JSON.parse(result.stdout) : null,
  };
}

test('without catalog settings the shipped catalog and its published revisions are unchanged', () => {
  assert.equal(readModelCatalogSource({}), null);
  assert.equal(readModelCatalogSource({ MODEL_CATALOG_FILE: ' ', MODEL_CATALOG: '' }), null);
  assert.equal(build({ families: [], models: [] }).families.length, shipped.families.length);
  assert.deepEqual(
    modelFamilies.map(family => family.id),
    families.map(family => family.id),
  );
  assert.equal(initialModelMapping.revision, 'families-2026-10-19.1');
  assert.equal(initialModelMapping.pricingRevision, 'prices-2026-10-19.1');
});

test('revisions are content hashes, except that shipped content keeps its published revision', () => {
  assert.equal(
    modelCatalogRevision('families', 'published', shipped.families, structuredClone(shipped.families).reverse()),
    'published',
  );
  const changed = modelCatalogRevision('families', 'published', shipped.families, build(acme).families);
  assert.match(changed, /^families-[0-9a-f]{32}$/);
  assert.equal(modelCatalogRevision('families', 'published', shipped.families, build(acme).families), changed);
  assert.notEqual(
    modelCatalogRevision('families', 'published', shipped.families, build(acme, 'replace').families),
    changed,
  );
  const withCapabilities = shipped.families.map(family => ({ ...family, capabilities: { tools: false } }));
  assert.equal(
    modelCatalogRevision('families', 'published', shipped.families, withCapabilities),
    'published',
    'capabilities are not revisioned',
  );
  const redeclared = { families: [families[0]], models: [pricing.models[0]] };
  assert.equal(modelCatalogRevision('prices', 'published', shipped.models, build(redeclared).models), 'published');
});

test('extend adds new families and replaces shipped entries with the same id', () => {
  const catalog = build(read('model-catalog-extend.json'));
  assert.deepEqual(
    catalog.families.map(family => family.id),
    [...families.map(family => family.id), 'acme-chat'],
  );
  assert.equal(catalog.families.find(family => family.id === 'claude-haiku').name, 'Claude Haiku (operator)');
  assert.equal(catalog.models.find(model => model.id === 'acme-chat-1').providerModelId, 'Acme-Chat-1');
  assert.equal(catalog.models.length, pricing.models.length + 1);
  const repriced = build({
    models: [
      {
        ...pricing.models[0],
        rates: [{ ...pricing.models[0].rates[0], usdPerMillionTokens: { input: 2, output: 4 } }],
      },
    ],
  });
  assert.deepEqual(repriced.models[0].rates[0].usdPerMillionTokens, { input: 2, output: 4 });
  const narrowed = build({ families: [{ ...families.find(family => family.id === 'grok'), modelIds: ['grok-4-6'] }] });
  assert.equal(
    narrowed.models.some(model => model.id === 'grok-4'),
    false,
    'shipped models no family references are dropped',
  );
});

test('replace keeps only the operator families and models', () => {
  const catalog = build(acme, 'replace');
  assert.deepEqual(
    catalog.families.map(family => family.id),
    ['acme-chat'],
  );
  assert.deepEqual(
    catalog.models.map(model => model.id),
    ['acme-chat-1'],
  );
  assert.throws(() => build({ families: [], models: [] }, 'replace'), /no model families/);
});

test('invalid entries are rejected with the entry named', () => {
  const [family] = acme.families,
    [model] = acme.models;
  for (const [value, message] of [
    [[], /expected \{ "families"/],
    [{ families: [], models: [], extra: true }, /Unrecognized key/],
    [read('model-catalog-invalid.json'), /models\[0\] "acme-chat-1": metadata\.max_output_tokens/],
    [{ families: [{ ...family, id: 'Acme.Chat' }], models: [model] }, /families\[0\] "Acme\.Chat": id/],
    [{ families: [{ ...family, extra: 1 }], models: [model] }, /families\[0\] "acme-chat": Unrecognized key/],
    [{ families: [family], models: [{ ...model, provider: 'acme' }] }, /models\[0\] "acme-chat-1": provider/],
    [
      { families: [family], models: [{ ...model, rates: [{ ...model.rates[0], promptTokensAbove: 10 }] }] },
      /models\[0\] "acme-chat-1": rates: Missing base price/,
    ],
    [
      {
        families: [family],
        models: [{ ...model, rates: [{ ...model.rates[0], usdPerMillionTokens: { input: 0.0000001, output: 1 } }] }],
      },
      /rates\.0\.usdPerMillionTokens\.input: Unsupported price precision/,
    ],
    [{ families: [family, family], models: [model] }, /families\[1\] "acme-chat": duplicate id/],
    [{ families: [family], models: [] }, /family "acme-chat": model "acme-chat-1" is not in the catalog models/],
    [
      { families: [{ ...family, currentModelId: 'acme-chat-2' }], models: [model] },
      /family "acme-chat": currentModelId "acme-chat-2"/,
    ],
    [
      { families: [family], models: [model, { ...model, id: 'acme-orphan' }] },
      /model "acme-orphan" does not belong to any family/,
    ],
    [
      { families: [family, { ...family, id: 'acme-copy' }], models: [model] },
      /family "acme-copy": model "acme-chat-1" already belongs to family "acme-chat"/,
    ],
    [
      { families: [{ ...family, modelIds: ['acme-chat-1', 'claude-opus-5-5'] }], models: [model] },
      /family "acme-chat": model "claude-opus-5-5" already belongs to family "claude-opus"/,
    ],
  ])
    assert.throws(
      () => build(value),
      error => error.name === 'ModelCatalogError' && message.test(error.message),
      JSON.stringify(value),
    );
});

test('catalog settings are read from a file or inline JSON, never both', () => {
  const file = fixture('model-catalog-extend.json');
  assert.deepEqual(readModelCatalogSource({ MODEL_CATALOG_FILE: file }), {
    label: `MODEL_CATALOG_FILE=${file}`,
    mode: 'extend',
    value: read('model-catalog-extend.json'),
  });
  assert.equal(
    readModelCatalogSource({ MODEL_CATALOG: JSON.stringify(acme), MODEL_CATALOG_MODE: 'replace' }).mode,
    'replace',
  );
  for (const [env, message] of [
    [{ MODEL_CATALOG_FILE: file, MODEL_CATALOG: '{}' }, /set only one of them/],
    [{ MODEL_CATALOG: '{}', MODEL_CATALOG_MODE: 'merge' }, /MODEL_CATALOG_MODE.*extend, replace/],
    [{ MODEL_CATALOG_MODE: 'replace' }, /set MODEL_CATALOG_FILE or MODEL_CATALOG/],
    [{ MODEL_CATALOG: '{' }, /MODEL_CATALOG\): not valid JSON/],
    [{ MODEL_CATALOG_FILE: fixture('missing.json') }, /cannot read the file \(ENOENT\)/],
  ])
    assert.throws(() => readModelCatalogSource(env), message);
});

test('an extended catalog resolves, bundles and prices its own families under derived revisions', () => {
  const { status, stderr, output } = load(
    { MODEL_CATALOG_FILE: fixture('model-catalog-extend.json') },
    `
    const route = { id: 'acme', modelId: 'acme-chat-1', provider: 'azure', deployment: 'Acme-Chat-1', location: 'test',
      adapterVersion: 1, qualification: 'fixture', lifecycle: 'current', maxInputTokens: 1000, maxOutputTokens: 1000, boundedDecision: true };
    const resolution = config.resolveModelFamily({ familyId: 'acme-chat', mapping: config.initialModelMapping, routes: [route], allowedProviders: ['azure'], allowedLocations: ['test'] });
    const bundle = config.modelBundleSchema.parse({ format: 1, id: 'acme', mapping: { ...config.initialModelMapping, revision: 'acme',
      families: config.initialModelMapping.families.filter(family => family.id === 'acme-chat') }, models: config.initialBundleModels, routes: [route] });
    const cost = config.calculateModelCost({ resolution, date: '2026-10-19', usage: { kind: 'known', tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } });
    console.log(JSON.stringify({ families: config.modelFamilies.map(family => family.id), selectable: config.selectableModelFamilies.some(family => family.id === 'acme-chat'),
      haiku: config.modelFamilies.find(family => family.id === 'claude-haiku').name, revision: config.initialModelMapping.revision,
      pricingRevision: config.initialModelMapping.pricingRevision, resolved: resolution.pricingRevision, bundle: bundle.models.length,
      pricing: config.modelPricing.models.some(model => model.id === 'acme-chat-1'), cost: cost.providerPicoUsd,
      capabilities: config.modelCapabilities('azure', 'Acme-Chat-1'), routeCapabilities: config.modelCapabilities('azure', 'Acme-Chat-1', { toolChoice: 'forced' }).toolChoice,
      haikuCapabilities: config.modelCapabilities('anthropic', 'claude-haiku-4-5').responseModelAliases }));`,
  );
  assert.equal(status, 0, stderr);
  assert.equal(output.families.at(-1), 'acme-chat');
  assert.equal(output.selectable, true);
  assert.equal(output.haiku, 'Claude Haiku (operator)');
  assert.match(output.revision, /^families-[0-9a-f]{32}$/);
  assert.match(output.pricingRevision, /^prices-[0-9a-f]{32}$/);
  assert.equal(output.resolved, output.pricingRevision);
  assert.equal(output.bundle, pricing.models.length + 1);
  assert.equal(output.pricing, true);
  assert.equal(output.cost, '2000000000');
  assert.deepEqual(output.capabilities, {
    api: 'responses',
    toolChoice: 'auto',
    reasoningOffForTools: false,
    reasoningTokensInOutput: false,
    streaming: true,
    responseModelAliases: ['Acme-Chat-1-2026-10-01'],
  });
  assert.equal(output.routeCapabilities, 'forced', 'route overrides still apply after the file family');
  assert.deepEqual(output.haikuCapabilities, [], 'an override replaces the shipped family whole');
});

test('capabilities do not change revisions, and an unsupported API fails loading with the family named', () => {
  const [family] = acme.families;
  const withCapabilities = { ...acme, families: [{ ...family, capabilities: { streaming: false } }] };
  const revisions =
    'console.log(JSON.stringify([config.initialModelMapping.revision, config.initialModelMapping.pricingRevision, config.modelCapabilities("azure", "Acme-Chat-1").streaming]));';
  const plain = load({ MODEL_CATALOG: JSON.stringify(acme) }, revisions);
  const declared = load({ MODEL_CATALOG: JSON.stringify(withCapabilities) }, revisions);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(declared.output, [...plain.output.slice(0, 2), false]);
  assert.equal(plain.output[2], true);
  const wrong = load(
    { MODEL_CATALOG: JSON.stringify({ ...acme, families: [{ ...family, capabilities: { api: 'gemini' } }] }) },
    'console.log("{}");',
  );
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Model API must be supported by its provider \(family \\"acme-chat\\"\)/);
});

test('a replaced catalog exposes only the operator families', () => {
  const { status, stderr, output } = load(
    { MODEL_CATALOG: JSON.stringify(acme), MODEL_CATALOG_MODE: 'replace' },
    'console.log(JSON.stringify({ families: config.modelFamilies.map(family => family.id), models: config.modelPricing.models.map(model => model.id), compaction: config.compactionBudgetFamilies.length }));',
  );
  assert.equal(status, 0, stderr);
  assert.deepEqual(output, { families: ['acme-chat'], models: ['acme-chat-1'], compaction: 3 });
});

test('an invalid catalog fails loading with the entry named', () => {
  const { status, stderr } = load({ MODEL_CATALOG_FILE: fixture('model-catalog-invalid.json') }, 'console.log("{}");');
  assert.notEqual(status, 0);
  assert.match(
    stderr,
    /ModelCatalogError: Invalid model catalog \(MODEL_CATALOG_FILE=.*model-catalog-invalid\.json\): models\[0\] "acme-chat-1": metadata\.max_output_tokens/,
  );
});
