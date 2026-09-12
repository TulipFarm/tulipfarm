import { randomUUID } from "node:crypto";
import type { ModelFailureDiagnostic, ModelRequirementsPolicy } from "@tulipfarm/agent-runtime";
import { readTurnAttachment, type TurnAttachmentStore } from "@tulipfarm/files";
import { type InvocationPrincipal, SUBAGENT_RUN_SOURCE } from "@tulipfarm/run-kernel";
import {
  contentText,
  type MessageContent,
  type ParticipantToolCall,
  textContent,
} from "@tulipfarm/schema";
import type { PersistedRunEvent } from "@tulipfarm/storage";
import type { HostedAgent } from "@tulipfarm/tool-host";
import { fromToolResult } from "../chat/messages";
import type {
  AssistantMessageWriteResult,
  CompleteTurnResult,
  ConversationStore,
  PersistedTurn,
  TurnCompletion,
  TurnCompletionStatus,
} from "../conversations/service";

/** Internal Worker host for Conversation, Tool, Memory, and completion ports. */

/** The Run source whose Context comes from a request Artifact rather than a Conversation. */

/** Narrow read of one Run. `@tulipfarm/storage`'s `RunStore` satisfies it. */
export interface HostedRunReader {
  find(
    businessId: string,
    runId: string
  ): Promise<{
    readonly status: string;
    readonly source: string;
    readonly bundle: { readonly digest: string; readonly routineId: string };
    readonly identity: { readonly effectiveSubject: InvocationPrincipal };
  } | null>;
}

export type TurnAuthorityDenial =
  | "run_not_found"
  | "run_not_running"
  | "turn_not_found"
  | "agent_not_found"
  | "agent_use_denied";

export class TurnAuthorityError extends Error {
  readonly name = "TurnAuthorityError";

  constructor(readonly code: TurnAuthorityDenial) {
    super(code);
  }
}

/**
 * What every Run-scoped internal call may rely on. Deliberately Conversation-free: a Routine Run
 * and a sub-agent Run both have no Turn, so a path that does not need one must not be typed as if
 * it did.
 */
export interface RunAuthority {
  readonly businessId: string;
  readonly runId: string;
  /** Whom the turn acts as, as recorded when the Run was minted. */
  readonly subject: InvocationPrincipal;
  /** Worker executor kind; determines which Artifact carries the request payload. */
  readonly source: string;
  /** The Run's bundle digest, recorded on the Context manifest as what produced this Context. */
  readonly bundleDigest: string;
  /**
   * The Routine this Run executes, when it executes one.
   *
   * The Routine-only Tool `complete_state` refuses a call that names no Routine, so a Routine
   * Agent State cannot complete itself without this reaching the Worker.
   */
  readonly routineId?: string;
  /**
   * The Agent this Run routes to. Resolved here because only the control plane holds the Soul;
   * the durable runtime hosts Tools without one and would otherwise dispatch them unrestricted.
   */
  readonly agent?: HostedAgent;
  /**
   * The Conversation Turn this Run answers, absent only for a Run whose source has none.
   *
   * Optional here and required on {@link TurnAuthority}, so a path that genuinely needs a Turn
   * states that in its type rather than reaching for one that may not exist.
   */
  readonly turn?: PersistedTurn;
}

/** A Run that is answering a Conversation Turn. The Turn is what makes it a *Turn* authority. */
export interface TurnAuthority extends RunAuthority {
  readonly turn: PersistedTurn;
}

