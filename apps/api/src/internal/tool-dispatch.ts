import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import type { AuthorityLayer } from "@tulipfarm/authz";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import { ajv } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import {
  type CompositeToolEntitlement,
  type EffectStore,
  NOT_APPLICABLE,
  retryDelayMs,
  type ToolAuthorizationDenialReason,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import type { ToolApprovalService } from "../approvals/tool-approvals";
import type { ToolRegistry } from "../broker/tool-adapter";
import { availableToolsFor } from "../chat/turn-helpers";
import type { AuthorityPrincipal } from "../identity/authority-layers";
import { getDefaultAssistant, resolveAgent } from "../soul/agents/registry";
import type { SurfaceActionStore } from "../surfaces/action-store";
import type { SurfaceArtifactStore } from "../surfaces/artifact-store";
import {
  surfaceCatalogFor,
  surfaceCatalogRevisionFor,
  surfaceRendererRegistry,
} from "../surfaces/renderer-registry";
import { githubExcludedToolNames } from "../tools/github/visibility";
import type { RequestContext, ToolDef, ToolErrorCode } from "../tools/types";
import { isInfrastructureFault } from "../tools/types";
import type { CredentialResolution, CredentialResolver } from "./credential-mode";
import { ChatEffectLedger, ledgerOwnsCall } from "./effect-ledger";
import { gateAutonomyOf, type ToolGate } from "./tool-gate";
import {
  type ChannelDeliveryReader,
  presentationContextForAuthority,
  readChatRequest,
} from "./turn-context";
import type {
  HostedToolCall,
  HostedToolResult,
  TurnAuthority,
  TurnToolDispatcher,
} from "./turn-host";

/**
 * Attempts an infrastructure fault gets when the Tool declares no policy of its own. Two,
 * not more: this path has no ledger, so every extra attempt is another chance to re-apply a
 * write whose phase nobody recorded, and contention that survives one short backoff is
 * usually queued behind something that will outlast a third try too.
 */
const DEFAULT_TRANSIENT_ATTEMPTS = 2;

/**
 * Executes one Tool call on a Run's behalf (plan §3).
 *
 * Two refusals happen before anything runs, in this order, because either alone would be a hole:
 * a Tool outside the Agent's allowlist is **denied** even though it exists, and arguments that do
 * not satisfy the Tool's schema are refused before `execute` sees them. Both come back as a result
 * the model reads, never as an exception — a denial the model can see is a denial it can work
 * around honestly, whereas a thrown error would end the turn with nothing to say.
 *
 * A gated call is refused a third way, and this one is not final: under `approval-required` a
 * mutating Tool comes back `awaiting_approval`, which parks the Run on a durable wait rather than
 * ending the turn. The decision is keyed by the *intent* — this Run, this Tool, these arguments —
 * so the call the resumed loop re-proposes is answered by the approval already given.
 *
 * The `RequestContext` is built from the Run's recorded subject. A worker that asked to run a Tool
 * "as" someone else has no field to say it in.
 */

export interface RegistryToolDispatcherOptions {
  readonly registry: ToolRegistry;
  readonly artifacts: ArtifactService;
  readonly soulLoader?: SoulLoader;
  /** Durable Tool approvals. Absent only where a deployment runs no gated Tools at all. */
  readonly approvals?: ToolApprovalService;
  /** Where a Channel-originated Run's answer is rendered — see `presentationContextForAuthority`. */
  readonly channelDeliveries?: ChannelDeliveryReader;
  /** Backs `present`/`update_presentation`/`request_input` — absent only where no Surface Tool is registered. */
  readonly surfaceStore?: SurfaceArtifactStore;
  readonly surfaceActionStore?: SurfaceActionStore;
  /** Same revision `surfaces-routes.ts` checks a handle against at resolve time. */
  readonly guardrails?: GuardrailsService;
  /** Live GitHub-install check backing per-turn tool visibility — absent only where a deployment
   * never wired the GitHub tool family at all. */
  readonly githubStatus?: { readonly integrations: IntegrationStore; readonly businessId: string };
  /**
   * Decides authority for this call. Optional only because a deployment can run the chat path with
   * no durable principals at all (tests, and the pre-authorization boot path); where it is absent
   * the turn is exactly as authorized as it was before — availability only.
   */
  readonly gate?: ToolGate;
  /** Resolves the caller's and the Agent's authority layers. Required whenever `gate` is set. */
  readonly authorityLayers?: {
    resolvePrincipalLayer(name: string, principal: AuthorityPrincipal): Promise<AuthorityLayer>;
  };
  /**
   * Decides *whose* provider credential a call spends (D7). Optional for the same reason `gate` is:
   * a deployment can run with no per-principal credentials at all, and where it is absent every
   * provider Tool spends the service credential exactly as it did before.
   */
  readonly credentials?: CredentialResolver;
  /**
   * Authority layer L5 (D7). Absent means no provider is checked against the caller's own access,
   * which is the pre-D7 behaviour: every provider Tool reaches whatever the bot can reach.
   */
  readonly entitlements?: CompositeToolEntitlement;
  /**
   * The effect ledger for mutating platform Tools (`s6-ledger`).
   *
   * Absent means those Tools run exactly as they did before — no reservation, no attempt record,
   * and a duplicate delivery of the same tool call applies its write twice. That is the pre-ledger
   * behaviour and it is only acceptable where there is no durable store to write to at all
   * (tests, and the in-memory boot path). Every deployment with a database should supply it.
   */
  readonly effects?: EffectStore;
  now?(): Date;
}

/** What {@link RegistryToolDispatcher.authorize} concluded about a call. */
type AuthorizeVerdict =
  | { readonly decision: "proceed" }
  | { readonly decision: "approval" }
  | { readonly decision: "denied"; readonly result: HostedToolResult };

/**
 * Whether this call needs a human before it runs.
 *
 * The same rule the in-process gate applied: only a mutating Tool, only under `approval-required`,
 * and only where the Tool has not opted out. Stated here rather than inherited so the Worker path
 * gates identically to the web path it replaces — a Slack turn must not be able to do what a web
 * turn would have to ask about.
 */
function needsApproval(definition: ToolDef, autonomy: string | undefined): boolean {
  return (
    autonomy === "approval-required" && definition.mutating && definition.requiresApproval !== false
  );
}

export class RegistryToolDispatcher implements TurnToolDispatcher {
  private readonly now: () => Date;

  constructor(private readonly options: RegistryToolDispatcherOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Decides authority for this call: proceed, park for approval, or refuse with the result to
   * answer with.
   *
   * A Tool carrying no `definition` cannot be described to the gate. That is a registration defect
   * — `toToolDef` always attaches one — but it is treated as a denial rather than a pass, because
   * "I could not be described" must never be the cheapest way past the check.
   */
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

    // Both layers, always. `decideEffectivePermission` allows only what *every* layer allows, so
    // resolving fewer of them is strictly more permissive — an agent layer quietly skipped because
    // the Agent has no principal row would hand the turn the caller's full authority.
    const kind = principalKindOf(authority.subject.kind);
    if (kind === undefined) {
      // A subject kind the authority model does not know is not a subject this can decide about.
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
      // Carries the Resource catalog the `domain` of a derived target is read from. Without it
      // every target looks undomained and the HR/engineering wall silently stops holding.
      ...(this.options.soulLoader === undefined
        ? {}
        : { context: { soulLoader: this.options.soulLoader } }),
      guardrailRevision: this.options.guardrails?.revision ?? "none",
      ...(gateAutonomyOf(autonomy) === undefined ? {} : { autonomy: gateAutonomyOf(autonomy) }),
    });

    if (outcome.outcome === "authorized") return { decision: "proceed" };
    // "A human must decide this" is a policy verdict, not a pass. Returning `proceed` here would
    // discard the one outcome whose entire meaning is "do not run this yet" — and it would do so
    // silently, because the separate `needsApproval` check only fires under `approval-required`.
    if (outcome.outcome === "awaiting_approval") return { decision: "approval" };
    return {
      decision: "denied",
      result: { status: "denied", reason: denialReason(call.name, outcome.reason) },
    };
  }

  /**
   * Whether a failed attempt may be repeated, using the same three questions the effect plane asks
   * in `mayRetry` — is the fault the machinery's, is there budget left, and is repeating it safe.
   *
   * A business fault is never retried: the answer is deterministic, so a second identical call can
   * only reproduce it while spending time and budget. A mutating Tool is never retried either
   * unless it says it is safe to, because this path has no ledger behind it (`s6-ledger`): the
   * failure carries no phase, so a write that actually landed before failing would be applied
   * twice. Silence therefore means no.
   */
  private mayRetryFault(tool: ToolDef, code: ToolErrorCode, attempt: number): boolean {
    if (!isInfrastructureFault(code)) return false;
    // A provider-backed Tool already reserved an effect and ran `mayRetry` inside the ledger, with
    // the one thing this layer does not have: the dispatch *phase*. By the time its fault reaches
    // here that budget is spent, and repeating the call would start a second effect for the same
    // logical write. Retrying is therefore the ledger's job wherever a ledger exists, and only
    // this layer's job where none does — the ~71 platform Tools. When `s6-ledger` brings those
    // under the ledger too, this whole branch should go rather than nest inside it.
    if (tool.definition?.provider !== undefined) return false;
    const policy = tool.definition?.retry;
    if (attempt >= Math.max(1, policy?.maxAttempts ?? DEFAULT_TRANSIENT_ATTEMPTS)) return false;
    // A mutating Tool is only repeated when it says it is safe to be. Without a phase, a write
    // that landed and then failed on the way back is indistinguishable from one that never landed.
    return !tool.mutating || policy?.safeToRetry === true;
  }

  private async wait(delayMs: number): Promise<void> {
    if (delayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /**
   * Resolves which credential this call spends. A Tool with no authorization contract has already
   * been denied by `authorize`, so an absent definition here can only mean the resolver itself is
   * unconfigured — the service credential, exactly as before.
   */
  /**
   * Authority layer L5 — what the provider itself would let this person do (D7).
   *
   * Consulted whenever a person is behind the call, and *not* gated on which credential the call
   * will spend. Skipping it for a personal credential would look safe — the provider applies its
   * own ACLs to that credential — but it rests on the Tool actually spending it, and nothing in the
   * type system makes a Tool honour `ctx.credentialPrincipal`. A provider family that resolved to
   * `principal` and then dispatched with the installation token would have switched this layer off
   * and gone to the provider as the bot: the exact confused deputy D7 exists to close, triggered by
   * the mere existence of a stored token. Running the check in both cases costs one provider call
   * on a path that is otherwise about to make several, and its redundancy can only ever deny.
   */
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

    // The Tool's own derivation, the same call the gate makes, so the entitlement check and the
    // authorization decision can never end up describing different targets.
    let targetRefs: readonly ToolTargetRef[];
    try {
      targetRefs = tool.definition.targetsFor(
        call.arguments,
        this.options.soulLoader === undefined ? undefined : { soulLoader: this.options.soulLoader }
      );
    } catch {
      return `"${call.name}" could not be resolved to something to check access against`;
    }

    // The same normalization the gate applies. A Channel delivery is minted as `"integration"`
    // while the kind that carries grants — and that a port writes its cases against — is
    // `"integration_adapter"`. Passing the raw kind here would leave the two layers reading
    // different vocabularies, so a port's own case would silently never match and it would fall
    // into whichever branch is its default.
    //
    // An unrecognized kind denies rather than passing through: `gate` is optional, so this can be
    // the only layer that sees the call, and a subject the authority model cannot name is not one
    // whose provider access anybody can vouch for.
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
    // No provider-side question to ask — L5 abstains and L1–L4 are the whole answer. Deliberately
    // not folded in with `undefined`: this is not a check that failed.
    if (verdict === NOT_APPLICABLE) return undefined;
    if (verdict === undefined) {
      // Could not determine. Denying here is the whole point of the layer: an unreachable provider
      // must not become an open door, and this is the one moment we know we are uninformed.
      return `could not confirm your access on ${provider}, so this call was not made — try again shortly`;
    }
    return verdict.allowed ? undefined : (verdict.reason ?? `denied by ${provider}`);
  }

  /**
   * The targets recorded on a ledgered effect, for whoever later has to reconcile it.
   *
   * A throw is swallowed to an empty list rather than failing the call: the gate has already run
   * `targetsFor` and authorized this call by the time we get here, so a throw at this point is a
   * defect in the derivation, and refusing an authorized write because its *audit annotation*
   * could not be computed would trade a real effect for a cosmetic one. The reservation itself is
   * keyed on the call, never on the targets, so an empty list costs identity nothing.
   */
  private ledgerTargets(tool: ToolDef, call: HostedToolCall): readonly ToolTargetRef[] {
    if (tool.definition === undefined) return [];
    try {
      return tool.definition.targetsFor(
        call.arguments,
        this.options.soulLoader === undefined ? undefined : { soulLoader: this.options.soulLoader }
      );
    } catch {
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
    const agent = resolveAgent(this.options.soulLoader, request.agentId);
    const presentationContext = await presentationContextForAuthority(
      authority,
      this.options.channelDeliveries
    );
    const excludedTools = this.options.githubStatus
      ? await githubExcludedToolNames(this.options.githubStatus)
      : undefined;
    const allowed = new Set(
      availableToolsFor(
        this.options.registry,
        getDefaultAssistant(agent.name),
        presentationContext,
        excludedTools
      ).map((tool) => tool.name)
    );
    // The same set, carrying the definitions the projection drops — the Agent's authority layer is
    // compiled from what these Tools declare, so it must be the registered Tool, not its summary.
    const availableTools = this.options.registry
      .getAll()
      .filter((tool: ToolDef) => allowed.has(tool.name));
    const definition = this.options.registry
      .getAll()
      .find((tool: ToolDef) => tool.name === call.name);
    if (definition === undefined || !allowed.has(definition.name)) {
      return { status: "denied", reason: `tool "${call.name}" is not available to this turn` };
    }

    const validate = ajv.compile(definition.inputSchema);
    if (!validate(call.arguments)) {
      return { status: "invalid_arguments", reason: argumentErrors(validate) };
    }

    // Authority is decided before approval for the same reason approval is decided before
    // `execute`: a call the caller was never allowed to make must not reach a human as if the only
    // open question were whether they wanted it.
    const verdict = await this.authorize(
      authority,
      agent.name,
      definition,
      availableTools,
      call,
      request.autonomy
    );
    if (verdict.decision === "denied") return verdict.result;

    // Whose credential this call spends (D7). Decided after authority and before approval: a call
    // the caller was never allowed to make must not reach a human, and a call that will be refused
    // for want of a credential must not either — asking someone to approve a call that cannot run
    // wastes their decision.
    const credential = await this.resolveCredential(authority, definition);
    if (credential.use === "denied") {
      return { status: "denied", reason: credential.reason };
    }

    const denial = await this.entitlementDenial(authority, definition, call);
    if (denial !== undefined) return { status: "denied", reason: denial };

    // Asked after validation and before `execute`, so a human is never shown a call the Tool would
    // have refused anyway, and no effect lands ahead of the decision. Two things can ask for it:
    // the turn's autonomy mode, and the gate itself.
    const approvalRequired =
      verdict.decision === "approval" || needsApproval(definition, request.autonomy);
    if (approvalRequired && this.options.approvals === undefined) {
      // Policy said a human must decide and there is no way to ask one. Running it anyway would
      // convert "not yet" into "yes" on the strength of a missing dependency.
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
    }

    const surfaceComponents = [...(this.options.soulLoader?.surfaceComponents.values() ?? [])];
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
      presentationContext,
      surfaceStore: this.options.surfaceStore,
      surfaceActionStore: this.options.surfaceActionStore,
      surfaceComponents,
      surfaceCatalog: surfaceCatalogFor(presentationContext.target, surfaceComponents),
      surfaceCatalogRevision: surfaceCatalogRevisionFor(
        presentationContext.target,
        surfaceComponents
      ),
      surfaceRendererManifest: surfaceRendererRegistry.manifestFor(presentationContext.target),
      ...(credential.use === "principal" ? { credentialPrincipal: credential.principal } : {}),
    };
    // The ledger is reserved *after* every refusal and after approval, so a denied or unapproved
    // call leaves no effect behind. An effect row means "this deployment committed to doing this",
    // and a call that was refused never got that far.
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
        // A Tool that threw may still have landed its effect, so this is `failed`, not `denied`:
        // the difference is what reconciliation is later allowed to assume. A throw carries no
        // fault class, so it is never retried — an unclassified failure of unknown phase is
        // exactly the case where a second attempt could double-apply a write.
        //
        // For the same reason the ledger settles it `ambiguous` rather than `failed`: a write that
        // landed and then failed on the way back is indistinguishable from one that never landed,
        // and only `ambiguous` tells a reconciler it must go and look.
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
    // A structured error proves the executor ran to completion and decided, so the phase is known
    // and `failed` is honest — unlike the throw above, there is nothing here to reconcile.
    if (ledger && reservation) {
      await ledger.finishAttempt(authority.businessId, reservation.effectId, reservation.attempt, {
        state: "failed",
        errorCode: result.error.code,
      });
    }
    // A schema-shaped rejection (e.g. a resource-type's own required fields) is a repair signal
    // like the outer AJV check above, not an execution failure — the model must see it count
    // against the repair budget or it will resubmit the same invalid arguments forever.
    if (result.error.code === "validation_error") {
      return { status: "invalid_arguments", reason: result.error.message };
    }
    // An infrastructure fault that outlived its retries is still not the model's to repair, so it
    // is reported as the machinery being unavailable rather than as a rejection of the request.
    // Handing the model prose about a lock collision spends repair budget rewording arguments that
    // were never wrong.
    return isInfrastructureFault(result.error.code)
      ? { status: "failed", reason: `tool "${call.name}" is temporarily unavailable; try again` }
      : { status: "failed", reason: result.error.message };
  }
}

/**
 * What the model is told when the ledger says this exact call already ran.
 *
 * `confirmed` is reported as success, because from the model's point of view the thing it asked
 * for is done — telling it otherwise would invite it to ask again and defeat the reservation. The
 * unsettled states are reported as failures without repeating the call, which is the only safe
 * answer: an `ambiguous` effect is one nobody yet knows the outcome of, and re-running it is
 * exactly the double-apply the ledger exists to prevent.
 */
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

/**
 * Turns a gate refusal into something the model and the person reading the turn can act on.
 *
 * A bare "authorization_denied" is the least useful thing a denial can say: it reads as a bug, so
 * the model retries the same call and the person has nothing to take to an operator. Naming the
 * Tool and the reason it was refused is what makes the difference between "this is broken" and
 * "you need this access".
 */
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
      // Not a decision about the caller: the policy that would decide was not loaded, so nothing
      // here is safe to say about their authority.
      return `"${toolName}" cannot run because this deployment's policy revision is unknown`;
  }
}

