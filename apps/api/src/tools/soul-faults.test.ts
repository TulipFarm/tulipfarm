/** Pins Soul Tool fault taxonomy: git contention retries; remote decisions stay business faults. */

import { isInfrastructureFault } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import { isTransientGitFailure, soulCommitError, soulCommitFaultCode } from "./soul-faults";

describe("soul commit fault classification", () => {
  /** The messages git actually emits when another commit holds the worktree. */
  const CONTENTION = [
    "fatal: Unable to create '/soul/.git/index.lock': File exists.",
    "error: could not lock config file .git/config: File exists",
    "fatal: cannot lock ref 'refs/heads/main': is at abc123 but expected def456",
    "fatal: Another git process seems to be running in this repository",
  ];

  it.each(CONTENTION)("treats contention as retryable machinery: %s", (message) => {
    expect(isTransientGitFailure(new Error(message))).toBe(true);
    expect(soulCommitFaultCode(new Error(message))).toBe("unavailable");
    // The whole point of the promotion: this is what makes the dispatcher's retry loop reachable.
    expect(isInfrastructureFault(soulCommitFaultCode(new Error(message)))).toBe(true);
  });

  /**
   * A decision the remote made will be made again, so retrying only reproduces it. These must stay
   * business faults — the model and the person both need to see them.
   */
  const DECISIONS = [
    "remote: Permission to acme/soul.git denied to bot.",
    "! [rejected] main -> main (non-fast-forward)",
    "error: Your local changes to the following files would be overwritten by merge",
    "fatal: could not read Username for 'https://github.com': No such device or address",
    "GH006: Protected branch update failed",
  ];

  it.each(DECISIONS)("leaves a remote's decision as a business fault: %s", (message) => {
    expect(isTransientGitFailure(new Error(message))).toBe(false);
    expect(soulCommitFaultCode(new Error(message))).toBe("internal_error");
    expect(isInfrastructureFault(soulCommitFaultCode(new Error(message)))).toBe(false);
  });

  it("defaults an unrecognized failure to a business fault, not a retry", () => {
    // The catch-all must not widen: promoting the unknown would make most failures run twice for
    // nothing, and `internal_error` covers violated invariants that reproduce exactly.
    expect(soulCommitFaultCode(new Error("something else entirely"))).toBe("internal_error");
    expect(soulCommitFaultCode("a bare string")).toBe("internal_error");
    expect(soulCommitFaultCode(undefined)).toBe("internal_error");
  });

  it("carries the classification through to the tool result the model reads", () => {
    const transient = soulCommitError(new Error("index.lock exists"), "could not save");
    expect(transient).toEqual({
      success: false,
      error: { code: "unavailable", message: "could not save" },
    });

    const deterministic = soulCommitError(new Error("permission denied"), "could not save");
    expect(deterministic).toEqual({
      success: false,
      error: { code: "internal_error", message: "could not save" },
    });
  });
});
