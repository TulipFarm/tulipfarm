import { describe, expect, it } from "vitest";
import { deriveGlyph, GLYPH_HUE_COUNT } from "./derive";

describe("deriveGlyph", () => {
  it("maps each domain family to its base shape", () => {
    expect(deriveGlyph("a", "Customer Support").base).toBe("burst");
    expect(deriveGlyph("a", "Sales").base).toBe("cross");
    expect(deriveGlyph("a", "Research & Analysis").base).toBe("poly");
    expect(deriveGlyph("a", "Data Processing").base).toBe("vector");
    expect(deriveGlyph("a", "Operations").base).toBe("graph");
    expect(deriveGlyph("a", "Finance").base).toBe("radial");
    expect(deriveGlyph("a", "Legal & Compliance").base).toBe("lattice");
  });

  it("is case-insensitive on the domain", () => {
    expect(deriveGlyph("a", "SUPPORT").base).toBe("burst");
    expect(deriveGlyph("a", "support").base).toBe("burst");
    expect(deriveGlyph("a", "Support").base).toBe("burst");
  });

  it("splits multi-word / punctuated domains and matches any token", () => {
    expect(deriveGlyph("a", "sales/revenue pipeline").base).toBe("cross");
    expect(deriveGlyph("a", "customer-success-desk").base).toBe("burst");
  });

  it("matches short keywords (hr) only as whole tokens — no substring false positives", () => {
    expect(deriveGlyph("a", "HR").base).toBe("lattice");
    expect(deriveGlyph("a", "Human Resources").base).toBe("lattice");
    // "threat" contains "hr" as a substring; it must NOT trigger the hr/lattice family. Proven by
    // showing the domain has no keyword effect (falls back to the same name-hashed base).
    expect(deriveGlyph("Zed", "Threat Hunting").base).toBe(deriveGlyph("Zed").base);
  });

  it("falls back to a name-hashed base for unknown or empty domains", () => {
    const unknown = deriveGlyph("Zebra", "underwater basket weaving");
    const empty = deriveGlyph("Zebra", "");
    const none = deriveGlyph("Zebra");
    // No domain signal → all three resolve via the name hash, identically.
    expect(unknown.base).toBe(none.base);
    expect(empty.base).toBe(none.base);
  });

  it("is deterministic — same inputs, same output", () => {
    expect(deriveGlyph("GeneralAssistant")).toEqual(deriveGlyph("GeneralAssistant"));
    expect(deriveGlyph("x", "Sales", "full")).toEqual(deriveGlyph("x", "Sales", "full"));
  });

  it("derives hue from the name only — stable across domain changes", () => {
    const asSales = deriveGlyph("Atlas", "Sales");
    const asSupport = deriveGlyph("Atlas", "Support");
    expect(asSales.hue).toBe(asSupport.hue);
    expect(asSales.base).not.toBe(asSupport.base); // base still tracks domain
  });

  it("keeps every hue within the muted palette range (never ruby)", () => {
    for (let i = 0; i < 200; i++) {
      const { hue } = deriveGlyph(`agent-${i}`);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(GLYPH_HUE_COUNT);
    }
  });

  it("maps autonomy to stroke weight", () => {
    expect(deriveGlyph("a", undefined, "full").weight).toBe(2.5);
    expect(deriveGlyph("a", undefined, "supervised").weight).toBe(2);
    expect(deriveGlyph("a", undefined, "approval-required").weight).toBe(1.5);
    expect(deriveGlyph("a", undefined, "manual").weight).toBe(1);
    expect(deriveGlyph("a").weight).toBe(1.5); // undefined → center default
  });
});
