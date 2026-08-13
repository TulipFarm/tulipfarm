import { describe, expect, it } from "vitest";
import { CompositeToolEntitlement, type ToolEntitlementPort } from "./entitlement";

function port(provider: string, verdict: Awaited<ReturnType<ToolEntitlementPort["check"]>>) {
  return { provider, check: async () => verdict };
}

const QUERY = {
  businessId: "biz-1",
  principal: { kind: "user", id: "u1" },
  provider: "github",
  action: "read",
  targetRefs: [],
};

describe("CompositeToolEntitlement", () => {
  it("routes a query to the port owning its provider", async () => {
    const composite = new CompositeToolEntitlement([
      port("slack", { allowed: false }),
      port("github", { allowed: true }),
    ]);
    expect(await composite.check(QUERY)).toEqual({ allowed: true });
  });

  it("reports an uncovered provider as an unguarded gap rather than a determination", async () => {
    // The distinction is load-bearing: `undefined` from `check` means the caller must decide, and
    // `covers` is how it tells "no model wired" apart from "the model could not answer".
    const composite = new CompositeToolEntitlement([port("slack", { allowed: true })]);
    expect(await composite.check(QUERY)).toBeUndefined();
    expect(composite.covers("github")).toBe(false);
    expect(composite.covers("slack")).toBe(true);
  });

  it("lists what it covers so the remaining gaps can be read off", async () => {
    const composite = new CompositeToolEntitlement([
      port("notion", { allowed: true }),
      port("github", { allowed: true }),
    ]);
    expect(composite.coveredProviders()).toEqual(["github", "notion"]);
  });

  it("turns a throwing port into 'could not determine', not a dispatch fault", async () => {
    const composite = new CompositeToolEntitlement([
      {
        provider: "github",
        check: async () => {
          throw new Error("GitHub is down");
        },
      },
    ]);
    expect(await composite.check(QUERY)).toBeUndefined();
  });

  it("passes a port's own denial through so the caller can be told why", async () => {
    const composite = new CompositeToolEntitlement([
      port("github", { allowed: false, reason: "you do not have access to acme/api on GitHub" }),
    ]);
    expect(await composite.check(QUERY)).toEqual({
      allowed: false,
      reason: "you do not have access to acme/api on GitHub",
    });
  });
});
