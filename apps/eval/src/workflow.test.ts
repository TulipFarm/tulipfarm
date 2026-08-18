import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The eval workflow is a spend boundary, not just an automation.
 *
 * Nothing in the harness can stop a workflow from handing a fork's pull request two live
 * subscription seats — GitHub decides that, from the trigger list and the Environment. So the
 * decision is pinned here: a later change that adds `pull_request` to run evals on PRs, or drops
 * `environment` to skip the approval pause, fails this file rather than quietly opening the seats.
 */
const workflow = parse(
  readFileSync(resolve(__dirname, "..", "..", "..", ".github", "workflows", "eval.yml"), "utf8")
) as {
  // `on` is the YAML 1.1 boolean `true`, which is why it is read off the parsed object by key.
  readonly on: Record<string, unknown>;
  readonly jobs: Record<
    string,
    {
      readonly environment?: string;
      readonly "timeout-minutes"?: number;
      readonly steps: readonly { readonly env?: Record<string, string>; readonly run?: string }[];
    }
  >;
};

const job = workflow.jobs.sweep;

describe("the eval workflow", () => {
  it("can only be started by hand", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  });

  it("runs in the protected Environment that holds the seats", () => {
    expect(job?.environment).toBe("eval");
  });

  it("bounds its own wall clock, which a token ceiling cannot", () => {
    expect(job?.["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("reads each seat credential from a secret, never from a workflow input", () => {
    const seats = job?.steps.flatMap((step) => Object.entries(step.env ?? {})) ?? [];
    for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_AUTH_JSON"]) {
      const bound = seats.find(([key]) => key === name);
      expect(bound?.[1]).toBe(`\${{ secrets.${name} }}`);
    }
  });
});

describe("what a release Sweep covers", () => {
  const sweep = workflow.jobs.sweep?.steps.find((step) => step.run?.includes("seat.sh"));

  it("sweeps the red-team Corpus as well as the capability one", () => {
    // Two separate Sweeps rather than one: the corpora carry separate hashes and separate
    // Baselines, so merging them would make adding an attack invalidate the capability Baseline.
    expect(sweep?.run).toContain("corpus/red-team");
  });

  it("does not let a failing capability Sweep skip the safety one", () => {
    // `set -e` here would abandon the red-team Sweep the moment a capability Case failed — and the
    // safety answer is the one a maintainer under release pressure would otherwise skip.
    expect(sweep?.run).not.toContain("set -euo pipefail");
    expect(sweep?.run).toContain("overall=$status");
  });
});
