import { describe, expect, it } from "vitest";
import { restrictedSurfaceCarveOut, surfaceGrants } from "./surface-catalog";

describe("surfaceGrants", () => {
  it("emits one grant per named action", () => {
    expect(surfaceGrants([{ type: "secret", actions: ["secret.read", "*"] }], "allow")).toEqual([
      { action: "secret.read", resourceType: "secret", effect: "allow" },
      { action: "*", resourceType: "secret", effect: "allow" },
    ]);
  });
});

describe("restrictedSurfaceCarveOut", () => {
  const restricted = [{ type: "secret", actions: ["secret.write"] }];

  it("denies a restricted action a same-type wildcard would otherwise reach", () => {
    expect(restrictedSurfaceCarveOut(restricted, [{ type: "secret", actions: ["*"] }])).toEqual([
      { action: "secret.write", resourceType: "secret", effect: "deny" },
    ]);
  });

  it("denies a restricted action named outright by the allow-list", () => {
    const allowed = [{ type: "secret", actions: ["secret.read", "secret.write"] }];
    expect(restrictedSurfaceCarveOut(restricted, allowed)).toEqual([
      { action: "secret.write", resourceType: "secret", effect: "deny" },
    ]);
  });

  it("emits nothing when the allow-list cannot reach the restricted action", () => {
    expect(
      restrictedSurfaceCarveOut(restricted, [{ type: "secret", actions: ["secret.read"] }])
    ).toEqual([]);
  });

  it("always denies the caller's residual actions, whatever the allow-list names", () => {
    expect(restrictedSurfaceCarveOut(restricted, [], ["record.read"])).toEqual([
      { action: "record.read", resourceType: "secret", effect: "deny" },
    ]);
  });
});
