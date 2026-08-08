import type {
  AgentLoopInput,
  AgentLoopLimits,
  ExposedTool,
  ModelMessage,
} from "@tulipfarm/agent-runtime";
import type { StateStatus } from "@tulipfarm/run-kernel";
import type { AgentStateRequest, AgentStateResult, AgentStateRunner } from "../agent-state";
import type {
  CompleteTurnResult,
  ConversationTurnCompleter,
  TurnOutcome,
} from "../conversation-turn";
import type { ModelCallReceipt } from "../model";
import type { RunOutcome } from "../run-dispatcher";
import type { TurnGuardrails } from "./guardrails";
import type { TurnEventWriter } from "./run-events";

/**
 * The turn driver (SPEC §10; blocker §2).
 *
 * One turn, start to finish: announce it, resolve the Context, run the bounded loop, persist the
 * result, and close the stream. Every one of those steps already has an owner — `AgentStateRunner`
 * for the kernel status, `AgentLoop` for the model and Tools, `ConversationTurnCompleter` for the
 * durable Message, `TurnEventWriter` for what readers see — so this file only orders them and
 * decides how the Run is left. It holds no policy of its own, which is what keeps the same code
 * path serving web, Slack, Telegram, and whatever channel comes next.
 *
 * The ordering that matters: `turn.finished` is emitted **after** completion is durable. A reader
 * that sees the turn finish can therefore fetch the Message it names, rather than racing a write
 * that has not landed.
 */

/** The turn to execute, as the executor read it out of the Run's request Artifact. */
export interface TurnRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  /**
   * The State's status as the executor observed it, not an assumption made here. The kernel only
   * allows `running` from `claimed`, so a State the worker has not actually claimed must fail the
   * transition rather than be driven from a status the driver invented.
   */
  readonly stateStatus: StateStatus;
  readonly turnId: string;
  readonly conversationId: string;
  readonly attempt: number;
  /** Highest attempt the Turn has; a lower one arriving late is stale and writes nothing. */
  readonly latestAttempt?: number;
}

/**
 * Everything the model needs for one turn, resolved elsewhere.
 *
 * Today the API owns the conversation history, the Soul artifacts, and the Tool catalog, so the
 * implementation is an HTTP call to the internal turn host. PR 4 replaces the implementation with
 * in-worker resolution and this contract does not move.
 */
export interface ResolvedTurnContext {
  readonly agentId: string;
  /** Whom the turn acts as, as the Run recorded it. Guards are told who they are guarding. */
  readonly subjectId: string;
  readonly modelProfileId: string;
  readonly contextDigest: string;
  readonly guardrailDigest: string;
  /** The validated guardrail policy `guardrailDigest` names, rebuilt into guards here. */
  readonly guardrailPolicy: Record<string, unknown>;
  readonly messages: readonly ModelMessage[];
  /**
   * The Tools this turn may call. `tier` rides along for the tool-call guard, which can refuse a
   * whole category; the loop and the model see only what `ExposedTool` declares.
   */
  readonly tools: readonly (ExposedTool & { readonly tier: string })[];
  readonly limits: AgentLoopLimits;
  /** Whether history was compacted to fit; operator evidence, not a participant's concern. */
  readonly compacted: boolean;
  /** Mirrors `HostedTurnContext.skillToolScopes` — see `AgentLoopInput.skillToolScopes`. */
  readonly skillToolScopes?: Record<string, readonly string[]>;
}

export interface TurnContextPort {
  resolve(request: TurnRequest): Promise<ResolvedTurnContext>;
}

export interface TurnDriverOptions {
  readonly states: AgentStateRunner;
  readonly context: TurnContextPort;
  readonly completer: ConversationTurnCompleter;
  /**
   * The turn's guards, already wrapped around the Tool dispatch port. Configured here rather than
   * by the caller because only this file knows the resolved Context, and required rather than
   * optional because a turn nobody guards is not a turn this driver may run.
   */
  readonly guardrails: TurnGuardrails;
  /** One writer per attempt — it keys events by the attempt it was built with. */
  buildEvents(request: TurnRequest): TurnEventWriter;
  /**
   * The model call this turn's reply came from, read once the turn succeeds. Optional because a
   * caller may drive a port that keeps no receipt; the turn then finishes without one rather than
   * reporting a model it cannot name.
   */
  modelReceipt?(): ModelCallReceipt | undefined;
}

