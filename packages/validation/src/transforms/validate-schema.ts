import { TulipFarmValidationError } from "../error";
import { isComputedFnKey } from "./computed";
import { isNormalizerKey } from "./normalizers";

export function validateResourceSchema(schema: Record<string, unknown>): void {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

  // Validate x-normalize values on each property
  for (const [field, propSchema] of Object.entries(properties)) {
    const normalizers = propSchema["x-normalize"];
    if (!Array.isArray(normalizers)) continue;
    for (const key of normalizers) {
      if (typeof key !== "string" || !isNormalizerKey(key)) {
        throw new TulipFarmValidationError(
          "resource",
          `/properties/${field}/x-normalize`,
          `unknown normalizer: "${key}"`
        );
      }
    }
  }

  // Validate x-computed fn values
  const computedRaw = schema["x-computed"];
  const computedSpecs = Array.isArray(computedRaw)
    ? computedRaw
    : computedRaw != null
      ? [computedRaw]
      : [];

  for (const spec of computedSpecs) {
    if (typeof spec !== "object" || spec === null) continue;
    const { fn } = spec as { fn?: unknown };
    if (typeof fn !== "string" || !isComputedFnKey(fn)) {
      throw new TulipFarmValidationError(
        "resource",
        "/x-computed/fn",
        `unknown computed fn: "${fn}"`
      );
    }
  }
}
