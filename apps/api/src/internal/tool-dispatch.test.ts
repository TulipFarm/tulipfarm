import type { AccessGrant, AuthorityLayer } from "@tulipfarm/authz";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import { RUN_EXECUTOR_PRINCIPAL_REF, requestArtifactId } from "@tulipfarm/run-kernel";
import { AUTONOMY_VALUES } from "@tulipfarm/schema";
import {
  CompositeToolEntitlement,
  MemoryEffectStore,
  NOT_APPLICABLE,
} from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import type { ToolApprovalDecision, ToolApprovalService } from "../approvals/tool-approvals";
import { ToolRegistry } from "../broker/tool-adapter";
import { InMemoryPrincipalProviderTokenRepo } from "../integrations/principal-tokens";
import { DEFAULT_ASSISTANT_NAME } from "../soul/agents/platform-agents";
import { presentationContextFor } from "../surfaces/renderer-registry";
import { BUSINESS_ID, CONVERSATION_ID, RUN_ID, turn } from "../test/turn-host-fixtures";
import { defineApiTool, toToolDef } from "../tools/define";
import { err, ok, type RequestContext, type ToolDef } from "../tools/types";
import { CredentialResolver } from "./credential-mode";
import { RegistryToolDispatcher, type RegistryToolDispatcherOptions } from "./tool-dispatch";
import { agentAuthorityLayer, gateAutonomyOf, LiveToolGate } from "./tool-gate";
import type { TurnAuthority } from "./turn-host";

const AUTHORITY: TurnAuthority = {
  businessId: BUSINESS_ID,
  runId: RUN_ID,
  turn: turn(),
  subject: { kind: "user", id: "user-1" },
  source: "chat",
  bundleDigest: "bundle-digest",
};

function toolDef(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "echo",
    tier: "platform",
    mutating: false,
    description: "echoes",
    inputSchema: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: { text: { type: "string" } },
    },
    execute: async (args) => ok(args),
    ...overrides,
  };
}

function fakeArtifacts(content: unknown = {}) {
  return {
    read: vi.fn(async () => ({ content })),
  };
}

function makeDispatcher(
  tools: readonly ToolDef[],
  artifacts = fakeArtifacts(),
  approvals?: ToolApprovalService
) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return {
    registry,
    artifacts,
    dispatcher: new RegistryToolDispatcher({
      registry,
      artifacts: artifacts as unknown as ArtifactService,
      ...(approvals === undefined ? {} : { approvals }),
    }),
  };
}

const WEB_PRESENTATION_CONTEXT = presentationContextFor(
  { channel: "web", surface: "chat" },
  `conversation:${CONVERSATION_ID}`
);

function fakeApprovals(decision: ToolApprovalDecision) {
  const decide = vi.fn(async () => decision);
  return { decide, service: { decide } as unknown as ToolApprovalService };
}

