import { describe, expect, it } from "vitest";
import {
  PHASE_14_RELEASE_READY,
  PHASE_14_RESOLVED_MAJORS,
  PHASE_14_REVIEW,
} from "../ops/cutover/review";

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

  it("gives every finding a disposition and reason when deferred", () => {
    const findings = PHASE_14_REVIEW.flatMap((section) => section.findings);
    expect(
      findings.every(
        (finding) => finding.disposition === "fixed" || finding.disposition === "deferred"
      )
    ).toBe(true);
    expect(
      findings
        .filter((finding) => finding.disposition === "deferred")
        .every((finding) => Boolean(finding.reason))
    ).toBe(true);
  });

  it("does not declare the release ready while a major remains deferred", () => {
    const deferredMajors = PHASE_14_REVIEW.flatMap((section) => section.findings).filter(
      (finding) => finding.severity === "MAJOR" && finding.disposition === "deferred"
    );
    expect(deferredMajors.length).toBeGreaterThan(0);
    expect(PHASE_14_RELEASE_READY).toBe(false);
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