/** Everything the model needs for one turn. Mirrors the Worker's `ResolvedTurnContext`. */
export interface HostedTurnContext {
  readonly agentId: string;
  /** Whom the turn acts as. Taken from the Run, so a guard is told who it is guarding. */
  readonly subjectId: string;
  readonly modelProfileId: string;
  /** Governance the Agent requires of the model serving this turn; absent means no demand. */
  readonly modelPolicy?: ModelRequirementsPolicy;
  /** Whom the turn acts as, kind included. `subjectId` alone cannot name a principal. */
  readonly principal?: { readonly kind: string; readonly id: string };
  readonly contextDigest: string;
  readonly guardrailDigest: string;
  /** Validated guardrail policy named by digest; Worker enforces it without reading Soul. */
  readonly guardrailPolicy: Record<string, unknown>;
  readonly messages: readonly { readonly role: string; readonly content: MessageContent }[];
  /**
   * The Files this Turn may send to the model, re-authorized at assembly time.
   *
   * Names only — bytes are fetched separately, because this context crosses an HTTP boundary as
   * JSON and base64 would put a whole image through a response schema on every Turn.
   */
  readonly attachments?: readonly {
    readonly fileId: string;
    readonly mediaType: string;
    readonly name: string;
  }[];
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Record<string, unknown>;
    /** The Tool's tier, so the tool-call guard can refuse a whole category rather than a name. */
    readonly tier: string;
    /**
     * Whether the Tool has an effect. Carried because Skill narrowing may hide a read and never a
     * write (#419), and the loop cannot tell them apart once this crosses the wire.
     */
    readonly mutating?: boolean;
    /**
     * Whether a repeated call performs a genuine new real-world effect rather than reproducing
     * the same state (#646). Carried for the same reason `mutating` is: the loop cannot tell once
     * this crosses the wire.
     */
    readonly sideEffecting?: boolean;
    /**
     * Whether a repeated call within one Turn may be served from a cache instead of dispatched
     * again. Carried for the same reason `sideEffecting` is: the loop cannot tell once this
     * crosses the wire.
     */
    readonly cacheable?: boolean;
  }[];
  readonly limits: {
    readonly maxIterations: number;
    readonly maxToolCalls: number;
    readonly maxRepairAttempts: number;
  };
  readonly compacted: boolean;
  /** Narrows later tool offers after a successful `skill` load for a listed Skill. */
  readonly skillToolScopes?: Record<string, readonly string[]>;
}

export interface TurnContextResolver {
  resolve(authority: TurnAuthority): Promise<HostedTurnContext>;
}

/** Assembles the Context for a Conversation-less sub-agent Run from its request Artifact. */
export interface SubagentContextResolver {
  resolve(authority: RunAuthority): Promise<HostedTurnContext>;
}

/** Identifies the Turn and attempt this Run answers; the Worker holds only the Run id. */
export interface HostedTurnIdentity {
  readonly turnId: string;
  readonly conversationId: string;
  readonly attempt: number;
  /** The Run this attempt supersedes, so a retry can reread what the failed attempt already did. */
  readonly previousRunId?: string;
  /** Participant-safe activity already durable for this attempt. */
  readonly history?: HostedTurnHistory;
}

export interface HostedTurnHistory {
  readonly text: string;
  readonly toolCalls: readonly ParticipantToolCall[];
  readonly surfaces: readonly { readonly artifactId: string; readonly revision: number }[];
  readonly cursor: number;
  readonly outcome: "active" | "waiting" | "succeeded" | "failed" | "cancelled";
  readonly complete: boolean;
  readonly wait?:
    | {
        readonly kind: "approval";
        readonly waitId: string;
        readonly approvalId: string;
        readonly callId: string;
      }
    | {
        readonly kind: "child";
        readonly waitId: string;
        readonly childRunId: string;
        readonly callId: string;
      };
}

export interface HostedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  /** The Run State this call executes in; a Tool that parks registers its wait against it. */
  readonly stateId?: string;
  readonly activeSkillName?: string;
  /** The Agent a Turnless Run claims to act as; confirmed against the Soul before it is honoured. */
  readonly agentName?: string;
  /** A Routine State's authored ceiling. Narrowing only — see `HostedToolCall` in tool-host. */
  readonly permissionCeiling?: { readonly maxRiskClass?: string };
}

/** Mirrors the loop's `ToolDispatchResult`, minus the `callId` the caller already holds. */
export type HostedToolResult =
  | { readonly status: "succeeded"; readonly output: unknown }
  | { readonly status: "denied"; readonly reason: string; readonly connectUrl?: string }
  | { readonly status: "invalid_arguments"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "awaiting_approval"; readonly approvalId: string }
  | {
      /** The Tool spawned a child Run and registered the wait that resumes this Turn. */
      readonly status: "awaiting_child";
      readonly childRunId: string;
      readonly waitId: string;
    };

export interface TurnToolDispatcher {
  dispatch(authority: RunAuthority, call: HostedToolCall): Promise<HostedToolResult>;
}

/** Parks a Run only after the Worker has stopped executing and requested approval. */
export interface TurnApprovalRegistrar {
  registerWait(
    authority: RunAuthority,
    input: { readonly stateKey: string; readonly approvalId: string }
  ): Promise<{ waitId: string }>;
}

