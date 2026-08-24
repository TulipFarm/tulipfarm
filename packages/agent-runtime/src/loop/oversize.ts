/** How a Tool result too large for the transcript is shortened before the model reads it back. */

/**
 * How many characters of one Tool result the transcript will carry.
 *
 * A Tool result is not paid for once. The transcript carries it into every remaining iteration of
 * the same Turn, so the cost is bytes times steps — the runaway `MAX_REREAD_FILES` already bounds
 * for Files and nothing bounded here. The ceiling sits deliberately above the 32,000 characters
 * `file_read` caps its own text at, so a Tool that already honoured its limit is never shortened a
 * second time.
 *
 * The distiller in `distill.ts` bounds succeeded results far lower, at `MAX_RAW_RESULT_CHARS`. The
 * two are not redundant and must not be unified to one number: the distiller never runs on a
 * denied, failed, invalid or superseded result, and it measures only the Tool's own output, not the
 * `callId` envelope `toolMessage` wraps around it. This is the backstop for everything it skips.
 */
export const MAX_TOOL_RESULT_CHARS = 50_000;

/** Characters held back for the keys {@link capToolResult} adds when it shortens a payload. */
const CAP_OVERHEAD = 1_000;

const TRUNCATION_MARK = "...[truncated]";

const GUIDANCE =
  "This result was too large to keep whole, so parts of it were shortened or dropped. " +
  "Narrow the request — add a filter, or ask for fewer items — to see what is missing. " +
  "Do not treat the omitted part as empty.";

/** How many characters `value` contributes once serialized; infinite when it cannot be. */
function width(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Fitted {
  readonly value: unknown;
  /** What was shortened, in terms the model can act on: `output.results: kept 12 of 240 entries`. */
  readonly notes: readonly string[];
}

function fitString(value: string, budget: number, path: string): Fitted {
  let keep = Math.max(0, budget - TRUNCATION_MARK.length - 2);
  // JSON escaping makes a slice serialize wider than its character count, so step back until the
  // escaped form fits. Left unchecked, a newline-heavy string overruns the ceiling and costs the
  // whole payload rather than just its own tail.
  while (keep > 0 && width(`${value.slice(0, keep)}${TRUNCATION_MARK}`) > budget) {
    keep = Math.floor(keep * 0.9);
  }
  return {
    value: `${value.slice(0, keep)}${TRUNCATION_MARK}`,
    notes: [`${path}: kept ${keep} of ${value.length} characters`],
  };
}

function fitArray(value: readonly unknown[], budget: number, path: string): Fitted {
  const kept: unknown[] = [];
  let used = 2;
  for (const entry of value) {
    const next = width(entry) + 1;
    if (used + next > budget) break;
    kept.push(entry);
    used += next;
  }

  // An array whose first entry alone overruns the budget would otherwise come back empty, which
  // the model reads as "there is nothing here" rather than "there was too much". One shortened
  // entry keeps the shape of the data visible.
  if (kept.length === 0 && value.length > 0) {
    const first = fit(value[0], Math.max(0, budget - 2), `${path}[0]`);
    return {
      value: [first.value],
      notes: [`${path}: kept 1 of ${value.length} entries, itself shortened`, ...first.notes],
    };
  }

  return { value: kept, notes: [`${path}: kept ${kept.length} of ${value.length} entries`] };
}

function fitRecord(value: Record<string, unknown>, budget: number, path: string): Fitted {
  const entries = Object.entries(value);
  // Narrowest first, so the cheap fields survive intact and the one fat field absorbs whatever
  // budget is left. Widest first would spend the whole budget on that field and drop the rest,
  // losing the very keys — a status, a total, a cursor — that say how to ask again.
  const order = [...entries].sort((left, right) => width(left[1]) - width(right[1]));

  const fitted = new Map<string, unknown>();
  const notes: string[] = [];
  let remaining = budget - 2;

  for (const [key, entry] of order) {
    const overhead = key.length + 4;
    const result = fit(
      entry,
      Math.max(0, remaining - overhead),
      path === "" ? key : `${path}.${key}`
    );
    fitted.set(key, result.value);
    notes.push(...result.notes);
    remaining -= width(result.value) + overhead;
  }

  // Rebuilt in the Tool's own key order: the model reads this back as its own result, and a
  // reordered one reads as a different shape.
  return { value: Object.fromEntries(entries.map(([key]) => [key, fitted.get(key)])), notes };
}

function fit(value: unknown, budget: number, path: string): Fitted {
  if (width(value) <= budget) return { value, notes: [] };
  if (typeof value === "string") return fitString(value, budget, path);
  if (Array.isArray(value)) return fitArray(value, budget, path);
  if (isRecord(value)) return fitRecord(value, budget, path);

  // A number, a boolean or null fits any budget a caller would set, so reaching here means a value
  // JSON cannot carry at all. Dropping it is the only honest answer.
  return { value: null, notes: [`${path}: dropped, it cannot be shortened`] };
}

/**
 * Shortens one Tool result to {@link MAX_TOOL_RESULT_CHARS}, and tells the model that it did.
 *
 * The ceiling is measured on the whole Tool message, `callId` envelope included, because that is
 * what the transcript actually carries; measuring the payload alone would let every result land
 * over the number this promises.
 *
 * Returns the payload itself when it already fits, so a caller can compare by identity to learn
 * whether anything was cut. The result is always valid JSON: the payload is rebuilt from shortened
 * parts rather than sliced once serialized, which would leave the model parsing a severed object.
 */
export function capToolResult(
  payload: Record<string, unknown>,
  callId: string
): Record<string, unknown> {
  const sent = (candidate: Record<string, unknown>) => width({ callId, ...candidate });
  if (sent(payload) <= MAX_TOOL_RESULT_CHARS) return payload;

  const { value, notes } = fit(payload, MAX_TOOL_RESULT_CHARS - CAP_OVERHEAD - width(callId), "");
  const capped: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
    truncated: true,
    maxChars: MAX_TOOL_RESULT_CHARS,
    shortened: notes,
    note: GUIDANCE,
  };
  if (sent(capped) <= MAX_TOOL_RESULT_CHARS) return capped;

  // The budget arithmetic approximates JSON escaping, so an unusual payload can still land over
  // the ceiling. The ceiling is the point: what the model keeps is that the result existed and
  // that asking again more narrowly is how to see it. Loop-owned metadata rides along, because it
  // describes the call rather than the result and is bounded regardless of how big the result was.
  return {
    truncated: true,
    maxChars: MAX_TOOL_RESULT_CHARS,
    note: GUIDANCE,
    ...(payload.repeatedCall === undefined ? {} : { repeatedCall: payload.repeatedCall }),
  };
}
