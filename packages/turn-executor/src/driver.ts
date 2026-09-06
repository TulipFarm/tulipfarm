import type {
  AgentLoopInput,
  AgentLoopLimits,
  ExposedTool,
  ModelMessage,
  ModelRequirementsPolicy,
  ResolvedAttachment,
} from "@tulipfarm/agent-runtime";
import type { StateStatus } from "@tulipfarm/run-kernel";
import type { AgentStateRequest, AgentStateResult, AgentStateRunner } from "./agent-state";
import type {
  CompleteTurnResult,
  ConversationTurnCompleter,
  TurnOutcome,
} from "./conversation-turn";
import type { TurnGuardrails } from "./guardrails";
import type { ModelCallReceipt, RunOutcome, SpendSink } from "./ports";
import type { TurnEventWriter } from "./run-events";

/** Orders one turn; emit `turn.finished` only after completion is durable. */

/** The turn to execute, as the executor read it out of the Run's request Artifact. */
export interface TurnRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  /** Observed State status; the driver must not invent a claim. */
  readonly stateStatus: StateStatus;
  readonly turnId: string;
  readonly conversationId: string;
  readonly attempt: number;
  /** Highest attempt the Turn has; a lower one arriving late is stale and writes nothing. */
  readonly latestAttempt?: number;
}

/** One turn's resolved model context; implementation stays behind this port. */
export interface ResolvedTurnContext {
  readonly agentId: string;
  /** Whom the turn acts as, as the Run recorded it. Guards are told who they are guarding. */
  readonly subjectId: string;
  readonly modelProfileId: string;
  /** Governance the Agent requires of the model serving this turn; absent means no demand. */
  readonly modelPolicy?: ModelRequirementsPolicy;
  /** Whom the turn acts as, kind included, so a model call can use that principal's credential. */
  readonly principal?: { readonly kind: string; readonly id: string };
  readonly contextDigest: string;
  readonly guardrailDigest: string;
  /** The validated guardrail policy `guardrailDigest` names, rebuilt into guards here. */
  readonly guardrailPolicy: Record<string, unknown>;
  readonly messages: readonly ModelMessage[];
  /**
   * The Files this Turn attached, named rather than carried.
   *
   * Names only: this context crosses an HTTP boundary as JSON, so bytes are fetched separately
   * through {@link TurnAttachmentPort}.
   */
  readonly attachments?: readonly {
    readonly fileId: string;
    readonly mediaType: string;
    readonly name: string;
  }[];
  /** Tools plus guard tier; the loop/model see only `ExposedTool`. */
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

/**
 * Fetches the bytes of one File the resolved Context named, and reads what it says.
 *
 * Separate from `TurnContextPort` because the far side re-authorizes per File at the moment the
 * bytes are read, rather than handing out everything a Turn might want up front.
 *
 * `extract` sits on this same port, rather than beside it, so that a host cannot supply Files
 * without also supplying the means to screen them. An uploaded document is the widest
 * indirect-injection channel this product has; an optional extractor would let any host silently
 * turn that screening off, which is the one thing this arrangement exists to prevent.
 *
 * `turn-executor` cannot do the reading itself: only the side that owns the File domain can say
 * what a PDF says, and parsing a hostile document belongs in a process that may be crashed by one.
 */
export interface TurnAttachmentPort {
  read(runId: string, fileId: string): Promise<Uint8Array | undefined>;
  /**
   * The File's words, for the guards only — never for the model, which is sent the bytes.
   *
   * `undefined` means this File offers a text guard nothing to read, as an image or a scan does.
   * It never means screening was skipped.
   */
  extract(mediaType: string, bytes: Uint8Array): Promise<string | undefined>;
}

/** A fetched File paired with the text the guards screen for it, if it offered any. */
interface ScreenableAttachment {
  readonly file: ResolvedAttachment;
  readonly text?: string;
}

export interface TurnDriverOptions {
  readonly states: AgentStateRunner;
  readonly context: TurnContextPort;
  readonly completer: ConversationTurnCompleter;
  /** Required guards; configured here because only resolved Context names their subject. */
  readonly guardrails: TurnGuardrails;
  /** One writer per attempt — it keys events by the attempt it was built with. */
  buildEvents(request: TurnRequest): TurnEventWriter;
  /** Optional model receipt; omit it rather than report a model the port cannot name. */
  modelReceipt?(): ModelCallReceipt | undefined;
  /** Where finished turns are reported as spend. Best-effort; never blocks the turn. */
  readonly spend?: SpendSink;
  /** Fetches attached File bytes. Absent leaves every Turn attachment-free. */
  readonly attachments?: TurnAttachmentPort;
}

/** What a finished turn is attributed to, carried rather than held so no state outlives a run. */
interface TurnSpendScope {
  readonly startedAt: number;
  readonly agentId: string;
  readonly conversationId: string;
  readonly principal?: { readonly kind: string; readonly id: string };
}

export class TurnDriver {
  constructor(private readonly options: TurnDriverOptions) {}