export interface InternalTurnHostOptions {
  readonly runs: HostedRunReader;
  readonly store: ConversationStore;
  /** Participant-only Run events used to recover activity written after the latest checkpoint. */
  readonly events?: {
    list(
      businessId: string,
      runId: string,
      options: { after: number; audiences: readonly ["participant"]; limit: number }
    ): Promise<readonly PersistedRunEvent[]>;
  };
  readonly context: TurnContextResolver;
  /** Absent leaves a deployment unable to execute sub-agent Runs, rather than silently unguarded. */
  readonly subagentContext?: SubagentContextResolver;
  readonly tools: TurnToolDispatcher;
  readonly approvals?: TurnApprovalRegistrar;
  /**
   * Resolves the Agent one Run routes to, from the Soul. Absent in a deployment with no Soul; the
   * authority then names no Agent and every host falls back to its own default, as before.
   */
  readonly agentForRun?: (
    businessId: string,
    runId: string,
    source: string,
    /** The Agent the caller claims to act as; honoured only where the Soul confirms it. */
    claimedAgentName?: string
  ) => Promise<HostedAgent | undefined>;
  /**
   * The Tools an Agent may be offered, for a Run that assembles its own context.
   *
   * A Chat Turn gets this inside `context.resolve`; a Routine Agent State assembles its context in
   * the durable runtime and needs only the catalog. Composed from the same registry and the same
   * visibility rules, so a Routine can never see a wider catalog than the same Agent sees in Chat.
   */
  readonly agentTools?: (agentName: string | undefined) => readonly HostedAgentTool[];
  /**
   * Serves the bytes of a File this Turn attached. Absent leaves Turns attachment-free.
   *
   * Separate from `context` because bytes cannot ride in a JSON context response, and separate
   * from the public File routes because the Worker acts as a Run, not as a session.
   */
  readonly files?: TurnAttachmentStore;
  newId?(): string;
  now?(): Date;
}

/** One Tool as the Agent loop exposes it to the model. */
export interface HostedAgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly tier?: string;
  readonly mutating?: boolean;
}

/** Only running Runs may be controlled; this prevents racing completion from being reopened. */
const OPERABLE_RUN_STATUS = "running";

/** Run sources that never mint a Turn, so a missing Turn row is their normal shape. */
const TURNLESS_RUN_SOURCES: ReadonlySet<string> = new Set(["routine", SUBAGENT_RUN_SOURCE]);