describe("RegistryToolDispatcher", () => {
  it("runs the Tool as the Run's recorded subject", async () => {
    const seen: RequestContext[] = [];
    const { dispatcher, artifacts } = makeDispatcher([
      toolDef({
        execute: async (args, context) => {
          seen.push(context);
          return ok(args);
        },
      }),
    ]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toEqual({ status: "succeeded", output: { text: "hi" } });
    expect(seen).toEqual([
      {
        userId: "user-1",
        // Soul writes commit as the Run subject, not the API service principal.
        actor: { principalId: "user:user-1", name: "user-1", email: "" },
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        toolCallId: "c1",
        agentId: DEFAULT_ASSISTANT_NAME,
        autonomy: undefined,
        guardrailRevision: "none",
        presentationContext: WEB_PRESENTATION_CONTEXT,
        surfaceStore: undefined,
        surfaceActionStore: undefined,
        surfaceComponents: [],
        surfaceCatalog: expect.any(Array),
        surfaceCatalogRevision: expect.any(String),
        surfaceRendererManifest: expect.anything(),
      },
    ]);
    expect(artifacts.read).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: requestArtifactId(RUN_ID),
        reader: RUN_EXECUTOR_PRINCIPAL_REF,
      })
    );
  });

  it("denies a Tool never registered, without running it", async () => {
    const execute = vi.fn(async () => ok({}));
    const { dispatcher } = makeDispatcher([toolDef({ name: "present", execute })]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c2", name: "nope", arguments: {} })
    ).resolves.toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses arguments the Tool's schema rejects before execute sees them", async () => {
    const execute = vi.fn(async () => ok({}));
    const { dispatcher } = makeDispatcher([toolDef({ execute })]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: 7 } })
    ).resolves.toMatchObject({ status: "invalid_arguments" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("parks a gated mutating call instead of running it, once arguments are known good", async () => {
    const execute = vi.fn(async () => ok({}));
    const approvals = fakeApprovals({ status: "pending", approvalId: "approval-1" });
    const { dispatcher } = makeDispatcher(
      [toolDef({ name: "wipe", mutating: true, execute })],
      fakeArtifacts({ autonomy: "approval-required" }),
      approvals.service
    );

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "wipe", arguments: { text: "hi" } })
    ).resolves.toEqual({ status: "awaiting_approval", approvalId: "approval-1" });
    expect(execute).not.toHaveBeenCalled();
    expect(approvals.decide).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, toolName: "wipe", args: { text: "hi" } })
    );
  });

  it("runs the call the human already approved, and refuses the one they refused", async () => {
    const approved = vi.fn(async () => ok({ done: true }));
    const { dispatcher } = makeDispatcher(
      [toolDef({ name: "wipe", mutating: true, execute: approved })],
      fakeArtifacts({ autonomy: "approval-required" }),
      fakeApprovals({ status: "approved" }).service
    );
    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c2", name: "wipe", arguments: { text: "hi" } })
    ).resolves.toEqual({ status: "succeeded", output: { done: true } });
    expect(approved).toHaveBeenCalledTimes(1);

    const refused = vi.fn(async () => ok({}));
    const denied = makeDispatcher(
      [toolDef({ name: "wipe", mutating: true, execute: refused })],
      fakeArtifacts({ autonomy: "approval-required" }),
      fakeApprovals({ status: "denied", reason: "denied by operator" }).service
    );
    await expect(
      denied.dispatcher.dispatch(AUTHORITY, {
        callId: "c3",
        name: "wipe",
        arguments: { text: "hi" },
      })
    ).resolves.toEqual({ status: "denied", reason: "denied by operator" });
    expect(refused).not.toHaveBeenCalled();
  });

  it("asks nobody about a read, or about a Tool that opted out of the gate", async () => {
    const approvals = fakeApprovals({ status: "pending", approvalId: "approval-1" });
    const { dispatcher } = makeDispatcher(
      [
        toolDef({ name: "echo" }),
        toolDef({ name: "wipe", mutating: true, requiresApproval: false }),
      ],
      fakeArtifacts({ autonomy: "approval-required" }),
      approvals.service
    );

    for (const name of ["echo", "wipe"]) {
      await expect(
        dispatcher.dispatch(AUTHORITY, { callId: name, name, arguments: { text: "hi" } })
      ).resolves.toMatchObject({ status: "succeeded" });
    }
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it("asks nobody when the request did not ask to be supervised", async () => {
    const approvals = fakeApprovals({ status: "pending", approvalId: "approval-1" });
    const { dispatcher } = makeDispatcher(
      [toolDef({ name: "wipe", mutating: true })],
      fakeArtifacts({ autonomy: "full" }),
      approvals.service
    );

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "wipe", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it("hands a failure back as a result the model reads, never as a thrown turn-ender", async () => {
    const { dispatcher } = makeDispatcher([
      toolDef({
        name: "boom",
        inputSchema: { type: "object" },
        execute: async () => {
          throw new Error("secret internal detail");
        },
      }),
      toolDef({
        name: "declined",
        inputSchema: { type: "object" },
        execute: async () => err("not_found", "no such record"),
      }),
    ]);

    const raised = await dispatcher.dispatch(AUTHORITY, {
      callId: "c1",
      name: "boom",
      arguments: {},
    });
    expect(raised).toEqual({
      status: "failed",
      reason: 'tool "boom" raised an internal error',
    });

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c2", name: "declined", arguments: {} })
    ).resolves.toEqual({ status: "failed", reason: "no such record" });
  });

  it("classifies a handler's schema rejection as invalid_arguments, not a generic failure", async () => {
    // Inner validation errors spend repair budget like outer schema failures.
    const { dispatcher } = makeDispatcher([
      toolDef({
        name: "record_create",
        inputSchema: { type: "object" },
        execute: async () => err("validation_error", "must have required property 'status'"),
      }),
    ]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "record_create", arguments: {} })
    ).resolves.toEqual({
      status: "invalid_arguments",
      reason: "must have required property 'status'",
    });
  });
});

