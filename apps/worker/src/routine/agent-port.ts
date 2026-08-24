import {
  AgentLoop,
  type AgentLoopBudgetPort,
  type AgentLoopLimits,
  assembleContext,
  assembleSystemPrompt,
  type ContextCandidate,
  deriveModelRequirements,
  type ExposedTool,
  formatTemporalContext,
  type GuardContext,
  GuardrailsService,
  InMemoryLoopCheckpointStore,
  type LoopCheckpointStore,
  type ModelInvocationFailureReason,
  type ModelPort,
  type ModelProfileCatalog,
  type ModelProfileSelection,
  selectModelProfile,
  type ToolDispatchPort,
} from "@tulipfarm/agent-runtime";
import { ROUTINE_SERVICE_PRINCIPAL_ID } from "@tulipfarm/constants";
import {
  type AgentInvocationPlan,
  type JsonObject,
  LIMIT_KEYS,
  type LimitKey,
  RunBudgetManager,
  type RunBudgetStore,
  type ScopedLimits,
} from "@tulipfarm/run-kernel";
import type { AgentDefinition, ModelProfileDefinition, RunEventPayloads } from "@tulipfarm/schema";
import { canonicalHash, canonicalize, textContent } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
import type { RunStore } from "@tulipfarm/storage";
import type { RunEventAppendPort } from "@tulipfarm/turn-executor";
import { announceToolCalls, TurnEventWriter } from "@tulipfarm/turn-executor";
import { type ModelBudgetEvidence, openModelProfileRunBudget } from "../model-budget";

/** Routine Agent authority: read pinned bundles, run chat-equivalent guards, expose no Tools. */

export type RoutineAgentOutcome =
  /** The Agent answered, and the answer satisfied whatever schema the State declared. */
  | { readonly kind: "succeeded"; readonly output: unknown }
  /**
   * A definitive negative the authored `onError` path may claim, named by its reason code.
   * `retryable` marks a transient provider fault the executor may re-attempt under the State's
   * `retry` policy; a deterministic refusal (Guardrail block, config denial, exhausted budget) is
   * terminal and re-running only spends tokens to reach the same answer.
   */
  | { readonly kind: "failed"; readonly reason: string; readonly retryable: boolean }
  /** The loop held a Tool call for a human; this port cannot open that Approval. */
  | { readonly kind: "awaiting_approval"; readonly reason: string }
  /** The Run is being cancelled; the executor leaves the State to the cancellation manager. */
  | { readonly kind: "cancelled" }
  /** Nothing decided the question. The State parks for reconciliation rather than guessing. */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface RoutineAgentRequest {
  readonly businessId: string;
  readonly runId: string;
  /** Durable State occurrence key, so a fan-out unit's events are its own. */
  readonly stateKey: string;
  /** State row version at claim time; distinguishes this attempt's events from an earlier one's. */
  readonly attempt: number;
  readonly plan: AgentInvocationPlan;
  /** The schema the answer must satisfy, when the State declared one. */
  readonly outputSchema?: JsonObject;
  /** The Run's exact pinned bundle — the only source of Agent identity and model selection. */
  readonly bundle: RuntimeBundle;
  /**
   * Ceilings from scopes broader than the ModelProfile — today the authored Routine's `limits`.
   * They are resolved with the profile's own budgets before the Run budget ledger is opened, so a
   * Routine that declared a cost or token ceiling actually gets one.
   */
  readonly scopedLimits?: readonly ScopedLimits[];
}

export interface RoutineAgentPort {
  execute(request: RoutineAgentRequest): Promise<RoutineAgentOutcome>;
}