export class InternalTurnHost {
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: InternalTurnHostOptions) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Resolves Run authority by Run id, so the Worker cannot pick another Turn.
   *
   * Turn-optional by design: a Routine Run answers no conversation and a sub-agent Run answers
   * into an Artifact, so neither has a Turn row to find. Authority never came from the Turn, and
   * demanding one here is what left Routine States and sub-agents unable to dispatch a Tool.
   */
  async authority(
    businessId: string,
    runId: string,
    claimedAgentName?: string
  ): Promise<RunAuthority> {
    const run = await this.options.runs.find(businessId, runId);
    if (run === null) throw new TurnAuthorityError("run_not_found");
    if (run.status !== OPERABLE_RUN_STATUS) throw new TurnAuthorityError("run_not_running");

    // Every other source is Conversation-backed, so a missing Turn is a broken Run rather than a
    // Run that never had one. Failing open here would silently widen the Turn-free path to Runs
    // that are meant to be denied.
    const turn = await this.options.store.findTurnByRunId(businessId, runId);
    if (turn === undefined && !TURNLESS_RUN_SOURCES.has(run.source)) {
      throw new TurnAuthorityError("turn_not_found");
    }

    const agent = await this.options.agentForRun?.(businessId, runId, run.source, claimedAgentName);
    return {
      businessId,
      runId,
      ...(turn === undefined ? {} : { turn }),
      subject: run.identity.effectiveSubject,
      source: run.source,
      bundleDigest: run.bundle.digest,
      // Every Run records a `routineId`, but only a Routine Run's names a Routine: every other
      // source parks its own name there.
      ...(run.source === "routine" ? { routineId: run.bundle.routineId } : {}),
      ...(agent === undefined ? {} : { agent }),
    };
  }

  /**
   * Run authority that is required to name a Turn.
   *
   * Everything conversation-shaped — history, attachments, completion, assistant Messages — is
   * meaningless without one, so those paths refuse rather than inventing a conversation.
   */
  private async turnAuthority(businessId: string, runId: string): Promise<TurnAuthority> {
    const authority = await this.authority(businessId, runId);
    if (authority.turn === undefined) throw new TurnAuthorityError("turn_not_found");
    return { ...authority, turn: authority.turn };
  }

  /**
   * The Tool catalog for a Run acting as `claimedAgentName`.
   *
   * Reads authority first so the claim is confirmed against the Soul before it selects anything;
   * a claim the Soul does not confirm resolves to no Agent and takes the default catalog.
   */
  async agentTools(
    businessId: string,
    runId: string,
    claimedAgentName?: string
  ): Promise<readonly HostedAgentTool[]> {
    const authority = await this.authority(businessId, runId, claimedAgentName);
    return this.options.agentTools?.(authority.agent?.name) ?? [];
  }

  async describeTurn(businessId: string, runId: string): Promise<HostedTurnIdentity> {
    const { turn } = await this.turnAuthority(businessId, runId);
    // The newest superseded Run is the attempt this one replaces. Older entries are earlier
    // attempts whose work a later one already had the chance to carry forward.
    const previousRunId = turn.supersededRunIds.at(-1);
    return {
      turnId: turn.id,
      conversationId: turn.conversationId,
      attempt: turn.attempt,
      ...(previousRunId === undefined ? {} : { previousRunId }),
      ...(await this.attemptHistory(turn, runId)),
    };
  }

  async resolveContext(businessId: string, runId: string): Promise<HostedTurnContext> {
    const base = await this.authority(businessId, runId);
    if (base.source === SUBAGENT_RUN_SOURCE) {
      const subagent = this.options.subagentContext;
      if (subagent === undefined) {
        throw new TurnAuthorityError("turn_not_found");
      }
      return subagent.resolve(base);
    }
    return this.options.context.resolve(await this.turnAuthority(businessId, runId));
  }

  /** Delegates to the File domain, which owns whether this Turn may have these bytes. */
  async readAttachment(
    businessId: string,
    runId: string,
    fileId: string
  ): Promise<{ mediaType: string; sizeBytes: number; body: AsyncIterable<Uint8Array> } | null> {
    const files = this.options.files;
    if (files === undefined) return null;

    const { turn, subject } = await this.turnAuthority(businessId, runId);
    return readTurnAttachment({
      files,
      messages: await this.options.store.listMessages(businessId, turn.conversationId),
      businessId,
      turnId: turn.id,
      fileId,
      principalId: subject.id,
    });
  }

  async dispatchTool(
    businessId: string,
    runId: string,
    call: HostedToolCall
  ): Promise<HostedToolResult> {
    // `authority`, not `turnAuthority`: a sub-agent Run holds Tools but no Conversation Turn.
    return this.options.tools.dispatch(
      await this.authority(businessId, runId, call.agentName),
      call
    );
  }

  /** Registers the approval wait under the Run's minted subject, not Worker-supplied identity. */
  async registerApprovalWait(
    businessId: string,
    runId: string,
    input: { stateKey: string; approvalId: string }
  ): Promise<{ waitId: string }> {
    if (this.options.approvals === undefined) {
      throw new Error("no approval registrar is configured on the internal turn host");
    }
    return this.options.approvals.registerWait(await this.authority(businessId, runId), input);
  }

  async findCompletion(
    businessId: string,
    runId: string,
    attempt: number
  ): Promise<TurnCompletion | undefined> {
    const { turn } = await this.turnAuthority(businessId, runId);
    return this.options.store.findCompletion(businessId, turn.id, attempt);
  }

  /** Writes the assistant Message before naming it in Turn completion. */
  async appendAssistantMessage(input: {
    businessId: string;
    runId: string;
    attempt: number;
    leaseGeneration: number;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<AssistantMessageWriteResult> {
    const { turn } = await this.turnAuthority(input.businessId, input.runId);
    const messageId = this.newId();
    const appended = await this.options.store.appendAssistantMessage({
      message: {
        id: messageId,
        businessId: input.businessId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        role: "assistant",
        content: textContent(input.content),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        attempt: input.attempt,
        createdAt: this.now(),
      },
      runId: input.runId,
      attempt: input.attempt,
      expectedLeaseGeneration: input.leaseGeneration,
    });
    return appended;
  }

  private async attemptHistory(
    turn: PersistedTurn,
    runId: string
  ): Promise<{ history?: HostedTurnHistory }> {
    const message = await this.options.store.findAttemptMessage?.(
      turn.businessId,
      turn.id,
      turn.attempt
    );
    let history = historyFromMessage(message?.content, message?.metadata, runId, turn.attempt);
    const events = this.options.events;
    if (events === undefined) {
      return history.cursor === 0 &&
        history.text.length === 0 &&
        history.toolCalls.length === 0 &&
        history.surfaces.length === 0
        ? {}
        : { history };
    }

    while (true) {
      const page = await events.list(turn.businessId, runId, {
        after: history.cursor,
        audiences: ["participant"],
        limit: 500,
      });
      for (const event of page) history = foldParticipantEvent(history, event);
      if (page.length < 500) break;
    }
    return history.cursor === 0 &&
      history.text.length === 0 &&
      history.toolCalls.length === 0 &&
      history.surfaces.length === 0
      ? {}
      : { history };
  }

  async completeTurn(input: {
    businessId: string;
    runId: string;
    attempt: number;
    leaseGeneration: number;
    status: TurnCompletionStatus;
    cursor: number;
    messageId: string | null;
    surfaces?: readonly { artifactId: string; revision: number }[];
    reason?: string;
    modelFailure?: ModelFailureDiagnostic;
  }): Promise<Pick<CompleteTurnResult, "status">> {
    const { turn } = await this.turnAuthority(input.businessId, input.runId);
    const now = this.now();
    const result = await this.options.store.completeTurn({
      completion: {
        businessId: input.businessId,
        turnId: turn.id,
        attempt: input.attempt,
        status: input.status,
        messageId: input.messageId,
        cursor: input.cursor,
        createdAt: now,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.modelFailure === undefined ? {} : { modelFailure: input.modelFailure }),
      },
      runId: input.runId,
      expectedLeaseGeneration: input.leaseGeneration,
      ...(input.surfaces?.length
        ? {
            surfaceMessage: fromToolResult(
              turn.conversationId,
              input.surfaces.map((surface) => ({
                type: "surface" as const,
                artifactId: surface.artifactId,
                revision: surface.revision,
              }))
            ),
          }
        : {}),
    });
    return { status: result.status };
  }
}

