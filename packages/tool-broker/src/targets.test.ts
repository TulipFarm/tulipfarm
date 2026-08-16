import { describe, expect, it } from "vitest";
import { type PublishedToolContract, publishToolContract } from "./contract";
import { deriveContractTargets, ToolTargetDerivationError } from "./targets";

function contract(spec: Record<string, unknown>): PublishedToolContract {
  return publishToolContract({
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: "01J0000000000000000000TOOL",
      slug: "github-issue-comment",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: "a".repeat(64),
    },
    spec: {
      toolId: "github.issue.comment",
      toolVersion: "1.0.0",
      action: "issue.comment",
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: { type: "object", additionalProperties: true },
      riskClass: "medium",
      mutating: true,
      dryRun: false,
      idempotency: { strategy: "provider" },
      adapter: { kind: "integration", ref: "github" },
      ...spec,
      // biome-ignore lint/suspicious/noExplicitAny: authored fixture, shaped like a Soul document.
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: authored fixture, shaped like a Soul document.
  } as any);
}

const TARGETED = {
  requiredResources: ["github.issue"],
  targets: [{ type: "github.issue", id: "{repository}#{issueNumber}" }],
};

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ToolTargetDerivationError) return error.code;
    throw error;
  }
  throw new Error("expected a derivation refusal");
}

describe("deriveContractTargets", () => {
  it("interpolates dotted argument paths into one concrete object id", () => {
    expect(
      deriveContractTargets(contract(TARGETED), {
        repository: "tulip/farm",
        issueNumber: 42,
      })
    ).toEqual([{ type: "github.issue", id: "tulip/farm#42" }]);
  });

  it("reads a nested path and keeps a declared domain", () => {
    const nested = contract({
      requiredResources: ["record"],
      targets: [{ type: "record", id: "{ticket.id}", domain: "support" }],
    });

    expect(deriveContractTargets(nested, { ticket: { id: "t-1" } })).toEqual([
      { type: "record", id: "t-1", domain: "support" },
    ]);
  });

  it("derives nothing only when the contract declares nothing", () => {
    expect(deriveContractTargets(contract({}), { repository: "tulip/farm" })).toEqual([]);
  });

  it("refuses a placeholder the arguments do not answer with a non-empty scalar", () => {
    const subject = contract(TARGETED);
    expect(code(() => deriveContractTargets(subject, { repository: "tulip/farm" }))).toBe(
      "target_unresolved"
    );
    expect(code(() => deriveContractTargets(subject, { repository: "", issueNumber: 42 }))).toBe(
      "target_unresolved"
    );
    expect(code(() => deriveContractTargets(subject, { repository: ["a"], issueNumber: 42 }))).toBe(
      "target_unresolved"
    );
  });

  it("refuses an id that would read as a grant wildcard", () => {
    const subject = contract({
      requiredResources: ["github.issue"],
      targets: [{ type: "github.issue", id: "{scope}" }],
    });

    expect(code(() => deriveContractTargets(subject, { scope: "*" }))).toBe("target_invalid");
  });

  it("refuses a target type no required resource covers", () => {
    const subject = contract({
      requiredResources: ["github.repository"],
      targets: TARGETED.targets,
    });

    expect(
      code(() => deriveContractTargets(subject, { repository: "tulip/farm", issueNumber: 42 }))
    ).toBe("target_type_undeclared");
  });

  it("refuses when deriving would drop a declared resource from the decision", () => {
    const subject = contract({
      requiredResources: ["github.issue", "github.repository"],
      targets: TARGETED.targets,
    });

    expect(
      code(() => deriveContractTargets(subject, { repository: "tulip/farm", issueNumber: 42 }))
    ).toBe("target_drops_resource");
  });
});
