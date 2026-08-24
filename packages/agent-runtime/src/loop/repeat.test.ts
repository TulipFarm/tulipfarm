import { describe, expect, it } from "vitest";
import { callSignature, repeatedCall } from "./repeat";

describe("callSignature", () => {
  it("matches the same arguments written in a different key order", () => {
    // Providers do not promise key order, so without this a repeat would never match itself.
    expect(callSignature("record_list", { type: "ticket", limit: 10 })).toBe(
      callSignature("record_list", { limit: 10, type: "ticket" })
    );
  });

  it("normalizes nested objects too", () => {
    expect(callSignature("q", { filter: { b: 2, a: 1 }, page: 1 })).toBe(
      callSignature("q", { page: 1, filter: { a: 1, b: 2 } })
    );
  });

  it("separates calls that differ in any value", () => {
    expect(callSignature("record_list", { limit: 10 })).not.toBe(
      callSignature("record_list", { limit: 11 })
    );
  });

  it("separates calls to different Tools", () => {
    expect(callSignature("record_list", { a: 1 })).not.toBe(callSignature("record_get", { a: 1 }));
  });

  it("keeps array order significant, because the Tool sees it", () => {
    expect(callSignature("q", { ids: ["a", "b"] })).not.toBe(
      callSignature("q", { ids: ["b", "a"] })
    );
  });

  it("treats a name that contains the separator as its own Tool", () => {
    expect(callSignature("a\u0000b", null)).not.toBe(callSignature("a", "b"));
  });

  it("handles arguments that are not objects", () => {
    expect(callSignature("q", undefined)).toBe(callSignature("q", undefined));
    expect(callSignature("q", null)).not.toBe(callSignature("q", 0));
  });
});

describe("repeatedCall", () => {
  it("names the count and tells the model nothing was reused", () => {
    const marker = repeatedCall(3);

    expect(marker.count).toBe(3);
    expect(marker.note).toContain("call 3");
    expect(marker.note).toContain("Nothing was reused");
  });
});

describe("callSignature when the arguments cannot be walked", () => {
  /** Nesting `JSON.stringify` carries easily, but a recursive walk cannot. */
  function nest(depth: number): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let i = 0; i < depth; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.n = next;
      cursor = next;
    }
    return root;
  }

  it("answers undefined instead of throwing on arguments too deep to walk", () => {
    // This runs after the Tool has already executed, so throwing would lose a result the Run has
    // been charged for. Losing the annotation instead is the cheaper failure.
    expect(() => callSignature("q", nest(10_000))).not.toThrow();
    expect(callSignature("q", nest(10_000))).toBeUndefined();
  });

  it("answers undefined on a value JSON cannot carry", () => {
    expect(callSignature("q", { total: 1n })).toBeUndefined();
  });

  it("still signs ordinary arguments", () => {
    expect(callSignature("q", { a: 1 })).toBeDefined();
  });
});
