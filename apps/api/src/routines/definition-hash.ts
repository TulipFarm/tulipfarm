import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalize(object[key])])
  );
}

/** Hashes JSON-compatible Routine definitions independent of object insertion order. */
export function definitionHash(definition: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(definition)))
    .digest("hex");
}