/**
 * `InvocationPrincipal.kind` is an open string — a Run can record any executor's idea of a subject.
 * The authority model's vocabulary is closed, and a kind outside it is not something to guess at:
 * mapping it onto the nearest known kind would decide someone's authority using a principal they
 * are not.
 */
/**
 * Narrows a Run's subject kind to one the authority model can decide about.
 *
 * `InvocationPrincipal.kind` is an open `string` and its vocabulary is *not* the authority model's:
 * a channel delivery is minted as `"integration"` (`runtime/invocation-callers.ts`) while the kind
 * that carries grants is `"integration_adapter"`. The two are the same principal under two names,
 * so the mapping is explicit — without it every Slack and Telegram turn resolves to no principal
 * and is denied, which reads exactly like correct default-deny.
 *
 * Everything else fails closed. A subject kind this does not recognize is not one that can be
 * authorized, and guessing which grants it should inherit is how a new caller type arrives with
 * someone else's authority.
 */
const SUBJECT_KINDS: Readonly<Record<string, AuthorityPrincipal["kind"]>> = {
  user: "user",
  agent: "agent",
  service: "service",
  api: "api",
  routine: "routine",
  integration_adapter: "integration_adapter",
  integration: "integration_adapter",
};

function principalKindOf(kind: string): AuthorityPrincipal["kind"] | undefined {
  return SUBJECT_KINDS[kind];
}