export class TurnDriver {
  constructor(private readonly options: TurnDriverOptions) {}

  async run(request: TurnRequest): Promise<RunOutcome> {
    if (this.options.completer.isStale(request)) {
      // Asked before any model call or Tool dispatch: a superseded attempt must not spend money or
      // land an effect on the way to discovering that its answer would be thrown away.
      return "succeeded";
    }

    const events = this.options.buildEvents(request);
    const context = await this.options.context.resolve(request);

    // Before the first event: a mismatch between the policy shipped with the Context and the digest
    // recorded as evidence throws here, so no turn runs under guards its own record misnames.
    this.options.guardrails.configure({
      policy: context.guardrailPolicy,
      digest: context.guardrailDigest,
      context: {
        userId: context.subjectId,
        agentId: context.agentId,
        conversationId: request.conversationId,
      },
      toolTiers: new Map(context.tools.map((tool) => [tool.name, tool.tier])),
    });

    await events.emit(
      "turn.started",
      {
        turnId: request.turnId,
        attempt: request.attempt,
        agentId: context.agentId,
        conversationId: request.conversationId,
      },
      "started"
    );
    await events.emit(
      "context.assembled",
      {
        contextDigest: context.contextDigest,
        guardrailDigest: context.guardrailDigest,
        messageCount: context.messages.length,
        compacted: context.compacted,
        modelProfileId: context.modelProfileId,
      },
      "context"
    );

    const stateRequest: AgentStateRequest = {
      businessId: request.businessId,
      runId: request.runId,
      stateKey: request.stateKey,
      from: request.stateStatus,
    };

    // The input stage (GR-V1-001) runs before the model is asked anything, so a refused request
    // costs no model call and lands no Tool effect. A refusal is still an answer: the State is
    // settled and the guard's message is persisted as the reply, which is what makes a blocked
    // Slack message and a blocked web message read the same.
    const guarded = await this.guardInput(context, events);
    if (guarded.blocked) {
      return this.complete(
        request,
        events,
        await this.options.states.settle(stateRequest, guarded.message)
      );
    }

    const input: AgentLoopInput = {
      businessId: request.businessId,
      runId: request.runId,
      stateId: request.stateKey,
      modelProfileId: context.modelProfileId,
      contextDigest: context.contextDigest,
      guardrailDigest: context.guardrailDigest,
      messages: guarded.messages,
      tools: context.tools,
      limits: context.limits,
      ...(context.skillToolScopes === undefined
        ? {}
        : { skillToolScopes: new Map(Object.entries(context.skillToolScopes)) }),
    };
    const result = await this.options.states.execute(stateRequest, input);

    if (result.status === "cancelled") {
      // The cancellation manager is mid-transition; recording an outcome here would contradict it.
      return "cancelled";
    }

    if (result.status === "needs_reconciliation") {
      // An effect may or may not have landed. Say so, and let reconciliation decide.
      await events.emit(
        "turn.finished",
        { status: "failed", messageId: null, reason: "needs_reconciliation" },
        "finished"
      );
      return "needs_reconciliation";
    }

    if (result.status === "waiting") {
      await events.emit(
        "approval.requested",
        { waitId: result.waitId, intentId: result.approvalId, callId: result.callId },
        "approval"
      );
      return "waiting";
    }

    return this.complete(request, events, result);
  }

