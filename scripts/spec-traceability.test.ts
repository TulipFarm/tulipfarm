import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHASE_14_TRACEABILITY } from "../ops/cutover/spec-traceability";

const REQUIRED_SECTIONS = Array.from({ length: 29 }, (_, index) => String(index + 1));

describe("Phase 14 specification traceability", () => {
  it("maps every numbered specification section", () => {
    expect(PHASE_14_TRACEABILITY.sections.map((entry) => entry.id)).toEqual(REQUIRED_SECTIONS);
  });

  it("maps every invariant and cutover criterion without silent deferral", () => {
    expect(PHASE_14_TRACEABILITY.invariants.length).toBeGreaterThan(0);
    expect(PHASE_14_TRACEABILITY.cutoverCriteria.length).toBeGreaterThan(0);
    const entries = [
      ...PHASE_14_TRACEABILITY.sections,
      ...PHASE_14_TRACEABILITY.invariants,
      ...PHASE_14_TRACEABILITY.cutoverCriteria,
    ];
    expect(entries.every((entry) => entry.status === "met" || entry.status === "blocked")).toBe(
      true
    );
    expect(
      entries.filter((entry) => entry.status === "blocked").every((entry) => Boolean(entry.blocker))
    ).toBe(true);
    expect(entries.every((entry) => entry.evidence.length > 0)).toBe(true);
    expect(
      entries.every((entry) =>
        entry.evidence.every((path) => existsSync(resolve(process.cwd(), path)))
      )
    ).toBe(true);
    expect(entries.some((entry) => entry.evidence.some((path) => path.includes("TASKS.md")))).toBe(
      false
    );
  });

  it("keeps known production cutover gaps release-blocking", () => {
    const blocked = new Set(
      [...PHASE_14_TRACEABILITY.invariants, ...PHASE_14_TRACEABILITY.cutoverCriteria]
        .filter((entry) => entry.status === "blocked")
        .map((entry) => entry.id)
    );
    expect(blocked).toEqual(new Set(["I-05", "I-07", "C-01", "C-02", "C-06", "C-09"]));
  });

  it("backs every normative runtime section with executable evidence", () => {
    const runtimeSections = PHASE_14_TRACEABILITY.sections.filter((entry) => {
      const id = Number(entry.id);
      return id >= 5 && id <= 26;
    });
    expect(
      runtimeSections.every((entry) =>
        entry.evidence.some((path) => path.endsWith(".test.ts") || path.endsWith(".test.tsx"))
      )
    ).toBe(true);
  });
});