/** Only infrastructure faults retry; denied or phase-less writes get exactly one attempt. */
describe("transient fault handling", () => {
  /** Provider Tools already ran effect-plane retry; dispatcher retry duplicates writes. */
  it("never retries a provider-backed tool, whose executor owns its own retry", async () => {
    const execute = vi.fn(async () => err("unavailable", "GitHub is rate limiting this call"));
    const providerTool = toToolDef(
      defineApiTool<RequestContext>({
        name: "echo",
        tier: "platform",
        // Read-only isolates the provider retry guard from the mutating safeToRetry guard.
        mutating: false,
        description: "echoes",
        provider: "github",
        credentialMode: "service",
        inputSchema: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: { text: { type: "string" } },
        } as unknown as Record<string, unknown>,
        authorization: {
          action: "github.issue.list",
          resources: ["integration.github"],
          dataClasses: ["operational"],
        },
        handler: async () => execute(),
      }),
      (ctx) => ctx
    ) as ToolDef;
    const { dispatcher } = makeDispatcher([providerTool]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "failed" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries an infrastructure fault and returns the attempt that succeeded", async () => {
    let calls = 0;
    const execute = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? err("unavailable", "index.lock held") : ok({ text: "done" });
    });
    const { dispatcher } = makeDispatcher([toolDef({ execute })]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  /** Exhausted transient faults report machinery failure, never invalid arguments. */
  it("reports an exhausted infrastructure fault as unavailable machinery, not a bad request", async () => {
    const execute = vi.fn(async () => err("unavailable", "index.lock held"));
    const { dispatcher } = makeDispatcher([toolDef({ execute })]);

    const result = await dispatcher.dispatch(AUTHORITY, {
      callId: "c1",
      name: "echo",
      arguments: { text: "hi" },
    });
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toContain("temporarily unavailable");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("never retries a business fault, whose answer cannot change between attempts", async () => {
    const execute = vi.fn(async () => err("write_denied", "not permitted"));
    const { dispatcher } = makeDispatcher([toolDef({ execute })]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "failed" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  /** `internal_error` is catch-all; retrying it would re-run deterministic bugs. */
  it("never retries internal_error", async () => {
    const execute = vi.fn(async () => err("internal_error", "bad provider shape"));
    const { dispatcher } = makeDispatcher([toolDef({ execute })]);

    await dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  /** Mutating Tools without `safeToRetry` are never repeated, even for transient faults. */
  it("does not repeat a mutating Tool that has not declared itself safe to retry", async () => {
    const execute = vi.fn(async () => err("unavailable", "provider busy"));
    const { dispatcher } = makeDispatcher([toolDef({ mutating: true, execute })]);

    await dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  /** Throws carry no effect phase, so they are never repeated. */
  it("does not retry a Tool that threw", async () => {
    const execute = vi.fn(async () => {
      throw new Error("boom");
    });
    const { dispatcher } = makeDispatcher([toolDef({ execute })]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "failed" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("authorization gate", () => {
  const ECHO_SCHEMA = {
    type: "object",
    required: ["text"],
    additionalProperties: false,
    properties: { text: { type: "string" } },
  } as const;

  function gatedTool(execute: ToolDef["execute"]): ToolDef {
    return toToolDef(
      defineApiTool<RequestContext>({
        name: "echo",
        tier: "platform",
        mutating: false,
        description: "echoes",
        inputSchema: ECHO_SCHEMA as unknown as Record<string, unknown>,
        authorization: {
          action: "platform.kv.read",
          resources: ["platform.kv"],
          dataClasses: ["operational"],
        },
        handler: async (args) => ok(args as Record<string, unknown>),
      }),
      (ctx) => ctx
    ) as ToolDef & { execute: ToolDef["execute"] };
  }

  function layers(grants: readonly AccessGrant[]) {
    return {
      resolvePrincipalLayer: async (name: string): Promise<AuthorityLayer> => ({
        name,
        grants,
      }),
    };
  }

  function gatedDispatcher(tool: ToolDef, grants: readonly AccessGrant[]) {
    const registry = new ToolRegistry();
    registry.register(tool);
    const artifacts = fakeArtifacts();
    return new RegistryToolDispatcher({
      registry,
      artifacts: artifacts as unknown as ArtifactService,
      gate: new LiveToolGate(),
      authorityLayers: layers(grants),
    });
  }

  const ALLOW: readonly AccessGrant[] = [
    { action: "platform.kv.read", resourceType: "platform.kv", effect: "allow" },
  ];

  function throwingTool(): ToolDef {
    return toToolDef(
      defineApiTool<RequestContext>({
        name: "echo",
        tier: "platform",
        mutating: false,
        description: "echoes",
        inputSchema: ECHO_SCHEMA as unknown as Record<string, unknown>,
        authorization: {
          action: "platform.kv.read",
          resources: ["platform.kv"],
          dataClasses: ["operational"],
          // `*` is a grant wildcard and model-controlled text can trigger it.
          targets: (args) => [{ type: "platform.kv", id: (args as { text: string }).text }],
        },
        handler: async (args) => ok(args as Record<string, unknown>),
      }),
      (ctx) => ctx
    ) as ToolDef & { execute: ToolDef["execute"] };
  }

  // Wrap ToolDefinitionError so model-controlled arguments cannot 500 the turn.
  it("refuses arguments whose target derivation throws, instead of ending the turn", async () => {
    const dispatcher = gatedDispatcher(throwingTool(), ALLOW);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "*" } })
    ).resolves.toMatchObject({ status: "denied" });
  });

  // `awaiting_approval` is not permission; treating it as proceed would silently approve.
  it("parks a call the gate says needs approval, rather than running it", async () => {
    const execute = vi.fn(async () => ok({}));
    const registry = new ToolRegistry();
    registry.register(gatedTool(execute));
    const decide = vi.fn(
      async (): Promise<ToolApprovalDecision> => ({ status: "pending", approvalId: "ap-1" })
    );
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: fakeArtifacts() as unknown as ArtifactService,
      approvals: { decide } as unknown as ToolApprovalService,
      authorityLayers: layers(ALLOW),
      gate: {
        authorize: () => ({ outcome: "awaiting_approval" }),
      },
    });

    const result = await dispatcher.dispatch(AUTHORITY, {
      callId: "c1",
      name: "echo",
      arguments: { text: "hi" },
    });

    expect(result).toMatchObject({ status: "awaiting_approval", approvalId: "ap-1" });
    expect(execute).not.toHaveBeenCalled();
  });

  // No approval service means no way to ask, so running would turn pending into allowed.
  it("denies a call needing approval when no approval can be requested", async () => {
    const execute = vi.fn(async () => ok({}));
    const registry = new ToolRegistry();
    registry.register(gatedTool(execute));
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: fakeArtifacts() as unknown as ArtifactService,
      authorityLayers: layers(ALLOW),
      gate: { authorize: () => ({ outcome: "awaiting_approval" }) },
    });

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  // Thread domain context so domainless grants cannot cross into domained Resources.
  it("carries the Resource domain into the decision", async () => {
    const domained = toToolDef(
      defineApiTool<RequestContext>({
        name: "echo",
        tier: "platform",
        mutating: false,
        description: "echoes",
        inputSchema: ECHO_SCHEMA as unknown as Record<string, unknown>,
        authorization: {
          action: "platform.kv.read",
          resources: ["platform.kv"],
          dataClasses: ["operational"],
          targets: (_args, ctx) => {
            const domain = (
              ctx as { soulLoader?: { resources: Map<string, { domain?: string }> } }
            )?.soulLoader?.resources.get("kv")?.domain;
            return [{ type: "platform.kv", id: "k", ...(domain === undefined ? {} : { domain }) }];
          },
        },
        handler: async (args) => ok(args as Record<string, unknown>),
      }),
      (ctx) => ctx
    ) as ToolDef;

    const soulLoader = {
      resources: new Map([["kv", { domain: "hr" }]]),
      surfaceComponents: new Map(),
      agents: new Map(),
    };
    const dispatch = (grants: readonly AccessGrant[]) => {
      const registry = new ToolRegistry();
      registry.register(domained);
      return new RegistryToolDispatcher({
        registry,
        artifacts: fakeArtifacts() as unknown as ArtifactService,
        soulLoader: soulLoader as unknown as RegistryToolDispatcherOptions["soulLoader"],
        gate: new LiveToolGate(),
        authorityLayers: layers(grants),
      }).dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } });
    };

    // A grant naming no domain must not reach a Resource that declares one.
    await expect(dispatch(ALLOW)).resolves.toMatchObject({ status: "denied" });
    await expect(
      dispatch([
        { action: "platform.kv.read", resourceType: "platform.kv", domain: "hr", effect: "allow" },
      ])
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  // Unknown autonomy is not unconstrained; maxAutonomy rules deny without context.
  it("maps every chat autonomy value onto the risk ladder", () => {
    expect(gateAutonomyOf("manual")).toBe("answer_only");
    expect(gateAutonomyOf("supervised")).toBe("propose_actions");
    expect(gateAutonomyOf("approval-required")).toBe("propose_actions");
    expect(gateAutonomyOf("full")).toBe("execute_policy_authorized");
    for (const value of AUTONOMY_VALUES) expect(gateAutonomyOf(value)).toBeDefined();
  });

  it("runs a call every layer allows", async () => {
    const execute = vi.fn(async () => ok({}));
    const dispatcher = gatedDispatcher(gatedTool(execute), ALLOW);

    const r = await dispatcher.dispatch(AUTHORITY, {
      callId: "c1",
      name: "echo",
      arguments: { text: "hi" },
    });
    expect(r).toMatchObject({ status: "succeeded" });
  });

  // Tool availability is not authority; the gate still must deny execution.
  it("refuses a Tool the caller holds no grant for, without executing it", async () => {
    const execute = vi.fn(async () => ok({}));
    const tool = gatedTool(execute);
    const dispatcher = gatedDispatcher(tool, []);

    const result = await dispatcher.dispatch(AUTHORITY, {
      callId: "c1",
      name: "echo",
      arguments: { text: "hi" },
    });

    expect(result).toMatchObject({ status: "denied" });
    expect(tool.execute).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });

  // Different resource types must not carry grants across domains.
  it("refuses a grant written for another resource type", async () => {
    const execute = vi.fn(async () => ok({}));
    const dispatcher = gatedDispatcher(gatedTool(execute), [
      { action: "platform.kv.read", resourceType: "platform.knowledge", effect: "allow" },
    ]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  // Effective permission is layer intersection; action mismatches must still deny.
  it("refuses a grant for another action on the right resource", async () => {
    const execute = vi.fn(async () => ok({}));
    const dispatcher = gatedDispatcher(gatedTool(execute), [
      { action: "platform.kv.write", resourceType: "platform.kv", effect: "allow" },
    ]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("tells the caller what to do about a denial instead of reading as a fault", async () => {
    const dispatcher = gatedDispatcher(gatedTool(vi.fn(async () => ok({}))), []);

    const result = await dispatcher.dispatch(AUTHORITY, {
      callId: "c1",
      name: "echo",
      arguments: { text: "hi" },
    });

    if (result.status !== "denied") throw new Error("expected a denial");
    expect(result.reason).toContain("echo");
    expect(result.reason).toContain("administrator");
    expect(result.reason).toContain("do not retry");
  });

  // Missing Tool declarations deny; no contract cannot bypass the gate.
  it("refuses a registered Tool that carries no authorization contract", async () => {
    const execute = vi.fn(async () => ok({}));
    const dispatcher = gatedDispatcher(toolDef({ execute }), ALLOW);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves an ungated deployment's behaviour unchanged", async () => {
    const execute = vi.fn(async () => ok({}));
    const { dispatcher } = makeDispatcher([gatedTool(execute)]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("stops a wildcard grant reaching past what the Tool declares", () => {
    // Agent grants are compiled from Tool declarations, including domainless and `*` domains.
    const layer = agentAuthorityLayer("assistant", [gatedTool(vi.fn())]);
    expect(layer.grants).toEqual([
      { action: "platform.kv.read", resourceType: "platform.kv", effect: "allow" },
      { action: "platform.kv.read", resourceType: "platform.kv", domain: "*", effect: "allow" },
    ]);
    expect(layer.grants.some((grant) => grant.action === "*")).toBe(false);
    expect(layer.grants.some((grant) => grant.resourceType === "*")).toBe(false);
  });

  // Dynamic `record.<type>` targets must be admitted; static `record` alone denied everyone.
  it("admits a derived target type its declared resource covers, and nothing else", () => {
    const tool = gatedTool(vi.fn());
    const definition = tool.definition as NonNullable<ToolDef["definition"]>;
    const layer = agentAuthorityLayer("assistant", [tool], {
      definition,
      targetRefs: [
        { type: "platform.kv.entry", id: "k" },
        { type: "record.ticket", id: "t-1" },
      ],
    });
    const admitted = layer.grants.map((grant) => grant.resourceType);
    expect(admitted).toContain("platform.kv.entry");
    // Not covered by anything this Tool declares, so the layer refuses to vouch for it.
    expect(admitted).not.toContain("record.ticket");
  });

  // Map delivery `integration` subjects to `integration_adapter` grants or channels default-deny.
  it("authorizes a channel-sourced turn through the kind that actually carries grants", async () => {
    const resolved: string[] = [];
    const registry = new ToolRegistry();
    registry.register(gatedTool(vi.fn(async () => ok({}))));
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: fakeArtifacts() as unknown as ArtifactService,
      gate: new LiveToolGate(),
      authorityLayers: {
        resolvePrincipalLayer: async (
          name: string,
          principal: { kind: string }
        ): Promise<AuthorityLayer> => {
          resolved.push(principal.kind);
          return { name, grants: ALLOW };
        },
      },
    });

    const result = await dispatcher.dispatch(
      { ...AUTHORITY, subject: { kind: "integration", id: "slack" } },
      { callId: "c1", name: "echo", arguments: { text: "hi" } }
    );

    expect(result).toMatchObject({ status: "succeeded" });
    expect(resolved).toEqual(["integration_adapter"]);
  });

  it("refuses a subject kind the authority model does not know", async () => {
    const execute = vi.fn(async () => ok({}));
    const dispatcher = gatedDispatcher(gatedTool(execute), ALLOW);

    const result = await dispatcher.dispatch(
      { ...AUTHORITY, subject: { kind: "kiosk", id: "k-1" } },
      { callId: "c1", name: "echo", arguments: { text: "hi" } }
    );

    expect(result).toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });
});

/* L5 dispatcher tests: provider Tools must prove caller-owned credentials before execution. */
describe("provider credential and entitlement layers", () => {
  const PROVIDER_SCHEMA = {
    type: "object",
    required: ["repository"],
    additionalProperties: false,
    properties: { repository: { type: "string" } },
  } as const;

  function providerTool(execute: ToolDef["execute"], credentialMode: "service" | "user") {
    return toToolDef(
      defineApiTool<RequestContext>({
        name: "echo",
        tier: "platform",
        mutating: false,
        description: "reads",
        inputSchema: PROVIDER_SCHEMA as unknown as Record<string, unknown>,
        authorization: {
          action: "integration.github.read",
          resources: ["integration.github"],
          targets: (args) => [
            {
              type: "integration.github",
              id: `repo:${(args as { repository: string }).repository}`,
            },
          ],
          dataClasses: ["operational"],
        },
        provider: "github",
        credentialMode,
        handler: execute as never,
      }),
      (ctx) => ctx
    ) as ToolDef & { execute: ToolDef["execute"]; definition: NonNullable<ToolDef["definition"]> };
  }

  const PROVIDER_ALLOW: readonly AccessGrant[] = [
    { action: "integration.github.read", resourceType: "integration.github", effect: "allow" },
  ];

  function dispatcherWith(
    tool: ToolDef,
    extra: Partial<RegistryToolDispatcherOptions>
  ): RegistryToolDispatcher {
    const registry = new ToolRegistry();
    registry.register(tool);
    return new RegistryToolDispatcher({
      registry,
      artifacts: fakeArtifacts() as unknown as ArtifactService,
      gate: new LiveToolGate(),
      authorityLayers: {
        resolvePrincipalLayer: async (name) => ({ name, grants: PROVIDER_ALLOW }),
      },
      ...extra,
    });
  }

  const CALL = { callId: "c1", name: "echo", arguments: { repository: "acme/api" } };

  it("denies before executing when the provider says the caller has no access", async () => {
    const execute = vi.fn(async () => ok({}));
    const dispatcher = dispatcherWith(providerTool(execute, "service"), {
      entitlements: new CompositeToolEntitlement([
        {
          provider: "github",
          check: async () => ({ allowed: false, reason: "you do not have access to acme/api" }),
        },
      ]),
    });

    const result = await dispatcher.dispatch(AUTHORITY, CALL);

    expect(result).toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("denies when entitlement could not be determined, rather than reaching the provider", async () => {
    const execute = vi.fn(async () => ok({}));
    const dispatcher = dispatcherWith(providerTool(execute, "service"), {
      entitlements: new CompositeToolEntitlement([
        { provider: "github", check: async () => undefined },
      ]),
    });

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes when the provider confirms the caller's access", async () => {
    const execute = vi.fn(async () => ok({}));
    const dispatcher = dispatcherWith(providerTool(execute, "service"), {
      entitlements: new CompositeToolEntitlement([
        { provider: "github", check: async () => ({ allowed: true }) },
      ]),
    });

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "succeeded" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  /* L5 still runs for personal credentials; Tools are not trusted to honor credentialPrincipal. */
  it("still runs the entitlement check when the caller spends their own credential", async () => {
    const execute = vi.fn(async () => ok({}));
    const check = vi.fn(async () => ({ allowed: false }));
    const tokens = new InMemoryPrincipalProviderTokenRepo();
    await tokens.upsert({
      principalKind: "user",
      principalId: AUTHORITY.subject.id,
      provider: "github",
      secretKey: "k",
      refreshSecretKey: null,
      externalSubject: null,
      scopes: [],
      connectedAt: new Date(),
      updatedAt: new Date(),
      expiresAt: null,
      revokedAt: null,
    });
    const dispatcher = dispatcherWith(providerTool(execute, "user"), {
      credentials: new CredentialResolver({ tokens }),
      entitlements: new CompositeToolEntitlement([{ provider: "github", check }]),
    });

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "denied" });
    expect(check).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  /* L5 abstain may pass as `not_applicable`; missing evidence (`undefined`) denies. */
  it("lets a call through when the port abstains, but denies when it cannot determine", async () => {
    const execute = vi.fn(async () => ok({}));
    const abstain = dispatcherWith(providerTool(execute, "service"), {
      entitlements: new CompositeToolEntitlement([
        { provider: "github", check: async () => NOT_APPLICABLE },
      ]),
    });
    expect(await abstain.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "succeeded" });

    const undetermined = dispatcherWith(
      providerTool(
        vi.fn(async () => ok({})),
        "service"
      ),
      {
        entitlements: new CompositeToolEntitlement([
          { provider: "github", check: async () => undefined },
        ]),
      }
    );
    expect(await undetermined.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "denied" });
  });

  it("refuses a strict user-mode call from someone who has not connected", async () => {
    const execute = vi.fn(async () => ok({}));
    const dispatcher = dispatcherWith(providerTool(execute, "user"), {
      credentials: new CredentialResolver({ tokens: new InMemoryPrincipalProviderTokenRepo() }),
    });

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("effect ledger", () => {
  const SCHEMA = {
    type: "object",
    required: ["text"],
    additionalProperties: false,
    properties: { text: { type: "string" } },
  } as const;

  /** Real declaration keeps ledger ownership tied to production `mutating`/`provider` fields. */
  function ledgeredTool(
    handler: (args: unknown) => Promise<ReturnType<typeof ok> | ReturnType<typeof err>>,
    overrides: { readonly mutating?: boolean; readonly provider?: string } = {}
  ): ToolDef {
    const mutating = overrides.mutating ?? true;
    return toToolDef(
      defineApiTool<RequestContext>({
        name: "echo",
        tier: "platform",
        mutating,
        description: "echoes",
        inputSchema: SCHEMA as unknown as Record<string, unknown>,
        ...(overrides.provider === undefined
          ? {}
          : { provider: overrides.provider, credentialMode: "service" as const }),
        ...(mutating ? { idempotency: "reconcile" as const } : {}),
        authorization: {
          action: mutating ? "platform.kv.write" : "platform.kv.read",
          resources: ["platform.kv"],
          dataClasses: ["operational"],
        },
        handler: async (args) => handler(args),
      }),
      (ctx) => ctx
    ) as ToolDef;
  }

  function ledgerDispatcher(tool: ToolDef) {
    const registry = new ToolRegistry();
    registry.register(tool);
    const effects = new MemoryEffectStore();
    return {
      effects,
      dispatcher: new RegistryToolDispatcher({
        registry,
        artifacts: fakeArtifacts() as unknown as ArtifactService,
        effects,
      }),
    };
  }

  const CALL = { callId: "call-ledger-1", name: "echo", arguments: { text: "hi" } };

  it("reserves and confirms a mutating platform tool", async () => {
    const execute = vi.fn(async () => ok({ done: true }));
    const { dispatcher, effects } = ledgerDispatcher(ledgeredTool(execute));

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "succeeded" });

    const records = await effects.list(BUSINESS_ID);
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("confirmed");
    expect(records[0]?.intent.toolId).toBe("echo");
  });

  it("does not repeat a call the ledger has already confirmed", async () => {
    const execute = vi.fn(async () => ok({ done: true }));
    const { dispatcher, effects } = ledgerDispatcher(ledgeredTool(execute));

    await dispatcher.dispatch(AUTHORITY, CALL);
    const second = await dispatcher.dispatch(AUTHORITY, CALL);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ status: "succeeded" });
    expect(second).toMatchObject({ output: { replayed: true } });
    expect(await effects.list(BUSINESS_ID)).toHaveLength(1);
  });

  it("refuses the same call id carrying different arguments without running it", async () => {
    const execute = vi.fn(async () => ok({ done: true }));
    const { dispatcher } = ledgerDispatcher(ledgeredTool(execute));

    await dispatcher.dispatch(AUTHORITY, CALL);
    const conflicting = await dispatcher.dispatch(AUTHORITY, {
      ...CALL,
      arguments: { text: "something else" },
    });

    expect(conflicting).toMatchObject({ status: "failed" });
    expect(conflicting.status === "failed" && conflicting.reason).toContain("different arguments");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("settles a thrown mutating tool as ambiguous, not failed", async () => {
    const { dispatcher, effects } = ledgerDispatcher(
      ledgeredTool(async () => {
        throw new Error("connection reset");
      })
    );

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "failed" });

    // Throws are ambiguous effects; reconciler must inspect rather than assume failure.
    const records = await effects.list(BUSINESS_ID);
    expect(records[0]?.state).toBe("ambiguous");
  });

  it("settles a structured error as failed, because the executor ran and decided", async () => {
    const { dispatcher, effects } = ledgerDispatcher(
      ledgeredTool(async () => err("not_found", "no such key"))
    );

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "failed" });

    const records = await effects.list(BUSINESS_ID);
    expect(records[0]?.state).toBe("failed");
  });

  it("does not ledger a read-only tool", async () => {
    const { dispatcher, effects } = ledgerDispatcher(
      ledgeredTool(async (args) => ok(args as Record<string, unknown>), { mutating: false })
    );

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "succeeded" });

    expect(await effects.list(BUSINESS_ID)).toHaveLength(0);
  });

  it("does not ledger a provider-backed tool, which reserves its own effect", async () => {
    const { dispatcher, effects } = ledgerDispatcher(
      ledgeredTool(async () => ok({ done: true }), { provider: "github" })
    );

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "succeeded" });

    // Do not reserve twice for one logical write.
    expect(await effects.list(BUSINESS_ID)).toHaveLength(0);
  });

  it("runs unledgered when no store is supplied", async () => {
    const execute = vi.fn(async () => ok({ done: true }));
    const registry = new ToolRegistry();
    registry.register(ledgeredTool(execute));
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: fakeArtifacts() as unknown as ArtifactService,
    });

    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "succeeded" });
    expect(await dispatcher.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "succeeded" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