  async run(request: TurnRequest): Promise<RunOutcome> {
    if (this.options.completer.isStale(request)) {
      // Superseded attempts must not spend model/tool work.
      return { status: "succeeded" };
    }

    const startedAt = Date.now();
    const events = this.options.buildEvents(request);
    const context = await this.options.context.resolve(request);
    const spend: TurnSpendScope = {
      startedAt,
      agentId: context.agentId,
      conversationId: request.conversationId,
      principal: context.principal,
    };

    // Verify guard policy digest before the first event; no misnamed guards may run.
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

    // Bytes are fetched before the guard runs because nothing can screen text it has not read.
    // This costs no vendor call: the Files come from this deployment, so a refused Turn still
    // reaches no provider, which is the property the guard-first ordering exists to protect.
    const resolved = await this.resolveAttachments(request.runId, context);

    // Input guard runs before model/tool work; a block settles the State with the guard reply.
    const guarded = await this.guardInput(context, resolved, events);
    if (guarded.blocked) {
      return this.complete(
        request,
        events,
        await this.options.states.settle(stateRequest, guarded.message),
        spend
      );
    }

    const attachments = resolved.map((each) =>
      each.text === undefined ? each.file : { ...each.file, text: each.text }
    );

    const input: AgentLoopInput = {
      businessId: request.businessId,
      runId: request.runId,
      stateId: request.stateKey,
      modelProfileId: context.modelProfileId,
      ...(context.modelPolicy === undefined ? {} : { modelPolicy: context.modelPolicy }),
      ...(context.principal === undefined ? {} : { principal: context.principal }),
      agentId: context.agentId,
      contextDigest: context.contextDigest,
      guardrailDigest: context.guardrailDigest,
      messages: guarded.messages,
      ...(attachments.length === 0 ? {} : { attachments }),
      tools: context.tools,
      limits: context.limits,
      ...(context.skillToolScopes === undefined
        ? {}
        : { skillToolScopes: new Map(Object.entries(context.skillToolScopes)) }),
    };
    const result = await this.options.states.execute(stateRequest, input);

    if (result.status === "cancelled") {
      // Cancellation manager owns this Run; do not record another outcome.
      return { status: "cancelled" };
    }

    if (result.status === "needs_reconciliation") {
      // An effect may have landed; reconciliation must decide.
      await events.emit(
        "turn.finished",
        { status: "failed", messageId: null, reason: "needs_reconciliation" },
        "finished"
      );
      return { status: "needs_reconciliation" };
    }

    if (result.status === "waiting") {
      if (result.reason === "child_running") {
        await events.emit(
          "child.started",
          { waitId: result.waitId, childRunId: result.childRunId, callId: result.callId },
          "child"
        );
        return { status: "waiting" };
      }
      await events.emit(
        "approval.requested",
        { waitId: result.waitId, intentId: result.approvalId, callId: result.callId },
        "approval"
      );
      return { status: "waiting" };
    }

    return this.complete(request, events, result, spend);
  }

  /**
   * Fetches bytes for the Files the Context named, dropping any the far side refuses.
   *
   * A refusal is dropped rather than failing the Turn because the far side answers the same way
   * for a File this Turn never attached and one whose authority was revoked since. Failing on it
   * would let a revoked File break a Turn that has other content to work with, and the Agent
   * still has the person's text.
   *
   * The File and its screenable text are kept apart here because only some of each pair travels:
   * the guards read every text, whereas the adapter sends a File either as bytes or as its text,
   * per media type. Pairing them keeps that choice where it belongs — with the adapter that knows
   * what the provider will accept — rather than deciding it before either is needed.
   */
  private async resolveAttachments(
    runId: string,
    context: ResolvedTurnContext
  ): Promise<ScreenableAttachment[]> {
    const port = this.options.attachments;
    const refs = context.attachments ?? [];
    if (port === undefined || refs.length === 0) return [];

    const fetched = await Promise.all(
      refs.map(async (ref) => {
        const data = await port.read(runId, ref.fileId);
        if (data === undefined) return undefined;
        // Extracted as the type the Context authorized, not as whatever the bytes claim to be.
        const text = await port.extract(ref.mediaType, data);
        return { file: { ...ref, data }, ...(text === undefined ? {} : { text }) };
      })
    );
    return fetched.filter((each) => each !== undefined);
  }

