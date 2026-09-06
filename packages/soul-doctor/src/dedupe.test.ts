import { describe, expect, it } from "vitest";
import { DOCTOR_DEDUPE_PREFIX, doctorDedupeKey, isDoctorDedupeKey } from "./dedupe";
import { finding } from "./finding";

const BASE = {
  code: "routine_uncompilable",
  severity: "broken",
  at: "/spec/start",
  detail: "does not compile",
} as const;

describe("doctorDedupeKey", () => {
  // A key that moved with the digest would open a new Task on every republish, while the defect
  // an operator is already looking at stays exactly as broken.
  it("survives a republish of the same broken artifact", () => {
    const first = finding({ ...BASE, subject: { kind: "routine", id: "quotes", digest: "a" } });
    const second = finding({ ...BASE, subject: { kind: "routine", id: "quotes", digest: "b" } });
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(doctorDedupeKey(first)).toBe(doctorDedupeKey(second));
  });

  it("separates two defects in one artifact", () => {
    const subject = { kind: "routine", id: "quotes" };
    expect(doctorDedupeKey(finding({ ...BASE, subject }))).not.toBe(
      doctorDedupeKey(finding({ ...BASE, code: "run_parked", subject }))
    );
  });

  it("claims a namespace an Agent-facing Tool can recognise", () => {
    expect(doctorDedupeKey(finding({ ...BASE, subject: { kind: "routine", id: "q" } }))).toMatch(
      new RegExp(`^${DOCTOR_DEDUPE_PREFIX}`)
    );
    expect(isDoctorDedupeKey("provider-key")).toBe(false);
  });
});