export interface BundleRoutineAgentPortOptions {
  /** Bind to the already-selected pinned-bundle chain; do not re-resolve via live config. */
  model(selection: RoutineModelSelection): ModelPort;
  /**
   * Where this State's Tool calls execute. Absent leaves the State unable to call any Tool, which
   * is what it could do before: a deployment that wires no host fails closed rather than open.
   */
  readonly tools?: ToolDispatchPort;
  /**
   * The Tools the acting Agent may be offered, answered by the control plane's registry.
   *
   * Fetched rather than derived here because this process has no Soul and no Tool registry, and a
   * catalog it invented would not be the one the same Agent gets in Chat.
   */
  readonly catalog?: (runId: string, agentName: string) => Promise<readonly ExposedTool[]>;
  readonly events: RunEventAppendPort;
  readonly budgets: RunBudgetStore;
  readonly runs: Pick<RunStore, "find">;
  /**
   * Durable Agent-loop counters. A Routine Agent State exposes no Tools, so it cannot park on
   * approval today, but the store is injected for parity with Chat and to keep limits durable if
   * that ever changes. Defaults to in-memory for tests.
   */
  readonly checkpoints?: LoopCheckpointStore;
  /** Where a guard that timed out or threw is reported; it is skipped, never allowed to stall. */
  readonly log: { warn(obj: unknown, msg?: string): void };
  readonly now?: () => Date;
}

/** A settled routing decision: the chain to invoke, in order, and the evidence that chose it. */
export interface RoutineModelSelection {
  /** Provider Model IDs, primary first, then its constraint-equivalent fallbacks. */
  readonly modelIds: readonly string[];
  /** The routing evidence already emitted for this State, so the port need not re-derive it. */
  readonly routing: RunEventPayloads["model.routed"];
  /** The spending Run, so this State's model calls reach the ledger attributed to it. */
  readonly runId: string;
}

/** Run statuses that mean the question must stop being asked. */
const CANCELLING_STATUSES: ReadonlySet<string> = new Set(["cancelling", "cancelled"]);

/**
 * Which Agent-loop failures are worth another attempt under a State's `retry` policy.
 *
 * Only transient provider faults are: a rate limit or an unavailable/errored provider can clear on
 * its own before the next attempt. Everything else an Agent State can fail with — a blocked
 * Guardrail, a config-level model denial (billing inactive, bad key, unknown model), an exhausted
 * token/repair/iteration budget, or empty output already nudged within the repair budget — is
 * deterministic, so re-running only spends tokens to reach the identical refusal.
 */
const RETRYABLE_AGENT_FAILURES: ReadonlySet<string> = new Set<ModelInvocationFailureReason>([
  "model_rate_limited",
  "model_provider_unavailable",
  "model_error",
]);

/** True when re-attempting the Agent could plausibly change the outcome. */
export function isRetryableAgentFailure(reason: string): boolean {
  return RETRYABLE_AGENT_FAILURES.has(reason);
}

/**
 * Model calls one Routine Agent State may take.
 *
 * A State that can call Tools needs room to call one and then answer with what it returned; at 1
 * the model could only ever describe the call it wanted. Matches the Chat Turn ceiling, so the
 * same Agent behaves the same in a Routine as in a conversation.
 */
const MAX_ITERATIONS = 12;

/** Tool calls one State may make. Same ceiling as the iteration budget, as in Chat. */
const MAX_TOOL_CALLS = 12;

const SYSTEM_SOURCE_ID = "system";
const REQUEST_SOURCE_ID = "request";

/** Who a Routine State acts as. There is no participant behind it, and none is invented. */
const SERVICE_PRINCIPAL = ROUTINE_SERVICE_PRINCIPAL_ID;

/** The same estimate the API's compaction uses, so a budget means the same thing on both sides. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function definitionOf<T>(bundle: RuntimeBundle, kind: string, slug: string): T | undefined {
  return bundle.get(kind, slug)?.document as T | undefined;
}

/** Routing catalog from the Run's pinned bundle only, never live ModelProfiles. */
function bundleCatalog(bundle: RuntimeBundle): ModelProfileCatalog {
  return {
    get(profileId) {
      const definition = definitionOf<ModelProfileDefinition>(bundle, "ModelProfile", profileId);
      return definition === undefined ? undefined : { ...definition.spec, profileId };
    },
  };
}

