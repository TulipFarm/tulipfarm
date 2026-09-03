/**
 * Narrows an unknown to a plain object.
 *
 * Arrays are excluded: every caller uses this before reading named keys, and `typeof [] === "object"`
 * would otherwise let an array through to code that then reads properties it cannot have.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
