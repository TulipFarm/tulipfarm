import type { AuthorityLayer } from "@tulipfarm/authz";
import type { ToolDispatchPlan } from "@tulipfarm/run-kernel";
import type { GuardrailDefinition, ToolContractDefinition } from "@tulipfarm/schema";
import type { BundleDefinition, RuntimeBundle } from "@tulipfarm/soul";
import {
  AdapterDispatchError,
  MemoryEffectStore,
  type ToolAdapter,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { BrokerRoutineToolPort, type RoutineToolRequest } from "./tool-port";

const BUSINESS_ID = "biz-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const STATE_KEY = "CommentIssue";

const PLAN: ToolDispatchPlan = {
  toolRef: { name: "github.issue.comment", version: "1.0.0" },
  action: "issue.comment",
  destination: "github",
  arguments: { body: "hello" },
  idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
  effectId: "22222222-2222-4222-8222-222222222222",
  logicalEffectOrdinal: 3,
};

/** The Routine's authority: it may act on the Tools it declares, and nothing here widens that. */
const AUTHORITY: readonly AuthorityLayer[] = [
  { name: "routine", grants: [{ action: "*", resourceType: "*", effect: "allow" }] },
];

function contract(overrides: Partial<ToolContractDefinition["spec"]> = {}): ToolContractDefinition {
  return {
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
      inputSchema: { type: "object", properties: { body: { type: "string" } } },
      outputSchema: { type: "object", properties: { commentId: { type: "number" } } },
      riskClass: "medium",
      mutating: true,
      dataClasses: ["source-content"],
      allowedDestinations: ["github"],
      idempotency: { strategy: "provider_key" },
      dryRun: false,
      adapter: { kind: "integration", ref: "github" },
      ...overrides,
    },
  } as ToolContractDefinition;
}

function guardrail(rules: unknown[]): GuardrailDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Guardrail",
    metadata: {
      id: "01J0000000000000000000GUAR",
      slug: "triage",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: { defaultDecision: "deny", rules },
  } as GuardrailDefinition;
}

const ALLOW_COMMENT = {
  id: "allow-comment",
  type: "allow",
  actions: ["issue.comment"],
  dataClasses: ["source-content"],
  destinations: ["github"],
};

function bundle(documents: readonly { kind: string; document: unknown }[]): RuntimeBundle {
  const definitions = documents.map((entry, index) => ({
    kind: entry.kind,
    id: `def-${index}`,
    slug: `def-${index}`,
    authoredVersion: 1,
    hash: "b".repeat(64),
    document: entry.document,
    references: [],
  })) as unknown as readonly BundleDefinition[];

  return {
    digest: "c".repeat(64),
    businessId: BUSINESS_ID,
    changesetId: "changeset-1",
    commitSha: "d".repeat(40),
    definitions,
    get: (kind, slug) => definitions.find((d) => d.kind === kind && d.slug === slug),
    getById: (id) => definitions.find((d) => d.id === id),
  };
}

function request(overrides: Partial<RoutineToolRequest> = {}): RoutineToolRequest {
  return {
    businessId: BUSINESS_ID,
    runId: RUN_ID,
    stateKey: STATE_KEY,
    plan: PLAN,
    bundle: bundle([
      { kind: "ToolContract", document: contract() },
      { kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) },
    ]),
    authorityLayers: AUTHORITY,
    ...overrides,
  };
}

let effects: MemoryEffectStore;
let dispatch: Mock<ToolAdapter["dispatch"]>;
let adapters: Map<string, ToolAdapter>;

beforeEach(() => {
  effects = new MemoryEffectStore();
  dispatch = vi.fn<ToolAdapter["dispatch"]>(async (_request: ToolAdapterRequest) => ({
    commentId: 12,
  }));
  adapters = new Map<string, ToolAdapter>([["github", { dispatch }]]);
});

function port(): BrokerRoutineToolPort {
  return new BrokerRoutineToolPort({ effects, adapters });
}

