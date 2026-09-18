import type { LiveSourceAuthorizationPort } from "@tulipfarm/knowledge";
import { describe, expect, it, vi } from "vitest";
import { CompositeLiveSourceAuthorization } from "./live-authorization";

const input: Parameters<LiveSourceAuthorizationPort["check"]>[0] = {
  businessId: "business",
  sourceId: "source",
  provider: "mcp",
  externalId: "file",
  principals: [{ kind: "user", id: "reader" }],
};

describe("CompositeLiveSourceAuthorization", () => {
  it("preserves the actual reader and checks live on every use", async () => {
    const check = vi
      .fn<LiveSourceAuthorizationPort["check"]>()
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });
    const gate = new CompositeLiveSourceAuthorization([{ check }]);
    expect(await gate.check(input)).toEqual({ allowed: true });
    expect(await gate.check(input)).toEqual({ allowed: false });
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenNthCalledWith(1, input);
    expect(check).toHaveBeenNthCalledWith(2, input);
  });

  it("does not fall through an explicit denial to another provider", async () => {
    const fallback = vi
      .fn<LiveSourceAuthorizationPort["check"]>()
      .mockResolvedValue({ allowed: true });
    const gate = new CompositeLiveSourceAuthorization([
      { check: async () => ({ allowed: false }) },
      { check: fallback },
    ]);
    expect(await gate.check(input)).toEqual({ allowed: false });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("tries the next port only when a provider has no decision", async () => {
    const gate = new CompositeLiveSourceAuthorization([
      { check: async () => undefined },
      { check: async () => ({ allowed: true }) },
    ]);
    expect(await gate.check(input)).toEqual({ allowed: true });
  });

  it("does not manufacture access for unsupported sources", async () => {
    const gate = new CompositeLiveSourceAuthorization([]);
    expect(await gate.check({ ...input, provider: "slack" })).toBeUndefined();
  });

  it("propagates failures instead of trying a permissive fallback", async () => {
    const fallback = vi
      .fn<LiveSourceAuthorizationPort["check"]>()
      .mockResolvedValue({ allowed: true });
    const gate = new CompositeLiveSourceAuthorization([
      {
        check: async () => {
          throw new Error("unavailable");
        },
      },
      { check: fallback },
    ]);
    await expect(gate.check(input)).rejects.toThrow("unavailable");
    expect(fallback).not.toHaveBeenCalled();
  });
});
