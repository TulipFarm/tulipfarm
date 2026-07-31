import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "~/lib/uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomUUID", () => {
  it("uses the native implementation when available", () => {
    expect(randomUUID()).toMatch(V4);
  });

  // A non-secure context (plain http on a LAN IP) does not expose `crypto.randomUUID`.
  it("falls back to getRandomValues when randomUUID is missing", () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(randomUUID()).toMatch(V4);
    expect(randomUUID()).not.toBe(randomUUID());
  });
});