  /** Guard only the latest user message; transforms affect the model, not persisted history. */
  private async guardInput(
    context: ResolvedTurnContext,
    attachments: readonly ScreenableAttachment[],
    events: TurnEventWriter
  ): Promise<
    | { readonly blocked: true; readonly message: string }
    | { readonly blocked: false; readonly messages: readonly ModelMessage[] }
  > {
    let index = context.messages.length - 1;
    while (index >= 0 && context.messages[index]?.role !== "user") index -= 1;
    const current = index < 0 ? undefined : context.messages[index];
    if (current === undefined) return { blocked: false, messages: context.messages };

    const guarded = await this.options.guardrails.input(
      current.content,
      events,
      attachments.map((each) => each.text).filter((text) => text !== undefined)
    );
    if (guarded.blocked) return guarded;

    const messages = [...context.messages];
    messages[index] = { role: current.role, content: guarded.content };
    return { blocked: false, messages };
  }

  private async complete(
    request: TurnRequest,
    events: TurnEventWriter,
    result: Extract<AgentStateResult, { status: "succeeded" | "failed" | "input_required" }>,
    spend: TurnSpendScope
  ): Promise<RunOutcome> {
    const completion = await this.options.completer.complete({
      businessId: request.businessId,
      runId: request.runId,
      conversationId: request.conversationId,
      turnId: request.turnId,
      attempt: request.attempt,
      cursor: events.cursor,
      outcome: await this.guardOutput(turnOutcome(result), events),
      ...(events.toolCalls.length === 0 ? {} : { metadata: { toolCalls: events.toolCalls } }),
      ...(events.surfaces.length === 0 ? {} : { surfaces: events.surfaces }),
      ...(request.latestAttempt === undefined ? {} : { latestAttempt: request.latestAttempt }),
    });

    return this.finish(events, completion, spend);
  }

  /** Guard output before it is durable; blocked answers are replaced, not dropped. */
  private async guardOutput(outcome: TurnOutcome, events: TurnEventWriter): Promise<TurnOutcome> {
    if (outcome.status !== "succeeded") return outcome;
    const guarded = await this.options.guardrails.output(outcome.text, events);
    return { status: "succeeded", text: guarded.blocked ? guarded.message : guarded.text };
  }

  private async finish(
    events: TurnEventWriter,
    completion: CompleteTurnResult,
    spend: TurnSpendScope
  ): Promise<RunOutcome> {
    if (completion.status === "stale") {
      // A newer attempt already answered; do not announce this one.
      return { status: "succeeded" };
    }

    if (completion.status === "succeeded") {
      const receipt = this.options.modelReceipt?.();
      await events.emit(
        "turn.finished",
        { status: "succeeded", messageId: completion.messageId, ...(receipt ?? {}) },
        "finished"
      );
      this.reportTurn(spend, "ok");
      return { status: "succeeded" };
    }

    if (completion.status === "failed") {
      await events.emit(
        "turn.finished",
        {
          status: "failed",
          messageId: null,
          reason: completion.reason,
          ...(completion.modelFailure === undefined
            ? {}
            : { modelFailure: completion.modelFailure }),
        },
        "finished"
      );
      this.reportTurn(spend, "error");
      // `completion.reason` is always an `AgentLoopFailureReason` (or `"empty_model_output"`) —
      // the same bounded value `AgentStateRunner` already writes as the State's own
      // `error_evidence_ref` — never model output or a raw exception message.
      return { status: "failed", errorEvidenceRef: `agent:${completion.reason}` };
    }

    // `waiting` cannot appear after completion is attempted.
    throw new Error(`turn completion returned an unexpected status "${completion.status}"`);
  }

  /** Records the turn in the spend ledger; the reliability half of the dashboard reads this. */
  private reportTurn(spend: TurnSpendScope, status: "ok" | "error"): void {
    this.options.spend?.recordTurn({
      status,
      durationMs: Math.max(0, Date.now() - spend.startedAt),
      agentId: spend.agentId,
      conversationId: spend.conversationId,
      principal: spend.principal,
    });
  }
}

/** Serialize structured output; empty output fails instead of writing a blank Message. */
function turnOutcome(
  result: Extract<AgentStateResult, { status: "succeeded" | "failed" | "input_required" }>
): TurnOutcome {
  if (result.status === "failed") {
    return {
      status: "failed",
      reason: result.reason,
      ...(result.modelFailure === undefined ? {} : { modelFailure: result.modelFailure }),
    };
  }
  if (result.status === "input_required") return { status: "input_required", text: result.text };
  const text = renderAnswer(result.output);
  if (text.length === 0) return { status: "failed", reason: "empty_model_output" };
  return { status: "succeeded", text };
}

/** `null`/`undefined` are no answer; never render them as `"null"`. */
function renderAnswer(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  const encoded = JSON.stringify(output);
  return typeof encoded === "string" ? encoded : "";
}
