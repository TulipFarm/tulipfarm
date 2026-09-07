import type { OimPollingIngress } from "@tulipfarm/schema";
import { readPointer } from "./delivery";

export interface PollingCursorAdvance {
  readonly cursor: string | null;
  readonly deliveries: readonly {
    readonly deduplicationKey: string;
    readonly payload: unknown;
  }[];
}

export class PollingCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollingCursorError";
  }
}

type PollingCursorDefinition = OimPollingIngress["cursor"];
type MaxIntegerPollingCursor = Extract<
  PollingCursorDefinition,
  { readonly mode: "max_integer_plus_one" }
>;

function isMaxIntegerCursor(
  definition: PollingCursorDefinition
): definition is MaxIntegerPollingCursor {
  return "mode" in definition && definition.mode === "max_integer_plus_one";
}

function integerCursorValue(cursor: string): number {
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new PollingCursorError("persisted cursor is not a canonical non-negative integer");
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) {
    throw new PollingCursorError("persisted cursor exceeds the safe integer range");
  }
  return value;
}

export function pollingCursorRequestValue(
  cursor: string | null,
  definition: PollingCursorDefinition
): string | number | null {
  if (cursor === null || !isMaxIntegerCursor(definition)) return cursor;
  return integerCursorValue(cursor);
}

export function advancePollingCursor(
  response: unknown,
  currentCursor: string | null,
  definition: PollingCursorDefinition
): PollingCursorAdvance {
  if (!isMaxIntegerCursor(definition)) {
    const value = readPointer(response, definition.responsePointer);
    if (typeof value !== "string" || value.length === 0) {
      throw new PollingCursorError("response pointer did not select a non-empty string cursor");
    }
    return { cursor: value, deliveries: [{ deduplicationKey: value, payload: response }] };
  }

  const items = readPointer(response, definition.responsePointer);
  if (!Array.isArray(items)) {
    throw new PollingCursorError("response pointer did not select an array");
  }
  if (items.length === 0) return { cursor: currentCursor, deliveries: [] };

  let maximum = -1;
  const deliveries: Array<{ deduplicationKey: string; payload: unknown }> = [];
  for (const [index, item] of items.entries()) {
    const value = readPointer(item, definition.itemPointer);
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new PollingCursorError(`item ${index} has no integer id`);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PollingCursorError(`item ${index} has no safe non-negative integer id`);
    }
    maximum = Math.max(maximum, value);
    deliveries.push({ deduplicationKey: String(value), payload: item });
  }
  if (maximum === Number.MAX_SAFE_INTEGER) {
    throw new PollingCursorError("next cursor exceeds the safe integer range");
  }

  const next = maximum + 1;
  const current = currentCursor === null ? null : integerCursorValue(currentCursor);
  return {
    cursor: String(current === null ? next : Math.max(current, next)),
    deliveries,
  };
}
