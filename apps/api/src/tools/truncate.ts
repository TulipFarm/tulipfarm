import { ok, type ToolCallResult } from "./types";

export const RESULT_CAP = 20;

/** Truncates list-shaped Tool results with `total_count` and `truncated`; errors pass through. */
export function truncateResult(result: ToolCallResult): ToolCallResult {
  if (!result.success) return result;
  const { data } = result;

  if (Array.isArray(data) && data.length > RESULT_CAP) {
    return ok({ items: data.slice(0, RESULT_CAP), total_count: data.length, truncated: true });
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const key of ["items", "results", "data"] as const) {
      const arr = obj[key];
      if (Array.isArray(arr) && arr.length > RESULT_CAP) {
        return ok({
          ...obj,
          [key]: arr.slice(0, RESULT_CAP),
          total_count: arr.length,
          truncated: true,
        });
      }
    }
  }

  return result;
}
