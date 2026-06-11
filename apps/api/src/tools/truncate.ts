import { ok, type ToolCallResult } from "./types";

export const RESULT_CAP = 20;

/**
 * Truncate a large tool result for LLM context (TOOL-V1-010). Caps list-shaped
 * data at RESULT_CAP items and annotates with total_count + truncated flag so
 * the agent knows it can paginate. Error results are passed through unchanged.
 */
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