  /**
   * The user's request as the model may see it.
   *
   * Only the last user message is guarded, because that is the one this turn is answering —
   * everything above it is transcript the guards already saw when it was submitted. A transform
   * rewrites what the model is given and leaves the persisted Message alone, so the conversation
   * still records what the person actually wrote.
   */
  private async guardInput(
    context: ResolvedTurnContext,
    events: TurnEventWriter
  ): Promise<
    | { readonly blocked: true; readonly message: string }
    | { readonly blocked: false; readonly messages: readonly ModelMessage[] }
  > {
    let index = context.messages.length - 1;
    while (index >= 0 && context.messages[index]?.role !== "user") index -= 1;
    const current = index < 0 ? undefined : context.messages[index];
    if (current === undefined) return { blocked: false, messages: context.messages };

    const guarded = await this.options.guardrails.input(current.content, events);
    if (guarded.blocked) return guarded;

    const messages = [...context.messages];
    messages[index] = { role: current.role, content: guarded.text };
    return { blocked: false, messages };
  }

  private async complete(
    request: TurnRequest,
    events: TurnEventWriter,
    result: Extract<AgentStateResult, { status: "succeeded" | "failed" }>
  ): Promise<RunOutcome> {
    const completion = await this.options.completer.complete({
      businessId: request.businessId,
      runId: request.runId,
      conversationId: request.conversationId,
      turnId: request.turnId,
      attempt: request.attempt,
      cursor: events.cursor,
      outcome: await this.guardOutput(turnOutcome(result), events),
      ...(request.latestAttempt === undefined ? {} : { latestAttempt: request.latestAttempt }),
    });

    return this.finish(events, completion);
  }

  /**
   * The answer, guarded before it becomes durable (GR-V1-003).
   *
   * This is the last point at which a refusal costs nothing: the Message has not been written, so
   * no channel has posted it and no reader can fetch it. A blocked answer is replaced rather than
   * dropped — a turn that succeeds and shows nothing tells the reader less than one that says it
   * will not answer.
   */
  private async guardOutput(outcome: TurnOutcome, events: TurnEventWriter): Promise<TurnOutcome> {
    if (outcome.status !== "succeeded") return outcome;
    const guarded = await this.options.guardrails.output(outcome.text, events);
    return { status: "succeeded", text: guarded.blocked ? guarded.message : guarded.text };
  }

  private async finish(
    events: TurnEventWriter,
    completion: CompleteTurnResult
  ): Promise<RunOutcome> {
    if (completion.status === "stale") {
      // A newer attempt already answered this Turn; announcing this one would contradict it.
      return "succeeded";
    }

    if (completion.status === "succeeded") {
      const receipt = this.options.modelReceipt?.();
      await events.emit(
        "turn.finished",
        { status: "succeeded", messageId: completion.messageId, ...(receipt ?? {}) },
        "finished"
      );
      return "succeeded";
    }

    if (completion.status === "failed") {
      await events.emit(
        "turn.finished",
        { status: "failed", messageId: null, reason: completion.reason },
        "finished"
      );
      return "failed";
    }

    // `waiting` is handled before completion is attempted, so reaching it here is a contradiction.
    throw new Error(`turn completion returned an unexpected status "${completion.status}"`);
  }
}

/**
 * The loop's output as a Turn outcome.
 *
 * A completed loop whose output is not text still has to become something a participant can read,
 * so a structured output is serialized rather than dropped. An empty answer is a failure, not a
 * blank Message — the reader would otherwise be told the turn succeeded and shown nothing.
 */
function turnOutcome(
  result: Extract<AgentStateResult, { status: "succeeded" | "failed" }>
): TurnOutcome {
  if (result.status === "failed") return { status: "failed", reason: result.reason };
  const text = renderAnswer(result.output);
  if (text.length === 0) return { status: "failed", reason: "empty_model_output" };
  return { status: "succeeded", text };
}

/**
 * A loop output as the text a participant reads.
 *
 * `null` and `undefined` render as nothing rather than as `"null"`: serializing them would post a
 * Message that looks like an answer and is not, which is worse for the reader than a turn that
 * plainly failed.
 */
function renderAnswer(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  const encoded = JSON.stringify(output);
  return typeof encoded === "string" ? encoded : "";
}
