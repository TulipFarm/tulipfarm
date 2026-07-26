import { describe, expect, it } from "vitest";
import { classifyHttpFailure, collectPages, PaginationBoundError } from "./http";

describe("classifyHttpFailure", () => {
  it("treats a 2xx as success", () => {
    expect(classifyHttpFailure({ status: 200, headers: {}, body: {} }, true)).toBeNull();
    expect(classifyHttpFailure({ status: 204, headers: {}, body: null }, false)).toBeNull();
  });

  it("never retries an authorization failure", () => {
    const failure = classifyHttpFailure({ status: 403, headers: {}, body: {} }, true);
    expect(failure).toMatchObject({
      phase: "before_dispatch",
      code: "provider_unauthorized",
      retryable: false,
    });
  });

  it("reads Retry-After seconds off a rate-limit response", () => {
    const failure = classifyHttpFailure(
      { status: 429, headers: { "retry-after": "12" }, body: {} },
      true
    );
    expect(failure).toMatchObject({
      phase: "before_dispatch",
      code: "provider_rate_limited",
      retryable: true,
      retryAfterMs: 12_000,
    });
  });

  it("classifies a 5xx on a mutating call as after_dispatch so it reconciles", () => {
    expect(classifyHttpFailure({ status: 502, headers: {}, body: {} }, true)).toMatchObject({
      phase: "after_dispatch",
      retryable: true,
    });
    expect(classifyHttpFailure({ status: 502, headers: {}, body: {} }, false)).toMatchObject({
      phase: "before_dispatch",
      retryable: true,
    });
  });

  it("does not retry an unprocessable request", () => {
    expect(classifyHttpFailure({ status: 422, headers: {}, body: {} }, true)).toMatchObject({
      code: "provider_rejected",
      retryable: false,
    });
  });
});

describe("collectPages", () => {
  it("walks cursors until the provider stops offering one", async () => {
    const pages = new Map<string, { items: number[]; nextCursor?: string }>([
      ["start", { items: [1, 2], nextCursor: "b" }],
      ["b", { items: [3] }],
    ]);
    const items = await collectPages<number>(
      async (cursor) => pages.get(cursor ?? "start") ?? { items: [] },
      { maxPages: 5, maxItems: 10 }
    );
    expect(items).toEqual([1, 2, 3]);
  });

  it("refuses to walk past the declared page bound rather than truncating silently", async () => {
    await expect(
      collectPages<number>(async () => ({ items: [1], nextCursor: "next" }), {
        maxPages: 2,
        maxItems: 10,
      })
    ).rejects.toBeInstanceOf(PaginationBoundError);
  });

  it("refuses to accumulate past the declared item bound", async () => {
    await expect(
      collectPages<number>(async () => ({ items: [1, 2, 3], nextCursor: "next" }), {
        maxPages: 5,
        maxItems: 4,
      })
    ).rejects.toMatchObject({ bound: "max_items" });
  });
});