export function historyFromMessage(
  content: MessageContent | undefined,
  metadata: Record<string, unknown> | undefined,
  runId: string,
  attempt: number
): HostedTurnHistory {
  const attemptMeta = record(metadata?.turnAttempt);
  const cursor = attemptMeta?.cursor;
  const belongsToAttempt =
    attemptMeta?.runId === runId && attemptMeta.attempt === attempt && typeof cursor === "number";
  if (!belongsToAttempt) {
    return {
      text: "",
      toolCalls: [],
      surfaces: [],
      cursor: 0,
      outcome: "active",
      complete: false,
    };
  }
  const wait = waitFrom(attemptMeta.wait);
  return {
    text: content === undefined ? "" : contentText(content),
    toolCalls: participantToolCalls(metadata?.toolCalls),
    surfaces: surfaceRefs(metadata?.surfaces),
    cursor,
    outcome: historyOutcome(attemptMeta.outcome),
    complete: attemptMeta.complete === true,
    ...(wait === undefined ? {} : { wait }),
  };
}

export function foldParticipantEvent(
  history: HostedTurnHistory,
  event: PersistedRunEvent
): HostedTurnHistory {
  let text = history.text;
  let wait = history.wait;
  const toolCalls = history.toolCalls.map((call) => ({ ...call }));
  const surfaces = history.surfaces.map((surface) => ({ ...surface }));
  const payload = event.payload;
  if (event.eventType === "text.delta" && typeof payload.text === "string") {
    text += payload.text;
  }
  if (
    event.eventType === "tool.call" &&
    typeof payload.callId === "string" &&
    typeof payload.name === "string"
  ) {
    const existing = toolCalls.findIndex((call) => call.callId === payload.callId);
    const argsPreview = preview(payload.argsPreview);
    const next: ParticipantToolCall = {
      ...(existing < 0 ? { callId: payload.callId, name: payload.name } : toolCalls[existing]),
      name: payload.name,
      ...(typeof payload.argsDigest === "string" ? { argsDigest: payload.argsDigest } : {}),
      ...(argsPreview === undefined ? {} : { argsPreview }),
      ...(typeof payload.batchId === "string" ? { batchId: payload.batchId } : {}),
    };
    if (existing < 0) toolCalls.push(next);
    else toolCalls[existing] = next;
  }
  if (
    event.eventType === "tool.result" &&
    typeof payload.callId === "string" &&
    (payload.status === "ok" || payload.status === "error")
  ) {
    const existing = toolCalls.findIndex((call) => call.callId === payload.callId);
    if (existing >= 0) {
      const resultPreview = preview(payload.resultPreview);
      toolCalls[existing] = {
        ...toolCalls[existing],
        outcome: payload.status,
        ...(resultPreview === undefined ? {} : { resultPreview }),
        ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
        ...(typeof payload.errorCode === "string" ? { errorCode: payload.errorCode } : {}),
      };
    }
  }
  if (
    event.eventType === "approval.requested" &&
    typeof payload.waitId === "string" &&
    typeof payload.intentId === "string" &&
    typeof payload.callId === "string"
  ) {
    wait = {
      kind: "approval",
      waitId: payload.waitId,
      approvalId: payload.intentId,
      callId: payload.callId,
    };
  }
  if (
    event.eventType === "child.started" &&
    typeof payload.waitId === "string" &&
    typeof payload.childRunId === "string" &&
    typeof payload.callId === "string"
  ) {
    wait = {
      kind: "child",
      waitId: payload.waitId,
      childRunId: payload.childRunId,
      callId: payload.callId,
    };
  }
  if (
    event.eventType === "surface.emitted" &&
    typeof payload.artifactId === "string" &&
    typeof payload.revision === "number" &&
    Number.isInteger(payload.revision) &&
    payload.revision > 0 &&
    !surfaces.some(
      (surface) =>
        surface.artifactId === payload.artifactId && surface.revision === payload.revision
    )
  ) {
    surfaces.push({ artifactId: payload.artifactId, revision: payload.revision });
  }
  return {
    ...history,
    text,
    toolCalls,
    surfaces,
    cursor: Math.max(history.cursor, event.sequence),
    ...(wait === undefined ? {} : { wait }),
  };
}

