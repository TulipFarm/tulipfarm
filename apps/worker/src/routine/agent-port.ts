import {
  AgentLoop,
  type AgentLoopBudgetPort,
  type AgentLoopLimits,
  assembleContext,
  assembleSystemPrompt,
  type ContextCandidate,
  type GuardContext,
  GuardrailsService,
  InMemoryLoopCheckpointStore,
  type ModelPort,
  type ToolDispatchPort,
} from "@tulipfarm/agent-runtime";
import type { AgentInvocationPlan, JsonObject } from "@tulipfarm/run-kernel";
import type { AgentDefinition, ModelProfileDefinition } from "@tulipfarm/schema";
import { canonicalHash, canonicalize } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
import type { BudgetStore, RunStore } from "@tulipfarm/storage";
import type { RunEventAppendPort } from "../turn/run-events";
import { TurnEventWriter } from "../turn/run-events";

/**
 * The Worker's Agent authority for Routine Runs (SPEC §10).
 *
 * A Routine `agent` State asks an Agent a question, and every part of that question is read from the
 * Run's own pinned, signature-verified bundle: which Agent, at which authored version, with which
 * personality, against which ModelProfile. A Run that waited a week through three publications asks
 * the Agent the bundle it was minted against describes — not whatever the live Soul says now.
 *
 * It runs the same `AgentLoop` a chat turn runs, over the same Context manifest and the same three
 * guardrail stages, so an Agent reached from a Routine is bounded exactly like an Agent reached from
 * a conversation. What it deliberately does *not* do is expose Tools: a Routine's effects belong to
 * its own `tool` States, where the Broker authorizes them against the pinned Guardrails and the
 * effect ledger reserves them. Letting the loop dispatch as well would put a second effect path
 * beside the one the Routine author declared.
 */

export type RoutineAgentOutcome =
  /** The Agent answered, and the answer satisfied whatever schema the State declared. */
  | { readonly kind: "succeeded"; readonly output: unknown }
  /** A definitive negative the authored `onError` path may claim, named by its reason code. */
  | { readonly kind: "failed"; readonly reason: string }
  /** The loop held a Tool call for a human. Nothing here can open that Approval, so the Run parks. */
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
}

export interface RoutineAgentPort {
  execute(request: RoutineAgentRequest): Promise<RoutineAgentOutcome>;
}

export interface BundleRoutineAgentPortOptions {
  readonly model: ModelPort;
  readonly events: RunEventAppendPort;
  readonly budgets: Pick<BudgetStore, "consume">;
  readonly runs: Pick<RunStore, "find">;
  /** Where a guard that timed out or threw is reported; it is skipped, never allowed to stall. */
  readonly log: { warn(obj: unknown, msg?: string): void };
  readonly now?: () => Date;
}

/** Run statuses that mean the question must stop being asked. */
const CANCELLING_STATUSES: ReadonlySet<string> = new Set(["cancelling", "cancelled"]);

/**
 * The loop's bounds for a Routine `agent` State.
 *
 * No Tools are exposed, so no Tool budget is either: one model call answers the question, and the
 * only authored dial is how many malformed answers may be sent back for repair.
 */
const MAX_ITERATIONS = 1;

const SYSTEM_SOURCE_ID = "system";
const REQUEST_SOURCE_ID = "request";

/** Who a Routine State acts as. There is no participant behind it, and none is invented. */
const SERVICE_PRINCIPAL = "service:routine-executor";

/** The same estimate the API's compaction uses, so a budget means the same thing on both sides. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function definitionOf<T>(bundle: RuntimeBundle, kind: string, slug: string): T | undefined {
  return bundle.get(kind, slug)?.document as T | undefined;
}

/**
 * The Context manifest's candidates: the Agent's own instructions, then the question the Routine
 * resolved. The question sits at `user_request`, below the Agent's instructions, so a Routine input
 * carrying instruction-shaped text can never outrank the Agent it is being asked.
 */
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

/** A Tool dispatch port that denies everything: this State exposes no Tools, and says so. */
const NO_TOOLS: ToolDispatchPort = {
  dispatch: async (request) => ({
    status: "denied",
    callId: request.callId,
    reason: "tools_not_exposed_to_routine_agent_state",
  }),
};

