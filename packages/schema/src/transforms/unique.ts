/** One `x-unique` entry: a single column, or a combination that together must be unique. */
export type UniqueKeySpec = readonly string[];

export function getUniqueKeySpecs(schema: Record<string, unknown>): UniqueKeySpec[] {
  const raw = schema["x-unique"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (spec): spec is string[] =>
      Array.isArray(spec) && spec.length > 0 && spec.every((f) => typeof f === "string")
  );
}
