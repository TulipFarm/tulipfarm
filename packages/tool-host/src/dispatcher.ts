import type { AuthorityLayer } from "@tulipfarm/authz";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import { ajv } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import { getDefaultAssistant, resolveAgent } from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import {
  type CompositeToolEntitlement,
  type EffectStore,
  NOT_APPLICABLE,
  retryDelayMs,
  type ToolAuthorizationDenialReason,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import type {
  HostedToolCall,
  HostedToolResult,
  TurnAuthority,
  TurnToolDispatcher,
} from "./authority";
import { availableToolsFor, type ToolCatalog } from "./catalog";
import type { CredentialResolution, CredentialResolver } from "./credential-mode";
import { ChatEffectLedger, ledgerOwnsCall } from "./effect-ledger";
import { localDispatchRefusal } from "./eligibility";
import { gateAutonomyOf, type ToolGate } from "./gate";
import type {
  AgentResolver,
  ChannelDeliveryReader,
  GuardrailRevisionSource,
  HostedAgent,
  SurfacePresentationPort,
  ToolApprovalPort,
  ToolVisibilityPort,
} from "./ports";
import { type AuthorityPrincipal, principalKindOf } from "./principal";
import { presentationContextForAuthority, readChatRequest } from "./request";
import type { SurfaceActionStore, SurfaceArtifactStore } from "./surface-ports";
import type { RequestContext, ToolDef, ToolErrorCode } from "./types";
import { isInfrastructureFault } from "./types";

/** Default infra-fault retries without a ledger: one retry, then stop to avoid duplicate writes. */
const DEFAULT_TRANSIENT_ATTEMPTS = 2;

/**
 * Used when no `AgentResolver` was composed. It carries no `toolAllowlist`, which means the whole
 * catalog is offered — safe only because the catalog itself is the composition's allowlist.
 */
const DEFAULT_AGENT: HostedAgent = { name: "assistant" };

/** Executes one Tool call: allowlist, schema, gate, and context all come from the recorded Run. */

export interface RegistryToolDispatcherOptions {
  readonly registry: ToolCatalog;
  readonly artifacts: ArtifactService;
  readonly soulLoader?: SoulLoader;
  readonly approvals?: ToolApprovalPort;
  readonly channelDeliveries?: ChannelDeliveryReader;
  /** Renderer registry. Absent means this process can present nothing; see `SurfacePresentationPort`. */
  readonly surfaces?: SurfacePresentationPort;
  readonly surfaceStore?: SurfaceArtifactStore;
  readonly surfaceActionStore?: SurfaceActionStore;
  readonly guardrails?: GuardrailRevisionSource;
  /** Live per-turn Tool suppression that no declaration can express. */
  readonly visibility?: ToolVisibilityPort;
  /** Resolves the Agent a request names; absent collapses every request to one anonymous Agent. */
  readonly agents?: AgentResolver;
  readonly gate?: ToolGate;
  /** Required whenever `gate` is set. */
  readonly authorityLayers?: {
    resolvePrincipalLayer(name: string, principal: AuthorityPrincipal): Promise<AuthorityLayer>;
  };
  readonly credentials?: CredentialResolver;
  /** Authority layer L5 (D7); absence preserves pre-D7 bot reach. */
  readonly entitlements?: CompositeToolEntitlement;
  /** Effect ledger for mutating Tools; production deployments with a database should supply it. */
  readonly effects?: EffectStore;
  /**
   * Set by a process that composed this host without the control plane's ambient capabilities —
   * the durable runtime. Every call is then re-checked against `localDispatchRefusal`, so a Tool
   * that slipped into the local catalog is refused rather than authorized on thinner evidence.
   */
  readonly localDispatchOnly?: boolean;
  now?(): Date;
}

type AuthorizeVerdict =
  | { readonly decision: "proceed" }
  | { readonly decision: "approval" }
  | { readonly decision: "denied"; readonly result: HostedToolResult };

/** Worker approvals mirror the web path: mutating, `approval-required`, and not opted out. */
function needsApproval(definition: ToolDef, autonomy: string | undefined): boolean {
  return (
    autonomy === "approval-required" && definition.mutating && definition.requiresApproval !== false
  );
}

/**
 * Spends the one-use approval this dispatch is about to act on. Fails closed: a decision that
 * cannot be spent is not a decision this call may run under.
 */
async function spendApproval(
  approvals: ToolApprovalPort,
  approvalId: string,
  callId: string
): Promise<boolean> {
  try {
    return await approvals.consume({ approvalId, toolCallId: callId });
  } catch {
    // Consumption state that cannot be read is ambiguous, and an ambiguous approval is a refusal:
    // running here would be the exact silent reuse the one-use rule exists to stop.
    return false;
  }
}

export class RegistryToolDispatcher implements TurnToolDispatcher {
  private readonly now: () => Date;

  constructor(private readonly options: RegistryToolDispatcherOptions) {
    this.now = options.now ?? (() => new Date());
    // `authorize` treats an unwired gate as "proceed", which is only tolerable where the caller
    // authorized the request already. A process hosting Tools outside the control plane has no
    // such caller, so co-located dispatch refuses to exist without both halves of the gate.
    if (options.localDispatchOnly === true && (!options.gate || !options.authorityLayers)) {
      throw new Error("local Tool dispatch requires both a ToolGate and an authority layer source");
    }
  }

  /** Missing Tool authorization contracts deny rather than pass. */
  private async authorize(
    authority: TurnAuthority,
    agentId: string,
    tool: ToolDef,
    available: readonly ToolDef[],
    call: HostedToolCall,
    autonomy: string | undefined
  ): Promise<AuthorizeVerdict> {
    const { gate, authorityLayers } = this.options;
    if (gate === undefined || authorityLayers === undefined) return { decision: "proceed" };
    if (tool.definition === undefined) {
      return {
        decision: "denied",
        result: {
          status: "denied",
          reason: `tool "${call.name}" carries no authorization contract`,
        },
      };
    }

    // Always include every layer; omitting one is strictly more permissive.
    const kind = principalKindOf(authority.subject.kind);
    if (kind === undefined) {
      return {
        decision: "denied",
        result: { status: "denied", reason: `tool "${call.name}" has no principal to authorize` },
      };
    }

    const caller = await authorityLayers.resolvePrincipalLayer(kind, {
      id: authority.subject.id,
      businessId: authority.businessId,
      kind,
    });
    const outcome = gate.authorize({
      definition: tool.definition,
      arguments: call.arguments,
      businessId: authority.businessId,
      runId: authority.runId,
      stateId: call.callId,
      authorityLayers: [caller],
      agent: { name: agentId, available },
      // Carries Resource domains; without it domain-scoped grants collapse.
      ...(this.options.soulLoader === undefined
        ? {}
        : { context: { soulLoader: this.options.soulLoader } }),
      guardrailRevision: this.options.guardrails?.revision ?? "none",
      ...(gateAutonomyOf(autonomy) === undefined ? {} : { autonomy: gateAutonomyOf(autonomy) }),
    });

    if (outcome.outcome === "authorized") return { decision: "proceed" };
    // Policy-level approval is not a pass; it must park even outside `approval-required`.
    if (outcome.outcome === "awaiting_approval") return { decision: "approval" };
    return {
      decision: "denied",
      result: { status: "denied", reason: denialReason(call.name, outcome.reason) },
    };
  }

  /** Retry only infrastructure faults with budget; mutating Tools need explicit `safeToRetry`. */
  private mayRetryFault(tool: ToolDef, code: ToolErrorCode, attempt: number): boolean {
    if (!isInfrastructureFault(code)) return false;
    // Provider Tools already spent their ledger retry budget; do not start a second effect.
    if (tool.definition?.provider !== undefined) return false;
    const policy = tool.definition?.retry;
    if (attempt >= Math.max(1, policy?.maxAttempts ?? DEFAULT_TRANSIENT_ATTEMPTS)) return false;
    // Without a phase, landed-then-failed is indistinguishable from never-landed.
    return !tool.mutating || policy?.safeToRetry === true;
  }

  private async wait(delayMs: number): Promise<void> {
    if (delayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /** Provider entitlement checks run for human calls, even with personal credentials. */
  private async entitlementDenial(
    authority: TurnAuthority,
    tool: ToolDef,
    call: HostedToolCall
  ): Promise<string | undefined> {
    const { entitlements } = this.options;
    const provider = tool.definition?.provider;
    if (entitlements === undefined || tool.definition === undefined || provider === undefined) {
      return undefined;
    }
    if (!entitlements.covers(provider)) return undefined;

    // Use the Tool's own derivation so gate and entitlement targets match.
    let targetRefs: readonly ToolTargetRef[];
    try {
      targetRefs = tool.definition.targetsFor(
        call.arguments,
        this.options.soulLoader === undefined ? undefined : { soulLoader: this.options.soulLoader }
      );
    } catch {
      // A target resolver that throws yields a human-readable access-check failure reason.
      return `"${call.name}" could not be resolved to something to check access against`;
    }

    // Match gate normalization; unknown subjects deny because this may be the only layer.
    const kind = principalKindOf(authority.subject.kind);
    if (kind === undefined) {
      return `"${call.name}" was called by a subject this deployment cannot authorize`;
    }

    const verdict = await entitlements.check({
      businessId: authority.businessId,
      principal: { kind, id: authority.subject.id },
      provider,
      action: tool.definition.authorization.action,
      targetRefs,
    });
    if (verdict === NOT_APPLICABLE) return undefined;
    if (verdict === undefined) {
      // Fail closed: an unreachable provider must not become an open door.
      return `could not confirm your access on ${provider}, so this call was not made — try again shortly`;
    }
    return verdict.allowed ? undefined : (verdict.reason ?? `denied by ${provider}`);
  }

  /** Ledger target derivation failures become empty audit annotations, not refused writes. */
  private ledgerTargets(tool: ToolDef, call: HostedToolCall): readonly ToolTargetRef[] {
    if (tool.definition === undefined) return [];
    try {
      return tool.definition.targetsFor(
        call.arguments,
        this.options.soulLoader === undefined ? undefined : { soulLoader: this.options.soulLoader }
      );
    } catch {
      // A target resolver that throws contributes no targets to gate against.
      return [];
    }
  }

  private async resolveCredential(
    authority: TurnAuthority,
    tool: ToolDef
  ): Promise<CredentialResolution> {
    const { credentials } = this.options;
    if (credentials === undefined || tool.definition === undefined) return { use: "service" };
    return await credentials.resolve(
      { kind: authority.subject.kind, id: authority.subject.id },
      {
        name: tool.name,
        credentialMode: tool.definition.credentialMode,
        ...(tool.definition.provider === undefined ? {} : { provider: tool.definition.provider }),
      }
    );
  }

  async dispatch(authority: TurnAuthority, call: HostedToolCall): Promise<HostedToolResult> {
    const request = await readChatRequest(this.options.artifacts, authority, this.now());
    const agent = this.options.agents?.resolve(request.agentId) ?? DEFAULT_AGENT;
    const presentationContext = await presentationContextForAuthority(
      authority,
      this.options.surfaces,
      this.options.channelDeliveries
    );
    const excludedTools = await this.options.visibility?.excludedToolNames(authority.businessId);
    const allowed = new Set(
      availableToolsFor(this.options.registry, agent, presentationContext, excludedTools).map(
        (tool) => tool.name
      )
    );
    // Use registered Tools, not summaries; authority compiles from definitions.
    const availableTools = this.options.registry
      .getAll()
      .filter((tool: ToolDef) => allowed.has(tool.name));
    const definition = this.options.registry
      .getAll()
      .find((tool: ToolDef) => tool.name === call.name);
    if (definition === undefined || !allowed.has(definition.name)) {
      return { status: "denied", reason: `tool "${call.name}" is not available to this turn` };
    }

    // Re-check co-location admission at dispatch, not only at composition: a Tool this process
    // cannot fully authorize must be refused here rather than pass a thinner gate.
    if (this.options.localDispatchOnly === true) {
      const refusal = localDispatchRefusal(definition.definition);
      if (refusal !== undefined) {
        return {
          status: "denied",
          reason: `tool "${call.name}" cannot be executed by this process (${refusal})`,
        };
      }
    }

    const validate = ajv.compile(definition.inputSchema);
    if (!validate(call.arguments)) {
      return { status: "invalid_arguments", reason: argumentErrors(validate) };
    }

    // Decide authority before approval; forbidden calls must not reach humans as choices.
    const verdict = await this.authorize(
      authority,
      agent.name,
      definition,
      availableTools,
      call,
      request.autonomy
    );
    if (verdict.decision === "denied") return verdict.result;

    // Resolve credentials before approval; do not ask humans to approve calls that cannot run.
    const credential = await this.resolveCredential(authority, definition);
    if (credential.use === "denied") {
      return { status: "denied", reason: credential.reason };
    }

    const denial = await this.entitlementDenial(authority, definition, call);
    if (denial !== undefined) return { status: "denied", reason: denial };

    // Ask after validation and before `execute`, so no invalid call or effect reaches approval.
    const approvalRequired =
      verdict.decision === "approval" || needsApproval(definition, request.autonomy);
    if (approvalRequired && this.options.approvals === undefined) {
      // Missing approval plumbing must deny, not convert "not yet" into "yes".
      return {
        status: "denied",
        reason: `tool "${call.name}" requires an approval this deployment cannot request`,
      };
    }
    if (this.options.approvals && approvalRequired) {
      const decision = await this.options.approvals.decide({
        businessId: authority.businessId,
        runId: authority.runId,
        toolCallId: call.callId,
        toolName: definition.name,
        args: call.arguments,
      });
      if (decision.status === "pending") {
        return { status: "awaiting_approval", approvalId: decision.approvalId };
      }
      if (decision.status === "denied") {
        return { status: "denied", reason: decision.reason };
      }
      // One-use (I-13): spend the decision here, at the dispatch that will execute it, not at the
      // lookup. A parked call left with `awaiting_approval` above and spent nothing, so the Turn
      // that resumes still finds its decision; the *next* identical call in this Run finds none
      // and asks a human again instead of riding the approval this one was given.
      if (!(await spendApproval(this.options.approvals, decision.approvalId, call.callId))) {
        return {
          status: "denied",
          reason:
            `the approval for tool "${call.name}" was already used by another call; ` +
            "this one needs its own approval",
        };
      }
    }

    const surfaceComponents = [...(this.options.soulLoader?.surfaceComponents.values() ?? [])];
    const { surfaces } = this.options;
    // A process with no renderer registry resolved no presentation above, so there is no target to
    // build a catalog for; the Tool sees no surface fields rather than a fabricated empty catalog.
    const surfaceFields =
      surfaces !== undefined && presentationContext !== undefined
        ? {
            presentationContext,
            surfaceCatalog: surfaces.catalogFor(presentationContext.target, surfaceComponents),
            surfaceCatalogRevision: surfaces.catalogRevisionFor(
              presentationContext.target,
              surfaceComponents
            ),
            surfaceRendererManifest: surfaces.manifestFor(presentationContext.target),
          }
        : {};
    const context: RequestContext = {
      userId: authority.subject.id,
      actor: {
        principalId: `${authority.subject.kind}:${authority.subject.id}`,
        name: authority.subject.id,
        email: "",
      },
      conversationId: authority.turn.conversationId,
      runId: authority.runId,
      toolCallId: call.callId,
      agentId: agent.name,
      autonomy: request.autonomy as RequestContext["autonomy"],
      guardrailRevision: this.options.guardrails?.revision ?? "none",
      surfaceStore: this.options.surfaceStore,
      surfaceActionStore: this.options.surfaceActionStore,
      surfaceComponents,
      ...surfaceFields,
      ...(credential.use === "principal" ? { credentialPrincipal: credential.principal } : {}),
    };
    // Reserve only after refusals and approval; denied calls leave no effect row.
    const ledger =
      this.options.effects && ledgerOwnsCall(definition.definition)
        ? new ChatEffectLedger(this.options.effects)
        : undefined;
    let reservation: { readonly effectId: string; readonly attempt: number } | undefined;
    if (ledger && definition.definition) {
      const reserved = await ledger.reserve({
        businessId: authority.businessId,
        runId: authority.runId,
        callId: call.callId,
        toolId: definition.name,
        toolVersion: definition.definition.version,
        action: definition.definition.authorization.action,
        arguments: call.arguments,
        targetRefs: this.ledgerTargets(definition, call),
        guardrailRevision: this.options.guardrails?.revision ?? "none",
      });
      if (reserved.outcome === "duplicate") return replayedEffect(call.name, reserved.state);
      if (reserved.outcome === "conflict") {
        return {
          status: "failed",
          reason:
            `tool "${call.name}" was already called with this id and different arguments; ` +
            "the earlier call stands",
        };
      }
      reservation = {
        effectId: reserved.effectId,
        attempt: await ledger.beginAttempt(authority.businessId, reserved.effectId),
      };
    }

    let result: Awaited<ReturnType<ToolDef["execute"]>>;
    for (let attempt = 1; ; attempt += 1) {
      try {
        result = await definition.execute(call.arguments, context);
      } catch {
        // Throws are unknown phase: never retry, and settle ledgered writes as `ambiguous`.
        if (ledger && reservation) {
          await ledger.finishAttempt(
            authority.businessId,
            reservation.effectId,
            reservation.attempt,
            {
              state: "ambiguous",
              errorCode: "tool_raised",
            }
          );
        }
        return { status: "failed", reason: `tool "${call.name}" raised an internal error` };
      }
      if (result.success) {
        if (ledger && reservation) {
          await ledger.finishAttempt(
            authority.businessId,
            reservation.effectId,
            reservation.attempt,
            { state: "confirmed" }
          );
        }
        return { status: "succeeded", output: result.data };
      }
      if (!this.mayRetryFault(definition, result.error.code, attempt)) break;
      await this.wait(retryDelayMs(attempt));
    }
    // Structured errors have a known phase; there is nothing to reconcile.
    if (ledger && reservation) {
      await ledger.finishAttempt(authority.businessId, reservation.effectId, reservation.attempt, {
        state: "failed",
        errorCode: result.error.code,
      });
    }
    // Schema-shaped rejections count against the model repair budget.
    if (result.error.code === "validation_error") {
      return { status: "invalid_arguments", reason: result.error.message };
    }
    // Exhausted infra faults are machinery failures, not repairable argument failures.
    return isInfrastructureFault(result.error.code)
      ? { status: "failed", reason: `tool "${call.name}" is temporarily unavailable; try again` }
      : { status: "failed", reason: result.error.message };
  }
}

/** Confirmed ledger replays report success; unsettled states fail without repeating the call. */
function replayedEffect(toolName: string, state: string): HostedToolResult {
  switch (state) {
    case "confirmed":
      return {
        status: "succeeded",
        output: { replayed: true, note: "This action already completed; it was not repeated." },
      };
    case "failed":
      return { status: "failed", reason: `tool "${toolName}" already ran and failed` };
    default:
      return {
        status: "failed",
        reason: `tool "${toolName}" is already in progress or awaiting reconciliation (${state})`,
      };
  }
}

function argumentErrors(validate: ReturnType<typeof ajv.compile>): string {
  const messages = new Set(
    (validate.errors ?? []).map((error) =>
      `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`.trim()
    )
  );
  return [...messages].slice(0, 8).join("; ") || "invalid arguments";
}

/** Gate denials name the Tool and actionable reason so the model does not blindly retry. */
function denialReason(toolName: string, reason: ToolAuthorizationDenialReason): string {
  switch (reason) {
    case "authorization_denied":
      return `you are not authorized to use "${toolName}" here — ask an administrator for access to it, and do not retry this call`;
    case "guardrail_denied":
      return `a guardrail refused "${toolName}" for this turn — do not retry this call`;
    case "dlp_denied":
      return `"${toolName}" would move data somewhere this turn may not send it — do not retry this call`;
    case "destination_denied":
      return `"${toolName}" may not deliver to the destination requested — do not retry this call`;
    case "missing_guardrail_revision":
      // Policy was not loaded, so this is not an authority decision about the caller.
      return `"${toolName}" cannot run because this deployment's policy revision is unknown`;
  }
}
