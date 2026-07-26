import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHASE_14_TRACEABILITY } from "../ops/cutover/spec-traceability";

const REQUIRED_SECTIONS = ["20", "21", "22", "23", "24", "25", "26"] as const;

describe("Phase 14 specification traceability", () => {
  it("maps every numbered phase specification section", () => {
    expect(PHASE_14_TRACEABILITY.sections.map((entry) => entry.id)).toEqual(REQUIRED_SECTIONS);
  });

  it("maps every invariant and cutover criterion without deferral", () => {
    expect(PHASE_14_TRACEABILITY.invariants.length).toBeGreaterThan(0);
    expect(PHASE_14_TRACEABILITY.cutoverCriteria.length).toBeGreaterThan(0);
    const entries = [
      ...PHASE_14_TRACEABILITY.sections,
      ...PHASE_14_TRACEABILITY.invariants,
      ...PHASE_14_TRACEABILITY.cutoverCriteria,
    ];
    expect(entries.every((entry) => entry.status === "met")).toBe(true);
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
});
