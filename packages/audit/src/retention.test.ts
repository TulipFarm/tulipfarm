import { describe, expect, it } from "vitest";
import { placeLegalHold } from "./legal-hold";
import { eligibleForDeletion, isRetentionExpired, RetentionError } from "./retention";

const POLICIES = [
  { category: "security", retainForDays: 365 },
  { category: "access", retainForDays: 90 },
];

describe("retention", () => {
  it("is not expired before the policy window elapses", () => {
    expect(
      isRetentionExpired(new Date("2026-01-01"), "access", POLICIES, new Date("2026-02-01"))
    ).toBe(false);
  });

  it("is expired once the policy window elapses", () => {
    expect(
      isRetentionExpired(new Date("2026-01-01"), "access", POLICIES, new Date("2026-06-01"))
    ).toBe(true);
  });

  it("throws for an unconfigured category", () => {
    expect(() =>
      isRetentionExpired(new Date("2026-01-01"), "unknown", POLICIES, new Date("2026-06-01"))
    ).toThrow(RetentionError);
  });

  it("is eligible for deletion once expired and unheld", () => {
    expect(
      eligibleForDeletion(
        "biz-1",
        "access",
        "target-1",
        new Date("2026-01-01"),
        POLICIES,
        [],
        new Date("2026-06-01")
      )
    ).toBe(true);
  });

  it("legal hold blocks deletion even after retention expires", () => {
    const hold = placeLegalHold({
      id: "hold-1",
      businessId: "biz-1",
      scope: { type: "category", category: "access" },
      reason: "litigation",
      createdAt: new Date("2026-01-01"),
    });
    expect(
      eligibleForDeletion(
        "biz-1",
        "access",
        "target-1",
        new Date("2026-01-01"),
        POLICIES,
        [hold],
        new Date("2026-06-01")
      )
    ).toBe(false);
  });

  it("is not eligible for deletion before retention expires, even without a hold", () => {
    expect(
      eligibleForDeletion(
        "biz-1",
        "access",
        "target-1",
        new Date("2026-01-01"),
        POLICIES,
        [],
        new Date("2026-01-15")
      )
    ).toBe(false);
  });
});