function modelRoutingPayload(
  selector: string,
  selection: ModelProfileSelection,
  budgetLimits?: ModelBudgetEvidence
): RunEventPayloads["model.routed"] {
  if (selection.outcome === "denied") {
    return {
      outcome: "denied",
      selector,
      resolution: "profile_ref",
      profileId: selection.profileId,
      reason: selection.reason,
      attempts: selection.attempts,
    };
  }

  return {
    outcome: "selected",
    selector,
    resolution: "profile_ref",
    profileId: selection.profileId,
    chain: selection.chain.map((profile) => ({
      profileId: profile.profileId,
      modelId: profile.model,
    })),
    cacheAllowed: selection.cacheAllowed,
    rejectedFallbacks: selection.rejectedFallbacks,
    ...(budgetLimits === undefined ? {} : { budgetLimits }),
  };
}

/** Agent instructions outrank Routine input, so input text cannot override the Agent. */
function candidatesFor(system: string, question: string): readonly ContextCandidate[] {
  const allow = { decision: "allow" } as const;
  return [
    {
      sourceId: SYSTEM_SOURCE_ID,
      kind: "instruction",
      precedence: "agent_instructions",
      version: "1",
      classification: "internal",
      taint: "trusted",
      authorization: allow,
      tokens: estimateTokens(system),
      digest: canonicalHash({ system }),
    },
    {
      sourceId: REQUEST_SOURCE_ID,
      kind: "message",
      precedence: "user_request",
      version: "1",
      classification: "internal",
      taint: "trusted",
      authorization: allow,
      tokens: estimateTokens(question),
      digest: canonicalHash({ question }),
    },
  ];
}

/**
 * Appends the Run's clock to an assembled prompt.
 *
 * Chat Agents learn what *now* is by calling `get_current_time`; this State exposes no Tools by
 * design (see `NO_TOOLS`), so that door is shut and without this the Agent would date-reason from
 * its training cutoff — "is this overdue?" answered against the wrong year. The block is composed
 * here rather than in `assembleSystemPrompt` because it is true of this execution path only.
 *
 * A Routine State has no participant and therefore no timezone preference to read, so it renders
 * UTC.
 */
function withRunClock(system: string, now: Date): string {
  const clock = `<run-context>\n${formatTemporalContext({ now })}\n</run-context>`;
  return system.length === 0 ? clock : `${system}\n${clock}`;
}

/** A Tool dispatch port that denies everything: this State exposes no Tools, and says so. */
const NO_TOOLS: ToolDispatchPort = {
  dispatch: async (request) => ({
    status: "denied",
    callId: request.callId,
    reason: "tools_not_exposed_to_routine_agent_state",
  }),
};

/** Guard text for an answer; structured output is canonicalized. */
function answerText(output: unknown): string {
  return typeof output === "string" ? output : canonicalize(output);
}

export class BundleRoutineAgentPort implements RoutineAgentPort {
  private readonly now: () => Date;

