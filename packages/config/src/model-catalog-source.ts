import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Loads the operator model catalog (MODEL_CATALOG_FILE or MODEL_CATALOG) and merges it with the shipped
// catalog. Entries are validated with the same schemas as the shipped catalog, so new entry fields flow
// through without changes here.

export const modelCatalogModes = ['extend', 'replace'] as const;
export type ModelCatalogMode = (typeof modelCatalogModes)[number];

export type ModelCatalogSource = { label: string; mode: ModelCatalogMode; value: unknown };
type FamilyEntry = { readonly id: string; readonly currentModelId: string; readonly modelIds: readonly string[] };
type ModelEntry = { readonly id: string };
export type ModelCatalogContent<F extends FamilyEntry = FamilyEntry, M extends ModelEntry = ModelEntry> = {
  families: readonly F[];
  models: readonly M[];
};

export class ModelCatalogError extends Error {
  constructor(source: string, detail: string) {
    super(`Invalid model catalog (${source}): ${detail}`);
    this.name = 'ModelCatalogError';
  }
}

/** Reads the operator catalog named by the environment; null when neither setting is set. */
export function readModelCatalogSource(env: Record<string, string | undefined>): ModelCatalogSource | null {
  const file = env.MODEL_CATALOG_FILE?.trim() || undefined;
  const inline = env.MODEL_CATALOG?.trim() || undefined;
  const modeValue = env.MODEL_CATALOG_MODE?.trim() || 'extend';
  const label = file ? `MODEL_CATALOG_FILE=${file}` : 'MODEL_CATALOG';
  if (!(modelCatalogModes as readonly string[]).includes(modeValue))
    throw new ModelCatalogError(
      'MODEL_CATALOG_MODE',
      `expected one of ${modelCatalogModes.join(', ')}, got ${JSON.stringify(modeValue)}`,
    );
  const mode = modeValue as ModelCatalogMode;
  if (file && inline) throw new ModelCatalogError('MODEL_CATALOG_FILE, MODEL_CATALOG', 'set only one of them');
  if (!file && !inline) {
    if (env.MODEL_CATALOG_MODE?.trim())
      throw new ModelCatalogError('MODEL_CATALOG_MODE', 'set MODEL_CATALOG_FILE or MODEL_CATALOG');
    return null;
  }
  let text = inline ?? '';
  if (file) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new ModelCatalogError(label, `cannot read the file (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  try {
    return { label, mode, value: JSON.parse(text) };
  } catch (error) {
    throw new ModelCatalogError(label, `not valid JSON (${(error as Error).message})`);
  }
}

const fileShape = z.strictObject({
  families: z.array(z.unknown()).default([]),
  models: z.array(z.unknown()).default([]),
});

function describeIssues(error: z.ZodError) {
  return error.issues
    .map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ');
}

function entryName(kind: 'families' | 'models', index: number, value: unknown) {
  const id =
    typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
      ? ` ${JSON.stringify(value.id)}`
      : '';
  return `${kind}[${index}]${id}`;
}

function parseEntries<T extends { readonly id: string }>(
  source: string,
  kind: 'families' | 'models',
  values: readonly unknown[],
  schema: z.ZodType<T>,
) {
  const seen = new Set<string>();
  return values.map((value, index) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ModelCatalogError(source, `${entryName(kind, index, value)}: ${describeIssues(parsed.error)}`);
    if (seen.has(parsed.data.id)) throw new ModelCatalogError(source, `${entryName(kind, index, value)}: duplicate id`);
    seen.add(parsed.data.id);
    return parsed.data;
  });
}

function mergeById<T extends { readonly id: string }>(shipped: readonly T[], external: readonly T[]) {
  const overrides = new Map(external.map(entry => [entry.id, entry]));
  const merged = shipped.map(entry => overrides.get(entry.id) ?? entry);
  return [...merged, ...external.filter(entry => !shipped.some(item => item.id === entry.id))];
}

/**
 * Returns the effective catalog. `extend` replaces shipped entries with the same id and adds new ones;
 * shipped models that no family references any more are dropped. `replace` uses only the operator catalog.
 */
export function buildModelCatalog<F extends FamilyEntry, M extends ModelEntry>(input: {
  shipped: ModelCatalogContent<F, M>;
  source: ModelCatalogSource | null;
  schemas: { family: z.ZodType<F>; model: z.ZodType<M> };
}): ModelCatalogContent<F, M> {
  if (!input.source) return input.shipped;
  const { label, mode } = input.source;
  const file = fileShape.safeParse(input.source.value);
  if (!file.success)
    throw new ModelCatalogError(
      label,
      `expected { "families": [...], "models": [...] }: ${describeIssues(file.error)}`,
    );
  const families = parseEntries(label, 'families', file.data.families, input.schemas.family);
  const models = parseEntries(label, 'models', file.data.models, input.schemas.model);
  const effectiveFamilies = mode === 'replace' ? families : mergeById(input.shipped.families, families);
  const referenced = new Set(effectiveFamilies.flatMap(family => family.modelIds));
  const effectiveModels =
    mode === 'replace'
      ? models
      : mergeById(
          input.shipped.models.filter(model => referenced.has(model.id)),
          models,
        );
  if (effectiveFamilies.length === 0) throw new ModelCatalogError(label, 'the catalog has no model families');
  const owners = new Map<string, string>();
  for (const family of effectiveFamilies) {
    const name = `family ${JSON.stringify(family.id)}`;
    if (!family.modelIds.includes(family.currentModelId))
      throw new ModelCatalogError(
        label,
        `${name}: currentModelId ${JSON.stringify(family.currentModelId)} is not in its modelIds`,
      );
    for (const modelId of family.modelIds) {
      if (!effectiveModels.some(model => model.id === modelId))
        throw new ModelCatalogError(label, `${name}: model ${JSON.stringify(modelId)} is not in the catalog models`);
      const owner = owners.get(modelId);
      if (owner !== undefined)
        throw new ModelCatalogError(
          label,
          `${name}: model ${JSON.stringify(modelId)} already belongs to family ${JSON.stringify(owner)}`,
        );
      owners.set(modelId, family.id);
    }
  }
  for (const model of effectiveModels)
    if (!owners.has(model.id))
      throw new ModelCatalogError(label, `model ${JSON.stringify(model.id)} does not belong to any family`);
  return { families: effectiveFamilies, models: effectiveModels };
}

/** `value` with object keys sorted recursively, so its JSON is independent of key order. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Entry fields that do not affect mapping or pricing, so editing them keeps the revisions. */
const unrevisionedFields = new Set(['capabilities', 'roles', 'endpoint', 'credentialEnv']);

/** SHA-256 of the entries in canonical JSON, independent of entry and key order. */
export function modelCatalogDigest(entries: readonly { readonly id: string }[]) {
  const sorted = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(entry => Object.fromEntries(Object.entries(entry).filter(([key]) => !unrevisionedFields.has(key))));
  return createHash('sha256')
    .update(JSON.stringify(canonical(sorted)))
    .digest('hex');
}

/**
 * Revision of a catalog part. Content equal to the shipped catalog keeps its published revision, so data
 * persisted before operator catalogs existed stays valid; any other content gets `<prefix>-<digest>`.
 */
export function modelCatalogRevision(
  prefix: string,
  published: string,
  shipped: readonly { readonly id: string }[],
  effective: readonly { readonly id: string }[],
) {
  const digest = modelCatalogDigest(effective);
  return digest === modelCatalogDigest(shipped) ? published : `${prefix}-${digest.slice(0, 32)}`;
}