/** An answer as the text a guard reads. Structured output is canonicalized, never stringified ad hoc. */
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

    // The authored reference names an exact version; a bundle holding a different one is not the
    // Agent this Routine was published against, and picking the one that is there would silently
    // answer with something else.
    const authoredVersion = bundle.get("Agent", plan.agentRef.name)?.authoredVersion;
    if (authoredVersion !== Number(plan.agentRef.version)) {
      return { kind: "unavailable", reason: "agent_version_mismatch" };
    }

    const profile = definitionOf<ModelProfileDefinition>(
      bundle,
      "ModelProfile",
      agent.spec.modelProfile
    );
    if (profile === undefined) {
      return { kind: "unavailable", reason: "model_profile_not_in_bundle" };
    }

    // The guards are rebuilt from the deployment's default policy, and the digest recorded as
    // evidence is the one this service actually compiled — never a digest for a policy that did not
    // run. A bundle-authored prompt policy would be read here once Souls publish one.
    const guardrails = new GuardrailsService();
    guardrails.init(null, this.options.log);
    // A Routine State has no participant and no conversation; the Run is the whole identity a guard
    // gets, and naming it as one keeps a guard from being told about a user who is not there.
    const guardContext: GuardContext = {
      userId: SERVICE_PRINCIPAL,
      conversationId: request.runId,
      agentId: plan.agentRef.name,
      autonomy: agent.spec.autonomy,
    };

    const system = assembleSystemPrompt({
      agentId: plan.agentRef.name,
      ...(agent.spec.personality === undefined ? {} : { personality: agent.spec.personality }),
      memory: [],
      governancePages: [],
      // A Routine State has no participant, so there is no `timezone` preference to read and the
      // block renders UTC. Naming the Run's own clock is still worth more than leaving the Agent to
      // date-reason from its training cutoff.
      temporal: { now: this.now() },
    });
    const question = canonicalize(plan.input);

    const guardedInput = await guardrails.runInput(question, guardContext);
    if (guardedInput.blocked) return { kind: "failed", reason: "guardrail_input_blocked" };

    const manifest = assembleContext({
      businessId: request.businessId,
      runId: request.runId,
      stateId: request.stateKey,
      candidates: candidatesFor(system, guardedInput.value),
      guardrailDigest: guardrails.revision,
      bundleDigest: bundle.digest,
      budgetTokens: profile.spec.supports.contextWindowTokens,
    });
    // A question the Agent's own context window cannot hold is not one to ask half of.
    if (manifest.excluded.length > 0) return { kind: "unavailable", reason: "context_budget" };

    const events = new TurnEventWriter({
      events: this.options.events,
      businessId: request.businessId,
      runId: request.runId,
      // No Turn exists — a Routine State is not a conversation. The State occurrence and the row
      // version it was claimed at are what make this attempt's event keys its own.
      turnId: request.stateKey,
      attempt: request.attempt,
      now: this.now,
    });
    await events.emit(
      "context.assembled",
      {
        contextDigest: manifest.digest,
        guardrailDigest: guardrails.revision,
        messageCount: 2,
        compacted: false,
        modelProfileId: profile.spec.model,
      },
      "context"
    );

    const loop = new AgentLoop({
      model: this.options.model,
      tools: NO_TOOLS,
      checkpoints: new InMemoryLoopCheckpointStore(),
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
      modelProfileId: profile.spec.model,
      contextDigest: manifest.digest,
      guardrailDigest: guardrails.revision,
      messages: [
        { role: "system", content: system },
        { role: "user", content: guardedInput.value },
      ],
      tools: [],
      limits: this.limits(plan),
      ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
    });

    if (outcome.status === "cancelled") return { kind: "cancelled" };
    if (outcome.status === "failed") return { kind: "failed", reason: outcome.reason };
    if (outcome.status === "awaiting_approval") {
      return { kind: "awaiting_approval", reason: "approval_required" };
    }

    // The last point at which a refusal costs nothing: the answer has not settled the State, so no
    // downstream State has read it and no effect has been dispatched on the strength of it.
    const guardedOutput = await guardrails.runOutput(answerText(outcome.output), guardContext);
    if (guardedOutput.blocked) return { kind: "failed", reason: "guardrail_output_blocked" };

    return { kind: "succeeded", output: outcome.output };
  }

  private limits(plan: AgentInvocationPlan): AgentLoopLimits {
    return {
      maxIterations: MAX_ITERATIONS,
      maxToolCalls: 0,
      maxRepairAttempts: plan.maxRepairAttempts ?? 0,
    };
  }

  /** The Run kernel budget, narrowed to the Run being charged. */
  private budget(request: RoutineAgentRequest): AgentLoopBudgetPort {
    return {
      consume: (input) =>
        this.options.budgets.consume(request.businessId, request.runId, input.key, input.amount),
    };
  }
}