  constructor(private readonly options: BundleRoutineAgentPortOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(request: RoutineAgentRequest): Promise<RoutineAgentOutcome> {
    const { plan, bundle } = request;
    const agent = definitionOf<AgentDefinition>(bundle, "Agent", plan.agentRef.name);
    if (agent === undefined) return { kind: "unavailable", reason: "agent_not_in_bundle" };

    // The authored Agent version is exact; a different bundled version is not a substitute.
    const authoredVersion = bundle.get("Agent", plan.agentRef.name)?.authoredVersion;
    if (authoredVersion !== Number(plan.agentRef.version)) {
      return { kind: "unavailable", reason: "agent_version_mismatch" };
    }

    // Record the digest of the guard policy this service actually compiled and ran.
    const guardrails = new GuardrailsService();
    guardrails.init(null, this.options.log);
    // Routine States have no participant; guards see the Run as the whole identity.
    const guardContext: GuardContext = {
      userId: SERVICE_PRINCIPAL,
      conversationId: request.runId,
      agentId: plan.agentRef.name,
      autonomy: agent.spec.autonomy,
    };

    const system = withRunClock(
      assembleSystemPrompt(
        agent.spec.personality === undefined ? {} : { personality: agent.spec.personality }
      ),
      this.now()
    );
    const question = canonicalize(plan.input);

    const guardedInput = await guardrails.runInput(question, guardContext);
    if (guardedInput.blocked) {
      return { kind: "failed", reason: "guardrail_input_blocked", retryable: false };
    }

    const events = new TurnEventWriter({
      events: this.options.events,
      businessId: request.businessId,
      runId: request.runId,
      // No Turn exists; State occurrence plus row version make event keys attempt-scoped.
      turnId: request.stateKey,
      attempt: request.attempt,
      now: this.now,
    });

    // Route through the pinned-bundle catalog; denial parks instead of bypassing profile terms.
    const selection = selectModelProfile(
      agent.spec.modelProfile,
      deriveModelRequirements({
        requestId: request.stateKey,
        modelProfileId: agent.spec.modelProfile,
        messages: [
          { role: "system", content: textContent(system) },
          { role: "user", content: textContent(guardedInput.value) },
        ],
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      }),
      bundleCatalog(bundle)
    );
    if (selection.outcome === "denied") {
      await events.emit(
        "model.routed",
        modelRoutingPayload(agent.spec.modelProfile, selection),
        "model"
      );
      this.options.log.warn(
        { runId: request.runId, profileId: selection.profileId, reason: selection.reason },
        "routine model profile denied"
      );
      return { kind: "unavailable", reason: `model_${selection.reason}` };
    }
    const primary = selection.chain[0];
    if (primary === undefined) return { kind: "unavailable", reason: "model_unknown_profile" };
    const budgetLimits = await openModelProfileRunBudget({
      budgets: this.options.budgets,
      businessId: request.businessId,
      runId: request.runId,
      profile: primary,
      scoped: request.scopedLimits ?? [],
    });
    const routing = modelRoutingPayload(agent.spec.modelProfile, selection, budgetLimits);
    await events.emit("model.routed", routing, "model");

    const manifest = assembleContext({
      businessId: request.businessId,
      runId: request.runId,
      stateId: request.stateKey,
      candidates: candidatesFor(system, guardedInput.value),
      guardrailDigest: guardrails.revision,
      bundleDigest: bundle.digest,
      budgetTokens: primary.supports.contextWindowTokens,
    });
    // Never ask a question the selected Agent context window cannot hold in full.
    if (manifest.excluded.length > 0) return { kind: "unavailable", reason: "context_budget" };

    await events.emit(
      "context.assembled",
      {
        contextDigest: manifest.digest,
        guardrailDigest: guardrails.revision,
        messageCount: 2,
        compacted: false,
        modelProfileId: selection.profileId,
      },
      "context"
    );

    const exposed = await this.exposedTools(request, plan.agentRef.name);
    const loop = new AgentLoop({
      model: this.options.model({
        modelIds: selection.chain.map((profile) => profile.model),
        routing,
        runId: request.runId,
      }),
      tools: exposed.length === 0 ? NO_TOOLS : this.toolPort(plan.agentRef.name, events),
      checkpoints: this.options.checkpoints ?? new InMemoryLoopCheckpointStore(),
      events,
      budget: this.budget(request),
      isCancelled: async () => {
        const current = await this.options.runs.find(request.businessId, request.runId);
        return current !== null && CANCELLING_STATUSES.has(current.status);
      },
      log: this.options.log,
      now: this.now,
    });

    const outcome = await loop.run({
      businessId: request.businessId,
      runId: request.runId,
      stateId: request.stateKey,
      modelProfileId: selection.profileId,
      contextDigest: manifest.digest,
      guardrailDigest: guardrails.revision,
      messages: [
        { role: "system", content: textContent(system) },
        { role: "user", content: textContent(guardedInput.value) },
      ],
      tools: exposed,
      limits: this.limits(plan, exposed.length),
      ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
    });

    if (outcome.status === "cancelled") return { kind: "cancelled" };
    if (outcome.status === "failed") {
      return {
        kind: "failed",
        reason: outcome.reason,
        retryable: isRetryableAgentFailure(outcome.reason),
      };
    }
    if (outcome.status === "awaiting_approval") {
      return { kind: "awaiting_approval", reason: "approval_required" };
    }
    if (outcome.status === "input_required") {
      // Routine Agents expose no Surface-capable Tools, so this outcome cannot be resumed here.
      return { kind: "failed", reason: "input_required_without_surface", retryable: false };
    }

    // Last zero-cost refusal point: no State is settled and no downstream effect has run.
    const guardedOutput = await guardrails.runOutput(answerText(outcome.output), guardContext);
    if (guardedOutput.blocked) {
      return { kind: "failed", reason: "guardrail_output_blocked", retryable: false };
    }

    return { kind: "succeeded", output: outcome.output };
  }

  /**
   * The Tools this State may call, or none when no host is wired or the control plane offers none.
   *
   * A catalog read that fails leaves the State Tool-less rather than failing it: the model can
   * still answer, and the State's own outcome says whether that answer was enough.
   */
  private async exposedTools(
    request: RoutineAgentRequest,
    agentName: string
  ): Promise<readonly ExposedTool[]> {
    const { tools, catalog } = this.options;
    if (tools === undefined || catalog === undefined) return [];
    try {
      return await catalog(request.runId, agentName);
    } catch (error) {
      this.options.log.warn(
        { err: error, runId: request.runId, agent: agentName },
        "routine agent tool catalog unavailable; running without Tools"
      );
      return [];
    }
  }

  /**
   * Names the acting Agent on every call, so the control plane can confirm it against the Soul.
   *
   * Wrapped in `announceToolCalls` for the same reason Chat wraps it: without it a Routine State's
   * Tool calls leave no `tool.call`/`tool.result` Run events, so a denied call is invisible to the
   * Runs view and the only record of it is whatever the model chose to say in prose.
   */
  private toolPort(agentName: string, events: TurnEventWriter): ToolDispatchPort {
    const tools = this.options.tools ?? NO_TOOLS;
    return announceToolCalls(
      { dispatch: (call) => tools.dispatch({ ...call, agentName }) },
      events
    );
  }

  private limits(plan: AgentInvocationPlan, toolCount: number): AgentLoopLimits {
    return {
      maxIterations: MAX_ITERATIONS,
      // Zero when the State is offered nothing, so a deployment with no Tool host keeps the exact
      // single-call shape this port had before.
      maxToolCalls: toolCount === 0 ? 0 : MAX_TOOL_CALLS,
      maxRepairAttempts: plan.maxRepairAttempts ?? 0,
    };
  }

  /** The Run kernel budget, narrowed to the Run being charged. */
  private budget(request: RoutineAgentRequest): AgentLoopBudgetPort {
    const manager = new RunBudgetManager(this.options.budgets);
    return {
      consume: (input) =>
        isLimitKey(input.key)
          ? manager.consume({
              businessId: request.businessId,
              runId: request.runId,
              key: input.key,
              amount: input.amount,
            })
          : this.options.budgets.consume(
              request.businessId,
              request.runId,
              input.key,
              input.amount
            ),
    };
  }
}

const LIMIT_KEY_SET: ReadonlySet<string> = new Set(LIMIT_KEYS);

function isLimitKey(key: string): key is LimitKey {
  return LIMIT_KEY_SET.has(key);
}
