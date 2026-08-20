import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isIndeterminateFault,
  isInfrastructureFault,
  TOOL_FAULT_CLASS,
  type ToolErrorCode,
} from "./types";

describe("tool fault taxonomy", () => {
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

  it("treats a policy refusal as business, not as something to retry", () => {
    expect(isInfrastructureFault("write_denied")).toBe(false);
    expect(isInfrastructureFault("audit_required")).toBe(false);
  });

  it("keeps internal_error deterministic so the catch-all is never retried", () => {
    expect(isInfrastructureFault("internal_error")).toBe(false);
  });

  it("treats unavailable as infrastructure", () => {
    expect(isInfrastructureFault("unavailable")).toBe(true);
  });

  it("keeps an abandoned call out of both retryable readings", () => {
    expect(isInfrastructureFault("indeterminate")).toBe(false);
    expect(isIndeterminateFault("indeterminate")).toBe(true);
    expect(isIndeterminateFault("unavailable")).toBe(false);
  });

  it("keeps every class populated, so no reading collapses", () => {
    const values = Object.values(TOOL_FAULT_CLASS);
    expect(values).toContain("business");
    expect(values).toContain("infrastructure");
    expect(values).toContain("indeterminate");
  });

  it("gives every code exactly one class", () => {
    for (const [code, klass] of Object.entries(TOOL_FAULT_CLASS)) {
      expect(["business", "infrastructure", "indeterminate"]).toContain(klass);
      expect(isInfrastructureFault(code as ToolErrorCode)).toBe(klass === "infrastructure");
      expect(isIndeterminateFault(code as ToolErrorCode)).toBe(klass === "indeterminate");
    }
  });
});
