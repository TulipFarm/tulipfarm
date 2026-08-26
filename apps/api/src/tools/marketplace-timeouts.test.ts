import { SKILL_AUDIT } from "@tulipfarm/built-in-agents";
import { DEFAULT_GIT_CLONE_LIMITS } from "@tulipfarm/integrations";
import { MARKETPLACE_SKILL_TOOL_TIMEOUTS_MS, MARKETPLACE_SKILL_TOOLS } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";

/**
 * `packages/tool-host` cannot import the clone or audit budget — neither package is a dependency
 * of it — so its wall clocks are written out as numbers. This is the only place all three are
 * visible at once, which makes it the only place that can catch one of them moving apart.
 *
 * The gap this guards produced a `skill_install` that could not succeed at all: the host's 30s
 * default expired while the clone was still running, so a real catalogue URL failed at 32s having
 * never reached the audit the Tool exists to run.
 */
describe("marketplace Skill Tool wall clocks", () => {
  const clone = DEFAULT_GIT_CLONE_LIMITS.timeoutMs;
  const audit = SKILL_AUDIT.timeoutMs;

  it("gives every remote-reaching Tool longer than the work it waits on", () => {
    // A deadline equal to the inner budget still leaves the inner timeout no way to report
    // itself, so each must be strictly greater.
    expect(MARKETPLACE_SKILL_TOOL_TIMEOUTS_MS.skill_marketplace_browse).toBeGreaterThan(clone);
    expect(MARKETPLACE_SKILL_TOOL_TIMEOUTS_MS.skill_source_scan).toBeGreaterThan(clone);
    expect(MARKETPLACE_SKILL_TOOL_TIMEOUTS_MS.skill_scanned_audit).toBeGreaterThan(audit);
    // `skill_install` clones and audits in one call, so it needs room for both.
    expect(MARKETPLACE_SKILL_TOOL_TIMEOUTS_MS.skill_install).toBeGreaterThan(clone + audit);
  });

  it("declares those wall clocks on the Tools themselves", () => {
    const declared = new Map(
      MARKETPLACE_SKILL_TOOLS.map((tool) => [tool.name, tool.timeout?.wallClockMs])
    );
    for (const [name, expected] of Object.entries(MARKETPLACE_SKILL_TOOL_TIMEOUTS_MS)) {
      expect(declared.get(name), `${name} wall clock`).toBe(expected);
    }
  });

  it("leaves the Tool that only writes on the host default", () => {
    // `skill_scanned_install` installs from an already-cloned, already-audited scan, so it waits
    // on neither. Declaring a long wall clock there would only delay noticing a stuck write.
    const scannedInstall = MARKETPLACE_SKILL_TOOLS.find(
      (tool) => tool.name === "skill_scanned_install"
    );
    expect(scannedInstall?.timeout).toBeUndefined();
  });
});
