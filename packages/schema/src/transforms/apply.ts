import { TulipFarmValidationError } from "../error";
import { applyComputedFn, type ComputedFnKey, type CounterFn } from "./computed";
import { applyNormalizer, isNormalizerKey } from "./normalizers";

interface IdStrategy {
  field?: string;
  prefix?: string;
  sequence?: boolean;
}

interface ComputedSpec {
  field: string;
  from: string[];
  fn: string;
}

interface TransformOpts {
  counter?: CounterFn;
}

async function applyIdStrategy(
  resourceType: string,
  schema: Record<string, unknown>,
  out: Record<string, unknown>,
  opts?: TransformOpts
): Promise<void> {
  const idStrategy = schema["x-id-strategy"] as IdStrategy | undefined;
  if (!idStrategy?.sequence) return;
  const targetField = idStrategy.field ?? "id";
  if (!opts?.counter) {
    throw new TulipFarmValidationError(
      "resource",
      `/${targetField}`,
      "counter required for x-id-strategy"
    );
  }
  const n = await opts.counter(resourceType);
  out[targetField] = `${idStrategy.prefix ?? ""}${n}`;
}

function applyNormalizers(schema: Record<string, unknown>, out: Record<string, unknown>): void {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [field, propSchema] of Object.entries(properties)) {
    const normalizers = propSchema["x-normalize"];
    if (!Array.isArray(normalizers)) continue;
    const raw = out[field];
    if (typeof raw !== "string") continue;
    let normalized: string = raw;
    for (const key of normalizers) {
      if (isNormalizerKey(key)) {
        normalized = applyNormalizer(key, normalized);
      }
    }
    out[field] = normalized;
  }
}

async function applyComputed(
  resourceType: string,
  schema: Record<string, unknown>,
  out: Record<string, unknown>,
  opts?: TransformOpts
): Promise<void> {
  const computedRaw = schema["x-computed"];
  const specs: ComputedSpec[] = Array.isArray(computedRaw)
    ? (computedRaw as ComputedSpec[])
    : computedRaw != null
      ? [computedRaw as ComputedSpec]
      : [];

  for (const spec of specs) {
    const values = spec.from.map((f) => String(out[f] ?? ""));
    out[spec.field] = await applyComputedFn(spec.fn as ComputedFnKey, {
      values,
      resourceType,
      counter: opts?.counter,
    });
  }
}

export async function applyTransforms(
  resourceType: string,
  schema: Record<string, unknown>,
  record: Record<string, unknown>,
  opts?: TransformOpts
): Promise<Record<string, unknown>> {
  const out = { ...record };
  await applyIdStrategy(resourceType, schema, out, opts);
  applyNormalizers(schema, out);
  await applyComputed(resourceType, schema, out, opts);
  return out;
}
