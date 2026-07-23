import { describe, expect, it } from "vitest";
import {
  isDeletionBlocked,
  isHeld,
  LegalHoldError,
  placeLegalHold,
  releaseLegalHold,
} from "./legal-hold";

describe("legal-hold", () => {
  it("blocks deletion for its scope while active", () => {
    const hold = placeLegalHold({
      id: "hold-1",
      businessId: "biz-1",
      scope: { type: "category", category: "security" },
      reason: "litigation",
      createdAt: new Date("2026-01-01"),
    });
    const now = new Date("2026-06-01");
    expect(isHeld(hold, "biz-1", "security", "target-1", now)).toBe(true);
    expect(isHeld(hold, "biz-1", "financial", "target-1", now)).toBe(false);
    expect(isHeld(hold, "biz-2", "security", "target-1", now)).toBe(false);
  });

  it("stops blocking once released", () => {
    const hold = placeLegalHold({
      id: "hold-1",
      businessId: "biz-1",
      scope: { type: "business" },
      reason: "litigation",
      createdAt: new Date("2026-01-01"),
    });
    const released = releaseLegalHold(hold, new Date("2026-02-01"));
    expect(isHeld(released, "biz-1", "any", "target-1", new Date("2026-03-01"))).toBe(false);
    expect(isHeld(released, "biz-1", "any", "target-1", new Date("2026-01-15"))).toBe(true);
  });

  it("refuses to release an already-released hold", () => {
    const hold = placeLegalHold({
      id: "hold-1",
      businessId: "biz-1",
      scope: { type: "business" },
      reason: "litigation",
      createdAt: new Date("2026-01-01"),
    });
    const released = releaseLegalHold(hold, new Date("2026-02-01"));
    expect(() => releaseLegalHold(released, new Date("2026-03-01"))).toThrow(LegalHoldError);
  });

  it("requires a reason", () => {
    expect(() =>
      placeLegalHold({
        id: "hold-1",
        businessId: "biz-1",
        scope: { type: "business" },
        reason: "",
        createdAt: new Date(),
      })
    ).toThrow(LegalHoldError);
  });

  it("isDeletionBlocked is true if any hold in the list covers the target", () => {
    const holds = [
      placeLegalHold({
        id: "hold-1",
        businessId: "biz-1",
        scope: { type: "target", target: "target-9" },
        reason: "litigation",
        createdAt: new Date("2026-01-01"),
      }),
    ];
    expect(isDeletionBlocked(holds, "biz-1", "any", "target-9", new Date("2026-02-01"))).toBe(true);
    expect(isDeletionBlocked(holds, "biz-1", "any", "target-1", new Date("2026-02-01"))).toBe(
      false
    );
  });

  it("exposes no way to read event content — only hold-state functions", async () => {
    const module = await import("./legal-hold");
    const exported = Object.keys(module).sort();
    expect(exported).toEqual(
      ["LegalHoldError", "isDeletionBlocked", "isHeld", "placeLegalHold", "releaseLegalHold"].sort()
    );
  });
});
