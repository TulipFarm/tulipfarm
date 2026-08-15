import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertThreatModelReleaseGate,
  RELEASE_FINDINGS,
  THREAT_MODEL_CATEGORIES,
  THREAT_MODEL_CONTROLS,
} from "./threat-model";

const ROOT = resolve(import.meta.dirname, "../..");

describe("Phase 14 threat-model release gate", () => {
  it("is actually executed by a command CI runs", () => {
    // This gate sat outside every test run for its whole life: `test/security` is not a workspace,
    // so `turbo test` never reached it, and `architecture:test` did not name it. It went red
    // unnoticed when three cited files were deleted. A gate nothing runs is not a gate.
    const scripts = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).scripts;
    expect(scripts["architecture:test"]).toContain("test/security");
  });

  it("maps every required threat category to executable evidence", () => {
    expect(THREAT_MODEL_CONTROLS.map((control) => control.category)).toEqual(
      THREAT_MODEL_CATEGORIES
    );
    for (const control of THREAT_MODEL_CONTROLS) {
      expect(control.evidence.length, control.category).toBeGreaterThan(0);
      for (const path of control.evidence) {
        expect(existsSync(resolve(ROOT, path)), `${control.category}: ${path}`).toBe(true);
      }
    }
  });

  it("does not cite skipped, todo, or suppressed security evidence", () => {
    for (const control of THREAT_MODEL_CONTROLS) {
      for (const path of control.evidence) {
        const source = readFileSync(resolve(ROOT, path), "utf8");
        expect(source, path).not.toMatch(/\b(?:it|test|describe)\.(?:skip|todo)\b/);
        expect(source, path).not.toContain("security-gate-suppression");
      }
    }
  });

  it("blocks release for every open critical finding or suppressed finding", () => {
    expect(RELEASE_FINDINGS).toEqual([]);
    expect(() => assertThreatModelReleaseGate(RELEASE_FINDINGS)).not.toThrow();
    expect(() =>
      assertThreatModelReleaseGate([
        {
          id: "SEC-001",
          severity: "critical",
          status: "open",
          category: "privilege_escalation",
          summary: "authorization bypass",
          suppressed: false,
        },
      ])
    ).toThrowError("release-blocking security finding: SEC-001");
    expect(() =>
      assertThreatModelReleaseGate([
        {
          id: "SEC-002",
          severity: "low",
          status: "fixed",
          category: "supply_chain",
          summary: "suppressed test",
          suppressed: true,
        },
      ])
    ).toThrowError("suppressed security finding: SEC-002");
  });
});
