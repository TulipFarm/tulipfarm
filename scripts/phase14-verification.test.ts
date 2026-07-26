import { describe, expect, it } from "vitest";
import { PHASE_14_VERIFICATION } from "../ops/verification/phase14";

const REQUIRED_ORDER = [
  "test",
  "lint",
  "typecheck",
  "build",
  "compose",
  "chat",
  "webhook",
  "schedule",
  "effect",
  "acl-deny",
  "restore",
] as const;

describe("Phase 14 final verification record", () => {
  it("records every required signal in documented order", () => {
    expect(PHASE_14_VERIFICATION.map((signal) => signal.id)).toEqual(REQUIRED_ORDER);
  });

  it("passes all signals and includes recovery plus denied-access evidence", () => {
    expect(PHASE_14_VERIFICATION.every((signal) => signal.status === "passed")).toBe(true);
    expect(PHASE_14_VERIFICATION.find((signal) => signal.id === "restore")?.evidence).toBeTruthy();
    expect(PHASE_14_VERIFICATION.find((signal) => signal.id === "acl-deny")?.evidence).toBeTruthy();
  });
});
