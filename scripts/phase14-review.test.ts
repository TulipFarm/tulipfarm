import { describe, expect, it } from "vitest";
import { PHASE_14_RESOLVED_MAJORS, PHASE_14_REVIEW } from "../ops/cutover/review";

const REQUIRED_CATEGORIES = [
  "Security",
  "Correctness",
  "Performance",
  "Design",
  "Readability",
  "Convention",
  "Testing",
] as const;

describe("Phase 14 whole-rewrite review", () => {
  it("records every required review category in order", () => {
    expect(PHASE_14_REVIEW.map((section) => section.category)).toEqual(REQUIRED_CATEGORIES);
  });

  it("leaves no major finding and gives every minor a disposition", () => {
    const findings = PHASE_14_REVIEW.flatMap((section) => section.findings);
    expect(findings.filter((finding) => finding.severity === "MAJOR")).toEqual([]);
    expect(
      findings
        .filter((finding) => finding.severity === "MINOR")
        .every((finding) => finding.disposition === "fixed" || finding.disposition === "deferred")
    ).toBe(true);
    expect(
      findings
        .filter((finding) => finding.disposition === "deferred")
        .every((finding) => Boolean(finding.reason))
    ).toBe(true);
  });

  it("records every discovered major as fixed with evidence", () => {
    expect(PHASE_14_RESOLVED_MAJORS).toHaveLength(3);
    expect(
      PHASE_14_RESOLVED_MAJORS.every(
        (finding) =>
          finding.severity === "MAJOR" &&
          finding.disposition === "fixed" &&
          finding.evidence.length > 0
      )
    ).toBe(true);
  });
});
