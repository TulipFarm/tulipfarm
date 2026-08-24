import { describe, expect, it } from "vitest";
import { capToolResult, MAX_TOOL_RESULT_CHARS } from "./oversize";

const CALL_ID = "call-1";

const width = (value: unknown) => JSON.stringify(value).length;

/** The ceiling covers the whole Tool message, so a test measures what the transcript carries. */
const sent = (payload: Record<string, unknown>) =>
  JSON.stringify({ callId: CALL_ID, ...payload }).length;

const cap = (payload: Record<string, unknown>) => capToolResult(payload, CALL_ID);

const rows = (count: number, size = 400) =>
  Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, body: "x".repeat(size) }));

describe("capToolResult", () => {
  it("returns the payload itself when it already fits", () => {
    // Identity, not equality: the loop compares by reference to decide whether to warn.
    const payload = { output: { results: rows(3) } };
    expect(cap(payload)).toBe(payload);
  });

  it("keeps an oversized result under the ceiling", () => {
    const capped = cap({ output: { total: 240, results: rows(240) } });
    expect(sent(capped)).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it("stays valid JSON, because the model parses what it reads back", () => {
    // The whole reason the payload is rebuilt rather than sliced once serialized: a severed
    // object is worse to the model than a shortened one.
    const capped = cap({ output: { total: 240, results: rows(240) } });
    expect(() => JSON.parse(JSON.stringify(capped))).not.toThrow();
  });

  it("trims the entries and says how many of how many survived", () => {
    const capped = cap({ output: { total: 240, results: rows(240) } });
    const output = capped.output as { results: unknown[] };

    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results.length).toBeLessThan(240);
    expect(capped.shortened).toContain(
      `output.results: kept ${output.results.length} of 240 entries`
    );
  });

  it("spends the budget on the fat field and leaves the small ones whole", () => {
    // The small keys are how the model learns to ask again — a total, a cursor, a status. Losing
    // them to the field that caused the overrun would strand it.
    const capped = cap({
      output: { total: 240, cursor: "page-2", status: "ok", results: rows(240) },
    });
    const output = capped.output as Record<string, unknown>;

    expect(output.total).toBe(240);
    expect(output.cursor).toBe("page-2");
    expect(output.status).toBe("ok");
  });

  it("keeps the Tool's own key order", () => {
    const capped = cap({
      output: { total: 240, results: rows(240), cursor: "page-2" },
    });
    expect(Object.keys(capped.output as object)).toEqual(["total", "results", "cursor"]);
  });

  it("tells the model it was shortened, and not to read the gap as empty", () => {
    const capped = cap({ output: { results: rows(240) } });

    expect(capped.truncated).toBe(true);
    expect(capped.maxChars).toBe(MAX_TOOL_RESULT_CHARS);
    expect(capped.note).toContain("Narrow the request");
    expect(capped.note).toContain("Do not treat the omitted part as empty");
  });

  it("shortens a single long string and marks where it stopped", () => {
    const capped = cap({ output: { text: "a".repeat(80_000) } });
    const text = (capped.output as { text: string }).text;

    expect(text.endsWith("...[truncated]")).toBe(true);
    expect(sent(capped)).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it("survives a string whose escaped form is far wider than its characters", () => {
    // A newline-heavy body serializes to roughly twice its length, which is exactly the case the
    // naive character budget gets wrong.
    const capped = cap({ output: { text: '"\n'.repeat(60_000) } });
    expect(sent(capped)).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it("keeps one shortened entry rather than returning an empty array", () => {
    // An empty array reads as "there is nothing here". The point is that there was too much.
    const capped = cap({ output: [{ body: "x".repeat(120_000) }] });
    const output = capped.output as unknown[];

    expect(output).toHaveLength(1);
    expect(sent(capped)).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(capped.shortened).toContain("output: kept 1 of 1 entries, itself shortened");
  });

  it("shortens a fat error detail the same way it shortens output", () => {
    const capped = cap({ error: "failed", detail: "e".repeat(90_000) });

    expect(capped.error).toBe("failed");
    expect(sent(capped)).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });
});

describe("capToolResult and the Tool message envelope", () => {
  /** Grows a payload until its own serialized width is exactly `target`. */
  const payloadOfWidth = (target: number) => {
    const fixed = width({ output: "" });
    return { output: "y".repeat(target - fixed) };
  };

  it("counts the callId, so a payload at the ceiling is still shortened", () => {
    // The payload alone fits exactly. The Tool message the loop actually sends does not, because
    // `toolMessage` serializes `{ callId, ...payload }` — measuring the payload alone would put
    // every result of this size over the number this promises.
    const payload = payloadOfWidth(MAX_TOOL_RESULT_CHARS);
    expect(width(payload)).toBe(MAX_TOOL_RESULT_CHARS);
    expect(sent(payload)).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);

    const capped = cap(payload);
    expect(capped).not.toBe(payload);
    expect(sent(capped)).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it("leaves a payload that fits with its envelope untouched", () => {
    const payload = payloadOfWidth(MAX_TOOL_RESULT_CHARS - 100);
    expect(cap(payload)).toBe(payload);
  });

  it("keeps loop-owned metadata even on the last-resort fallback", () => {
    // Thousands of tiny fields defeat the fitting arithmetic and reach the minimal fallback. The
    // repeat marker describes the call rather than the result, and is bounded whatever the result
    // did, so dropping it there would lose the one thing that was never the problem.
    const wide: Record<string, unknown> = { repeatedCall: { count: 2, note: "n" } };
    for (let i = 0; i < 4_000; i += 1) wide[`field-${i}`] = "z".repeat(40);

    const capped = cap(wide);
    expect(sent(capped)).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(capped.repeatedCall).toEqual({ count: 2, note: "n" });
  });
});
