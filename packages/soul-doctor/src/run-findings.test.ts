import { describe, expect, it } from "vitest";
import { runFindings, type UnhealthyRunRow } from "./run-findings";

function row(overrides: Partial<UnhealthyRunRow> = {}): UnhealthyRunRow {
  return {
    id: "run-1",
    status: "needs_reconciliation",
    errorEvidenceRef: "routine:input_not_evaluable:SendQuote",
    routineSlug: "engineering-motivation-quotes",
    createdAt: new Date("2026-09-06T00:00:00.000Z"),
    ...overrides,
  };
}

describe("runFindings", () => {
  it("explains a parked Run in terms of the mapping that broke", () => {
    const [found] = runFindings([row()]);
    expect(found).toMatchObject({
      code: "run_parked",
      severity: "broken",
      subject: { kind: "routine", id: "engineering-motivation-quotes" },
      at: "SendQuote",
    });
    expect(found?.detail).toContain("never published");
    expect(found?.detail).toContain("reads as still running");
    expect(found?.detail).toContain("run-1");
  });

  // One authoring bug parks every Run it starts. Reporting each one separately would propose the
  // same repair once per Run, forever.
  it("collapses every Run parked by the same Routine and State onto one finding", () => {
    const found = runFindings([row({ id: "run-1" }), row({ id: "run-2" }), row({ id: "run-3" })]);
    expect(found).toHaveLength(1);
  });

  it("keeps a Run with no Routine as its own subject, since there is nothing else to repair", () => {
    const [found] = runFindings([row({ routineSlug: null, errorEvidenceRef: null })]);
    expect(found).toMatchObject({
      subject: { kind: "run", id: "run-1" },
      at: "needs_reconciliation",
    });
    expect(found?.detail).toContain("no evidence was recorded");
  });

  it("reports a Run stalled past its lease separately from a parked one", () => {
    const [found] = runFindings([row({ status: "running", errorEvidenceRef: null })]);
    expect(found).toMatchObject({ code: "run_stalled", at: "running" });
    expect(found?.detail).toContain("past its lease");
  });
});