describe("BrokerRoutineToolPort", () => {
  it("authorizes against the Run's pinned policy, reserves the effect, then dispatches", async () => {
    expect(await port().execute(request())).toEqual({ kind: "succeeded" });

    const effect = await effects.get(BUSINESS_ID, PLAN.effectId);
    expect(effect?.state).toBe("confirmed");
    expect(effect?.runId).toBe(RUN_ID);
    expect(effect?.stateId).toBe(STATE_KEY);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("records the pinned bundle digest as the guardrail revision the effect was decided under", async () => {
    const input = request();
    await port().execute(input);

    const effect = await effects.get(BUSINESS_ID, PLAN.effectId);
    expect(effect?.guardrailRevision).toBe(input.bundle.digest);
  });

  it("never reaches an adapter when policy denies the intent", async () => {
    const denied = request({
      bundle: bundle([
        { kind: "ToolContract", document: contract() },
        { kind: "Guardrail", document: guardrail([{ ...ALLOW_COMMENT, type: "deny" }]) },
      ]),
    });

    expect(await port().execute(denied)).toEqual({ kind: "failed", reason: "guardrail_denied" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toBeUndefined();
  });

  it("denies when the Run carries no authority, rather than reading absence as permission", async () => {
    expect(await port().execute(request({ authorityLayers: [] }))).toEqual({
      kind: "failed",
      reason: "authorization_denied",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("parks an intent policy sends to a human, because no Approval is composed here yet", async () => {
    const gated = request({
      bundle: bundle([
        { kind: "ToolContract", document: contract() },
        {
          kind: "Guardrail",
          document: guardrail([
            ALLOW_COMMENT,
            {
              id: "approve-comment",
              type: "approval",
              actions: ["issue.comment"],
              category: "highRiskAction",
              minimumApprovers: 1,
              separationOfDuties: false,
            },
          ]),
        },
      ]),
    });

    expect(await port().execute(gated)).toEqual({
      kind: "awaiting_approval",
      reason: "approval_required",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("replays a confirmed effect instead of dispatching it a second time", async () => {
    const subject = port();
    await subject.execute(request());

    expect(await subject.execute(request())).toEqual({ kind: "succeeded" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("parks an ambiguous effect, which only reconciliation may resolve", async () => {
    dispatch.mockRejectedValue(
      new AdapterDispatchError("after_dispatch", "provider_timeout", false)
    );

    expect(await port().execute(request())).toEqual({
      kind: "unavailable",
      reason: "effect_ambiguous",
    });
    expect((await effects.get(BUSINESS_ID, PLAN.effectId))?.state).toBe("ambiguous");
  });

  it("parks when no adapter is registered for the contract's provider", async () => {
    adapters = new Map();

    expect(await port().execute(request())).toEqual({
      kind: "unavailable",
      reason: "adapter_not_found",
    });
  });

  it("parks when the pinned bundle names no contract for the Tool the State references", async () => {
    const missing = request({
      bundle: bundle([{ kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) }]),
    });

    expect(await port().execute(missing)).toEqual({
      kind: "failed",
      reason: "unknown_contract",
    });
  });

  it("parks a Guardrail this deployment cannot express exactly, rather than dropping the rule", async () => {
    const unsupported = request({
      bundle: bundle([
        { kind: "ToolContract", document: contract() },
        {
          kind: "Guardrail",
          document: guardrail([{ ...ALLOW_COMMENT, constraints: { maxBytes: 1024 } }]),
        },
      ]),
    });

    expect(await port().execute(unsupported)).toEqual({
      kind: "unavailable",
      reason: "guardrail_unsupported_constraint",
    });
  });

  it("refuses a destination the contract does not allow", async () => {
    const elsewhere = request({ plan: { ...PLAN, destination: "slack" } });

    expect(await port().execute(elsewhere)).toEqual({
      kind: "failed",
      reason: "destination_denied",
    });
  });

  it("refuses arguments the contract's input schema rejects", async () => {
    const malformed = request({ plan: { ...PLAN, arguments: { body: 12 } } });

    expect(await port().execute(malformed)).toEqual({
      kind: "failed",
      reason: "invalid_arguments",
    });
  });
});