function participantToolCalls(value: unknown): ParticipantToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const call = record(item);
    if (typeof call?.callId !== "string" || typeof call.name !== "string") return [];
    const argsPreview = preview(call.argsPreview);
    const resultPreview = preview(call.resultPreview);
    return [
      {
        callId: call.callId,
        name: call.name,
        ...(typeof call.argsDigest === "string" ? { argsDigest: call.argsDigest } : {}),
        ...(argsPreview === undefined ? {} : { argsPreview }),
        ...(resultPreview === undefined ? {} : { resultPreview }),
        ...(typeof call.durationMs === "number" ? { durationMs: call.durationMs } : {}),
        ...(call.outcome === "ok" || call.outcome === "error" ? { outcome: call.outcome } : {}),
        ...(typeof call.errorCode === "string" ? { errorCode: call.errorCode } : {}),
        ...(typeof call.batchId === "string" ? { batchId: call.batchId } : {}),
      },
    ];
  });
}

function surfaceRefs(value: unknown): { artifactId: string; revision: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const surface = record(item);
    return typeof surface?.artifactId === "string" &&
      typeof surface.revision === "number" &&
      Number.isInteger(surface.revision) &&
      surface.revision > 0
      ? [{ artifactId: surface.artifactId, revision: surface.revision }]
      : [];
  });
}

function preview(value: unknown): ParticipantToolCall["argsPreview"] {
  const candidate = record(value);
  if (typeof candidate?.json !== "string") return undefined;
  return {
    json: candidate.json,
    ...(typeof candidate.bytes === "number" ? { bytes: candidate.bytes } : {}),
    ...(typeof candidate.truncated === "boolean" ? { truncated: candidate.truncated } : {}),
    ...(Array.isArray(candidate.redactedPaths) &&
    candidate.redactedPaths.every((path) => typeof path === "string")
      ? { redactedPaths: candidate.redactedPaths }
      : {}),
  };
}

function historyOutcome(value: unknown): HostedTurnHistory["outcome"] {
  return value === "waiting" || value === "succeeded" || value === "failed" || value === "cancelled"
    ? value
    : "active";
}

function waitFrom(value: unknown): HostedTurnHistory["wait"] {
  const wait = record(value);
  if (
    wait?.kind === "approval" &&
    typeof wait.waitId === "string" &&
    typeof wait.approvalId === "string" &&
    typeof wait.callId === "string"
  ) {
    return {
      kind: "approval",
      waitId: wait.waitId,
      approvalId: wait.approvalId,
      callId: wait.callId,
    };
  }
  if (
    wait?.kind === "child" &&
    typeof wait.waitId === "string" &&
    typeof wait.childRunId === "string" &&
    typeof wait.callId === "string"
  ) {
    return {
      kind: "child",
      waitId: wait.waitId,
      childRunId: wait.childRunId,
      callId: wait.callId,
    };
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
