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

  // Validate x-links values on each property
  for (const [field, propSchema] of Object.entries(properties)) {
    const xl = propSchema["x-links"];
    if (xl == null) continue;
    if (typeof xl !== "object" || Array.isArray(xl)) {
      throw new TulipFarmValidationError(
        "resource",
        `/properties/${field}/x-links`,
        "x-links must be an object"
      );
    }
    const { target } = xl as { target?: unknown };
    if (typeof target !== "string" || target.length === 0) {
      throw new TulipFarmValidationError(
        "resource",
        `/properties/${field}/x-links/target`,
        "x-links.target must be a non-empty string"
      );
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

  // Validate x-unique: an array of non-empty field-name arrays, each naming declared properties.
  const uniqueRaw = schema["x-unique"];
  if (uniqueRaw !== undefined) {
    if (!Array.isArray(uniqueRaw)) {
      throw new TulipFarmValidationError("resource", "/x-unique", "x-unique must be an array");
    }
    for (const [i, spec] of uniqueRaw.entries()) {
      if (
        !Array.isArray(spec) ||
        spec.length === 0 ||
        !spec.every((f) => typeof f === "string" && f.length > 0)
      ) {
        throw new TulipFarmValidationError(
          "resource",
          `/x-unique/${i}`,
          "each x-unique entry must be a non-empty array of field names"
        );
      }
      for (const field of spec) {
        if (!(field in properties)) {
          throw new TulipFarmValidationError(
            "resource",
            `/x-unique/${i}`,
            `unknown field in x-unique: "${field}"`
          );
        }
      }
    }
  }
}
