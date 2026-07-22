import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalize } from "./canonicalize";
import { CanonicalizationError } from "./errors";

describe("canonicalize", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      canonicalize({
        z: [{ beta: 2, alpha: 1 }, "last"],
        a: { enabled: true, nullable: null },
      })
    ).toBe('{"a":{"enabled":true,"nullable":null},"z":[{"alpha":1,"beta":2},"last"]}');
  });

  it("produces the same SHA-256 hash for equivalent parsed data", () => {
    const first = { kind: "Agent", apiVersion: "tulipfarm.ai/v1", spec: { b: 2, a: 1 } };
    const second = { spec: { a: 1, b: 2 }, apiVersion: "tulipfarm.ai/v1", kind: "Agent" };

    expect(canonicalHash(first)).toBe(canonicalHash(second));
    expect(canonicalHash(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the canonical hash format stable with a known vector", () => {
    expect(canonicalHash({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
  });

  it("does not erase meaningful array ordering", () => {
    expect(canonicalHash({ values: [1, 2] })).not.toBe(canonicalHash({ values: [2, 1] }));
  });

  it.each([
    ["undefined", { value: undefined }],
    ["non-finite number", { value: Number.NaN }],
    ["bigint", { value: 1n }],
    ["non-plain object", { value: new Date("2026-07-22T00:00:00.000Z") }],
  ])("rejects %s instead of silently changing it", (_label, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });

  it("rejects cyclic input with a payload-free structured error", () => {
    const value: Record<string, unknown> = { secret: "do-not-disclose" };
    value.self = value;

    try {
      canonicalize(value);
      throw new Error("expected canonicalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalizationError);
      expect(error).toMatchObject({ code: "CANONICALIZATION_FAILED", path: "/self" });
      expect((error as Error).message).not.toContain("do-not-disclose");
    }
  });

  it("rejects array properties that JSON serialization would silently erase", () => {
    const value = ["visible"];
    Object.assign(value, { hiddenByJson: "must-not-disappear" });

    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });

  it("rejects array accessors instead of invoking them", () => {
    const value: string[] = [];
    Object.defineProperty(value, "0", {
      enumerable: true,
      get: () => "stateful",
    });
    value.length = 1;

    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });
});
