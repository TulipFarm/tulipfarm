import type { AccessGrant, AuthorityLayer, DlpRule, GuardrailRule } from "@tulipfarm/authz";
import type { ToolContractDefinition } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { ToolAuthorizationContext } from "./authorize";
import { ToolBroker } from "./broker";
import { ToolCatalog } from "./catalog";

const contract: ToolContractDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "ToolContract",
  metadata: {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "github-issue-label",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "active",
    publishedDigest: "a".repeat(64),
  },
  spec: {
    toolId: "github.issue.label",
    toolVersion: "1.0.0",
    action: "issue.label",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: { label: { type: "string" } },
    },
    outputSchema: { type: "object" },
    riskClass: "medium",
    mutating: true,
    requiredActions: ["issue.label"],
    requiredResources: ["issue"],
    dataClasses: ["internal"],
    allowedDestinations: ["github.com"],
    idempotency: { strategy: "provider" },
    dryRun: false,
    adapter: { kind: "integration", ref: "github" },
  },
};

const grant: AccessGrant = {
  action: "issue.label",
  resourceType: "issue",
  recordSelector: "issue-42",
  destination: "github.com",
  effect: "allow",
};

const authorityLayers: AuthorityLayer[] = [
  { name: "user", grants: [grant] },
  { name: "agent", grants: [grant] },
  { name: "run", grants: [grant] },
  { name: "tool", grants: [grant] },
  { name: "credential", grants: [grant] },
];

const guardrailRules: GuardrailRule[] = [
  {
    id: "tool-allow",
    effect: "allow",
    action: "issue.label",
    resourceType: "issue",
    recordSelector: "issue-42",
    destination: "github.com",
    maxAutonomy: "execute_policy_authorized",
    maxTaint: "trusted",
  },
];

const dlpRules: DlpRule[] = [{ dataClass: "internal", allowedDestinations: ["github.com"] }];

function context(overrides: Partial<ToolAuthorizationContext> = {}): ToolAuthorizationContext {
  return {
    authorityLayers,
    guardrailRules,
    dlpRules,
    guardrailRevision: "guardrail-v3",
    autonomy: "execute_low_risk",
    taint: "trusted",
    ...overrides,
  };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    intentId: "intent-1",
    businessId: "business-1",
    runId: "run-1",
    stateId: "state-1",
    toolId: "github.issue.label",
    toolVersion: "1.0.0",
    action: "issue.label",
    targetRefs: [{ type: "issue", id: "issue-42" }],
    arguments: { label: "triaged" },
    destination: "github.com",
    credentialRef: "secret://github",
    idempotencyKey: "effect-1",
    ...overrides,
  };
}

describe("ToolBroker authorization", () => {
  const broker = new ToolBroker(ToolCatalog.load([contract]));

  it("normalizes, validates, and authorizes without dispatching", () => {
    const outcome = broker.authorize(intent(), context());

    expect(outcome).toMatchObject({
      outcome: "authorized",
      intent: {
        toolId: "github.issue.label",
        toolVersion: "1.0.0",
        destination: "github.com",
        credentialRef: "secret://github",
      },
      risk: { level: "medium" },
      guardrailRevision: "guardrail-v3",
    });
    expect(outcome.intentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds target, destination, and Credential reference into the stable digest", () => {
    const original = broker.authorize(intent(), context());
    const changedTarget = broker.authorize(
      intent({ targetRefs: [{ type: "issue", id: "issue-43" }] }),
      context({
        authorityLayers: authorityLayers.map((layer) => ({
          ...layer,
          grants: [{ ...grant, recordSelector: "*" }],
        })),
        guardrailRules: [{ ...guardrailRules[0], recordSelector: "*" }],
      })
    );
    const changedDestination = broker.authorize(
      intent({ destination: "github.example" }),
      context({
        authorityLayers: authorityLayers.map((layer) => ({
          ...layer,
          grants: [{ ...grant, destination: "github.example" }],
        })),
        guardrailRules: [{ ...guardrailRules[0], destination: "github.example" }],
        dlpRules: [{ dataClass: "internal", allowedDestinations: ["github.example"] }],
      })
    );
    const changedCredential = broker.authorize(
      intent({ credentialRef: "secret://github-next" }),
      context()
    );

    expect(
      new Set([
        original.intentDigest,
        changedTarget.intentDigest,
        changedDestination.intentDigest,
        changedCredential.intentDigest,
      ]).size
    ).toBe(4);
  });

  it("denies invalid input and never exposes an adapter dispatch method", () => {
    const outcome = broker.authorize(intent({ arguments: { label: 42 } }), context());

    expect(outcome).toMatchObject({ outcome: "denied", reason: "invalid_arguments" });
    expect("dispatch" in broker).toBe(false);
  });

  it.each([
    [
      "authorization",
      context({ authorityLayers: [{ name: "user", grants: [] }] }),
      "authorization_denied",
    ],
    [
      "Guardrail",
      context({ guardrailRules: [{ ...guardrailRules[0], effect: "deny" }] }),
      "guardrail_denied",
    ],
    ["DLP", context({ dlpRules: [] }), "dlp_denied"],
  ])("fails closed when %s denies", (_boundary, authContext, reason) => {
    expect(broker.authorize(intent(), authContext)).toMatchObject({
      outcome: "denied",
      reason,
    });
  });

  it("returns an Approval outcome when the Guardrail requires one", () => {
    const outcome = broker.authorize(
      intent(),
      context({ guardrailRules: [{ ...guardrailRules[0], effect: "require_approval" }] })
    );

    expect(outcome).toMatchObject({
      outcome: "awaiting_approval",
      guardrailRevision: "guardrail-v3",
    });
  });
});
