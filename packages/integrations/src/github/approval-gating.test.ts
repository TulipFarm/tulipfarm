import type { AuthorityLayer, DlpRule, GuardrailRule } from "@tulipfarm/authz";
import { ToolBroker, ToolCatalog, type ToolIntent } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { GITHUB_TOOL_CONTRACTS, GITHUB_TOOL_IDS } from "./contracts";

/**
 * Phase 9 cross-cutting check: approval gating is guardrail-rule-driven, not automatic from
 * `riskClass` (see `packages/authz/src/guardrails/engine.ts` — nothing reads `riskClass` off a
 * Tool contract). The mechanism is provider-neutral, but each high-risk action still needs its own
 * `require_approval` rule wired by the deployment. This asserts the two highest-risk PR/commit
 * contracts (Phase 5/6) gate correctly once such a rule exists, mirroring the pattern already
 * proven for `issueClose` in `apps/worker/test/e2e/github-jira-triage/harness.ts`.
 */

const catalog = ToolCatalog.load(GITHUB_TOOL_CONTRACTS);
const broker = new ToolBroker(catalog);

const authorityLayers: readonly AuthorityLayer[] = [
  { name: "test", grants: [{ action: "*", resourceType: "*", effect: "allow" }] },
];

const dlpRules: readonly DlpRule[] = [
  { dataClass: "source_content", allowedDestinations: ["github"] },
];

function guardrailRulesRequiring(action: string): readonly GuardrailRule[] {
  return [
    { id: "allow", effect: "allow", action: "*", resourceType: "*" },
    { id: "approve", effect: "require_approval", action, resourceType: "*" },
  ];
}

function intent(overrides: Partial<ToolIntent>): ToolIntent {
  return {
    intentId: "intent-1",
    businessId: "business-1",
    runId: "run-1",
    stateId: "state-1",
    toolVersion: "1.0.0",
    targetRefs: [{ type: "github.pull_request", id: "tulip/farm#12" }],
    destination: "github",
    credentialRef: "secret://github",
    idempotencyKey: "effect-1",
    ...overrides,
  } as ToolIntent;
}

describe("GitHub approval gating (Phase 9)", () => {
  it("requires approval for pull_request.merge once a guardrail rule names it", () => {
    const outcome = broker.authorize(
      intent({
        toolId: GITHUB_TOOL_IDS.pullRequestMerge,
        action: GITHUB_TOOL_IDS.pullRequestMerge,
        arguments: { repository: "tulip/farm", pullNumber: 12, mergeMethod: "squash" },
      }),
      {
        authorityLayers,
        guardrailRules: guardrailRulesRequiring(GITHUB_TOOL_IDS.pullRequestMerge),
        dlpRules,
        guardrailRevision: "guardrail-rev-1",
        taint: "untrusted",
        autonomy: "propose_actions",
      }
    );

    expect(outcome.outcome).toBe("awaiting_approval");
  });

  it("requires approval for repo.push once a guardrail rule names it", () => {
    const outcome = broker.authorize(
      intent({
        toolId: GITHUB_TOOL_IDS.repoPush,
        action: GITHUB_TOOL_IDS.repoPush,
        targetRefs: [{ type: "github.repository", id: "tulip/farm" }],
        arguments: {
          repository: "tulip/farm",
          branch: "main",
          message: "fix crash",
          files: [{ path: "src/a.ts", content: "export {}" }],
        },
      }),
      {
        authorityLayers,
        guardrailRules: guardrailRulesRequiring(GITHUB_TOOL_IDS.repoPush),
        dlpRules,
        guardrailRevision: "guardrail-rev-1",
        taint: "untrusted",
        autonomy: "propose_actions",
      }
    );

    expect(outcome.outcome).toBe("awaiting_approval");
  });

  it("dispatches immediately with no matching guardrail rule (the gap this test guards against)", () => {
    const outcome = broker.authorize(
      intent({
        toolId: GITHUB_TOOL_IDS.pullRequestMerge,
        action: GITHUB_TOOL_IDS.pullRequestMerge,
        arguments: { repository: "tulip/farm", pullNumber: 12, mergeMethod: "squash" },
      }),
      {
        authorityLayers,
        guardrailRules: [{ id: "allow", effect: "allow", action: "*", resourceType: "*" }],
        dlpRules,
        guardrailRevision: "guardrail-rev-1",
        taint: "untrusted",
        autonomy: "propose_actions",
      }
    );

    expect(outcome.outcome).toBe("authorized");
  });
});
