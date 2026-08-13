import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isInfrastructureFault, TOOL_FAULT_CLASS, type ToolErrorCode } from "./types";

/**
 * The taxonomy exists to keep two failures apart that look identical in prose: a request that will
 * be refused every time, and machinery that was momentarily busy. Confusing them is costly in both
 * directions — a retried denial burns budget on an answer that cannot change, and a deterministic
 * bug reported as "try again" hides itself behind an infinite retry.
 *
 * These tests guard the property that makes the distinction usable: it is *total*. A code with no
 * class is a code whose handling is whatever the first reader assumed.
 */
describe("tool fault taxonomy", () => {
  /**
   * `TOOL_FAULT_CLASS` is typed `Record<ToolErrorCode, ...>`, so omitting a code fails the build.
   * This asserts the converse the type cannot: that no *extra* key has been added, which would
   * silently classify a code that no longer exists and mask a genuine omission behind a passing
   * key count.
   */
  it("classifies exactly the codes the union declares, no more and no fewer", () => {
    const source = readFileSync(join(__dirname, "types.ts"), "utf8");
    const union = source.slice(
      source.indexOf("export type ToolErrorCode ="),
      source.indexOf("export const TOOL_FAULT_CLASS")
    );
    const declared = new Set([...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]));
    expect(declared.size).toBeGreaterThan(0);
    expect([...Object.keys(TOOL_FAULT_CLASS)].sort()).toEqual([...declared].sort());
  });

  /**
   * A denial is deterministic even though nothing about it is malformed: the grant will not appear
   * on its own between two attempts. Retrying it is the specific waste this class prevents.
   */
  it("treats a policy refusal as business, not as something to retry", () => {
    expect(isInfrastructureFault("write_denied")).toBe(false);
    expect(isInfrastructureFault("audit_required")).toBe(false);
  });

  /**
   * `internal_error` must stay business. It names a violated invariant or a malformed provider
   * response — both reproduce exactly, so retrying only defers the same failure while spending
   * time. It is precisely because `internal_error` is the catch-all that `unavailable` had to be
   * split out rather than widening it.
   */
  it("keeps internal_error deterministic so the catch-all is never retried", () => {
    expect(isInfrastructureFault("internal_error")).toBe(false);
  });

  it("treats unavailable as infrastructure", () => {
    expect(isInfrastructureFault("unavailable")).toBe(true);
  });

  /**
   * The model is shown business faults so it can repair them, and must not be shown infrastructure
   * faults, which it cannot. If every code were infrastructure the model could never learn it had
   * called something wrongly; if none were, contention would always look like the model's fault.
   */
  it("keeps both classes populated, so neither reading collapses", () => {
    const values = Object.values(TOOL_FAULT_CLASS);
    expect(values).toContain("business");
    expect(values).toContain("infrastructure");
  });

  it("gives every code exactly one class", () => {
    for (const [code, klass] of Object.entries(TOOL_FAULT_CLASS)) {
      expect(["business", "infrastructure"]).toContain(klass);
      expect(isInfrastructureFault(code as ToolErrorCode)).toBe(klass === "infrastructure");
    }
  });
});
