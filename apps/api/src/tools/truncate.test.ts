import { describe, expect, it } from "vitest";
import { RESULT_CAP, truncateResult } from "./truncate";

const big = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("truncateResult", () => {
  it("passes error results through unchanged", () => {
    const r = { success: false as const, error: { code: "not_found" as const, message: "x" } };
    expect(truncateResult(r)).toBe(r);
  });

  it("passes through small success data", () => {
    const r = { success: true as const, data: "hello" };
    expect(truncateResult(r)).toBe(r);
  });

  it("passes through array at exactly RESULT_CAP", () => {
    const r = { success: true as const, data: big(RESULT_CAP) };
    expect(truncateResult(r)).toBe(r);
  });

  it("truncates array exceeding RESULT_CAP", () => {
    const r = { success: true as const, data: big(RESULT_CAP + 1) };
    const result = truncateResult(r);
    expect(result).toEqual({
      success: true,
      data: { items: big(RESULT_CAP), total_count: RESULT_CAP + 1, truncated: true },
    });
  });

  it("truncates object.items array exceeding RESULT_CAP", () => {
    const extra = { nextCursor: "abc" };
    const r = { success: true as const, data: { items: big(25), ...extra } };
    const result = truncateResult(r);
    expect(result).toEqual({
      success: true,
      data: { items: big(RESULT_CAP), total_count: 25, truncated: true, ...extra },
    });
  });

  it("truncates object.results array exceeding RESULT_CAP", () => {
    const r = { success: true as const, data: { results: big(30) } };
    const result = truncateResult(r);
    expect(result).toEqual({
      success: true,
      data: { results: big(RESULT_CAP), total_count: 30, truncated: true },
    });
  });

  it("truncates object.data array exceeding RESULT_CAP", () => {
    const r = { success: true as const, data: { data: big(21), meta: "x" } };
    const result = truncateResult(r);
    expect(result).toEqual({
      success: true,
      data: { data: big(RESULT_CAP), total_count: 21, truncated: true, meta: "x" },
    });
  });

  it("passes through object with small array fields", () => {
    const r = { success: true as const, data: { items: big(5) } };
    expect(truncateResult(r)).toBe(r);
  });

  it("passes through object with no list field", () => {
    const r = { success: true as const, data: { count: 5, name: "abc" } };
    expect(truncateResult(r)).toBe(r);
  });
});
