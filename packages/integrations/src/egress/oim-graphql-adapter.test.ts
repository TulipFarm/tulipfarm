import type { OimManifest, ToolContractDefinition } from "@tulipfarm/schema";
import {
  EffectDispatcher,
  EffectLedger,
  MemoryEffectStore,
  type ToolAdapterRequest,
  ToolCatalog,
  ToolDispatchError,
} from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import type { OimHookPhaseRunner } from "../oim-hooks";
import type { GraphqlOperationBinding } from "./graphql-compile";
import { OimGraphqlToolAdapter } from "./oim-graphql-adapter";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  constructor(private readonly response: IntegrationHttpResponse) {}

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    this.sent.push(request);
    return this.response;
  }
}

const BINDING: GraphqlOperationBinding = {
  url: "https://api.example.com/graphql",
  operation: "ReadIssue",
  document: "query ReadIssue($id: String!) { issue(id: $id) { id } }",
  mutating: false,
  headers: {},
};

const MANIFEST = {
  oimVersion: "1.0",
  metadata: {
    id: "linear",
    name: "Linear",
    description: "Linear provider",
    version: "1.0.0",
  },
  hooks: [
    {
      kind: "response_normalize",
      file: "hooks/normalize.js",
      export: "normalize",
    },
  ],
} as unknown as OimManifest;

function request(): ToolAdapterRequest {
  return {
    intent: {
      intentId: "intent-1",
      businessId: "business-1",
      runId: "run-1",
      stateId: "state-1",
      toolId: "graphql.linear.read_issue",
      toolVersion: "1.0.0",
      action: "linear.read_issue",
      targetRefs: [],
      arguments: { id: "issue-1" },
      idempotencyKey: "effect-1",
    },
    idempotencyKey: "effect-1",
    attempt: 1,
  };
}

describe("OimGraphqlToolAdapter", () => {
  it("redacts before the response Hook and projects the Hook output", async () => {
    const run = vi.fn<OimHookPhaseRunner["run"]>(async (_hook, input) => {
      expect(input).toEqual({
        payload: {
          data: {
            issue: {
              access_token: "[redacted]",
              title: "Before",
            },
          },
        },
        safeHeaders: {},
      });
      return { data: { issue: { title: "After" } } };
    });
    const adapter = new OimGraphqlToolAdapter({
      binding: BINDING,
      http: new RecordingHttp({
        status: 200,
        headers: { "set-cookie": "secret=1" },
        body: {
          data: {
            issue: {
              access_token: "secret",
              title: "Before",
            },
          },
        },
      }),
      manifest: MANIFEST,
      hookRunner: { run },
      projection: ["/data/issue/title"],
    });

    await expect(adapter.dispatch(request())).resolves.toEqual({
      data: { issue: { title: "After" } },
    });
  });

  it("fails after dispatch when a response Hook is declared without a trusted runner", async () => {
    const adapter = new OimGraphqlToolAdapter({
      binding: BINDING,
      http: new RecordingHttp({ status: 200, headers: {}, body: { data: {} } }),
      manifest: MANIFEST,
    });

    await expect(adapter.dispatch(request())).rejects.toMatchObject({
      phase: "after_dispatch",
      code: "response_normalize_hook_failed",
      retryable: false,
    });
  });

  it("leaves a mutation with GraphQL errors ambiguous without replaying it", async () => {
    const businessId = "business-1";
    const effectId = "22222222-2222-4222-8222-222222222222";
    const http = new RecordingHttp({
      status: 200,
      headers: {},
      body: {
        data: { createIssue: { id: "issue-1" } },
        errors: [{ message: "resolver failed after creating the issue" }],
      },
    });
    const adapter = new OimGraphqlToolAdapter({
      binding: {
        ...BINDING,
        operation: "CreateIssue",
        document: "mutation CreateIssue { createIssue { id } }",
        mutating: true,
      },
      http,
      manifest: MANIFEST,
    });
    const definition: ToolContractDefinition = {
      apiVersion: "tulipfarm.ai/v1",
      kind: "ToolContract",
      metadata: {
        id: "33333333-3333-4333-8333-333333333333",
        slug: "linear-create-issue",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "active",
        publishedDigest: "a".repeat(64),
      },
      spec: {
        toolId: "graphql.linear.create_issue",
        toolVersion: "1.0.0",
        action: "linear.create_issue",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          required: ["data"],
          properties: { data: { type: "object" } },
        },
        riskClass: "high",
        mutating: true,
        dataClasses: ["internal"],
        allowedDestinations: ["api.example.com"],
        idempotency: { strategy: "provider" },
        retry: { maxAttempts: 3, safeToRetry: true },
        dryRun: false,
        adapter: { kind: "graphql", ref: "linear" },
      },
    };
    const store = new MemoryEffectStore();
    const reserve = vi.spyOn(store, "reserve");
    await new EffectLedger(store).reserve({
      effectId,
      businessId,
      runId: "11111111-1111-4111-8111-111111111111",
      stateId: "create-issue",
      logicalEffectOrdinal: 1,
      idempotencyKey: "stable-effect-key",
      intentDigest: "b".repeat(64),
      intent: {
        intentId: "intent-1",
        businessId,
        runId: "11111111-1111-4111-8111-111111111111",
        stateId: "create-issue",
        toolId: "graphql.linear.create_issue",
        toolVersion: "1.0.0",
        action: "linear.create_issue",
        targetRefs: [],
        arguments: { title: "Investigate" },
        destination: "api.example.com",
        idempotencyKey: "stable-effect-key",
      },
      guardrailRevision: "guardrail-v1",
      createdAt: "2026-09-07T00:00:00.000Z",
    });
    const parkRetry = vi.fn(async () => ({ waitId: "must-not-park" }));
    const dispatcher = new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([["linear", adapter]]),
      mutationGuard: { assertAllowed: async () => undefined },
      parkRetry,
      now: () => "2026-09-07T00:00:01.000Z",
    });

    await expect(dispatcher.dispatch(businessId, effectId)).rejects.toEqual(
      new ToolDispatchError("ambiguous", effectId)
    );
    await expect(dispatcher.dispatch(businessId, effectId)).rejects.toMatchObject({
      code: "effect_state_conflict",
    });

    expect(http.sent).toHaveLength(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(parkRetry).not.toHaveBeenCalled();
    expect(await store.get(businessId, effectId)).toMatchObject({ state: "ambiguous" });
    const attempts = await store.listAttempts(businessId, effectId);
    expect(attempts).toEqual([
      expect.objectContaining({ state: "ambiguous", errorCode: "provider_rejected" }),
    ]);
    expect(attempts[0]?.outputDigest).toBeUndefined();
  });
});
