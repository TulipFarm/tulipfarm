import { randomUUID } from "node:crypto";
import type { ModelRequirementsPolicy } from "@tulipfarm/agent-runtime";
import type { InvocationPrincipal } from "@tulipfarm/run-kernel";
import type { ParticipantToolCall } from "@tulipfarm/schema";
import type {
  ConversationStore,
  PersistedTurn,
  TurnCompletion,
  TurnCompletionStatus,
} from "../conversations/service";

/** Internal Worker host for Conversation, Tool, Memory, and completion ports. */

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

export type TurnAuthorityDenial = "run_not_found" | "run_not_running" | "turn_not_found";

export class TurnAuthorityError extends Error {
  readonly name = "TurnAuthorityError";

  constructor(readonly code: TurnAuthorityDenial) {
    super(code);
  }
}

/** What one Run may do, taken from the Run itself rather than from whoever asked. */
export interface TurnAuthority {
  readonly businessId: string;
  readonly runId: string;
  readonly turn: PersistedTurn;
  /** Whom the turn acts as, as recorded when the Run was minted. */
  readonly subject: InvocationPrincipal;
  /** Worker executor kind; determines which Artifact carries the request payload. */
  readonly source: string;
  /** The Run's bundle digest, recorded on the Context manifest as what produced this Context. */
  readonly bundleDigest: string;
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
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Record<string, unknown>;
    /** The Tool's tier, so the tool-call guard can refuse a whole category rather than a name. */
    readonly tier: string;
  }[];
  readonly limits: {
    readonly maxIterations: number;
    readonly maxToolCalls: number;
    readonly maxRepairAttempts: number;
  };
  readonly compacted: boolean;
  /** Narrows later tool offers after a successful `load_skill` for a listed Skill. */
  readonly skillToolScopes?: Record<string, readonly string[]>;
}

export interface TurnContextResolver {
  resolve(authority: TurnAuthority): Promise<HostedTurnContext>;
}

/** Identifies the Turn and attempt this Run answers; the Worker holds only the Run id. */
export interface HostedTurnIdentity {
  readonly turnId: string;
  readonly conversationId: string;
  readonly attempt: number;
}

export interface HostedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** Mirrors the loop's `ToolDispatchResult`, minus the `callId` the caller already holds. */
export type HostedToolResult =
  | { readonly status: "succeeded"; readonly output: unknown }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "invalid_arguments"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "awaiting_approval"; readonly approvalId: string };

export interface TurnToolDispatcher {
  dispatch(authority: TurnAuthority, call: HostedToolCall): Promise<HostedToolResult>;
}

/** Parks a Run only after the Worker has stopped executing and requested approval. */
export interface TurnApprovalRegistrar {
  registerWait(
    authority: TurnAuthority,
    input: { readonly stateKey: string; readonly approvalId: string }
  ): Promise<{ waitId: string }>;
}

/** Narrow seam for memory extraction; the host must not read or approve Pending Memory. */
export interface TurnMemoryExtractor {
  extractFromTurn(request: {
    userId: string;
    agentId?: string;
    runId?: string;
    outcome?: string;
    messages: readonly { role: string; content: string }[];
  }): Promise<unknown>;
}

export interface InternalTurnHostOptions {
  readonly runs: HostedRunReader;
  readonly store: ConversationStore;
  readonly context: TurnContextResolver;
  readonly tools: TurnToolDispatcher;
  readonly approvals?: TurnApprovalRegistrar;
  /** Optional destination for completed-turn Memory mining. */
  readonly memory?: TurnMemoryExtractor;
  newId?(): string;
  now?(): Date;
}

/** Only running Runs may be controlled; this prevents racing completion from being reopened. */
const OPERABLE_RUN_STATUS = "running";

export class InternalTurnHost {
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: InternalTurnHostOptions) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /** Resolves Run authority by Run id, so the Worker cannot pick another Turn. */
  async authority(businessId: string, runId: string): Promise<TurnAuthority> {
    const run = await this.options.runs.find(businessId, runId);
    if (run === null) throw new TurnAuthorityError("run_not_found");
    if (run.status !== OPERABLE_RUN_STATUS) throw new TurnAuthorityError("run_not_running");

    const turn = await this.options.store.findTurnByRunId(businessId, runId);
    if (turn === undefined) throw new TurnAuthorityError("turn_not_found");

    return {
      businessId,
      runId,
      turn,
      subject: run.identity.effectiveSubject,
      source: run.source,
      bundleDigest: run.bundle.digest,
    };
  }

  async describeTurn(businessId: string, runId: string): Promise<HostedTurnIdentity> {
    const { turn } = await this.authority(businessId, runId);
    return { turnId: turn.id, conversationId: turn.conversationId, attempt: turn.attempt };
  }

  async resolveContext(businessId: string, runId: string): Promise<HostedTurnContext> {
    return this.options.context.resolve(await this.authority(businessId, runId));
  }

  async dispatchTool(
    businessId: string,
    runId: string,
    call: HostedToolCall
  ): Promise<HostedToolResult> {
    return this.options.tools.dispatch(await this.authority(businessId, runId), call);
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
    const { turn } = await this.authority(businessId, runId);
    return this.options.store.findCompletion(businessId, turn.id, attempt);
  }

  /** Writes the assistant Message before naming it in Turn completion. */
  async appendAssistantMessage(input: {
    businessId: string;
    runId: string;
    attempt: number;
    content: string;
    metadata?: { readonly toolCalls?: readonly ParticipantToolCall[] };
  }): Promise<{ messageId: string }> {
    const { turn } = await this.authority(input.businessId, input.runId);
    const messageId = this.newId();
    await this.options.store.appendMessage({
      id: messageId,
      businessId: input.businessId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      role: "assistant",
      content: input.content,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      attempt: input.attempt,
      createdAt: this.now(),
    });
    return { messageId };
  }

  async completeTurn(input: {
    businessId: string;
    runId: string;
    attempt: number;
    status: TurnCompletionStatus;
    cursor: number;
    messageId: string | null;
  }): Promise<void> {
    const { turn } = await this.authority(input.businessId, input.runId);
    await this.options.store.saveCompletion({
      businessId: input.businessId,
      turnId: turn.id,
      attempt: input.attempt,
      status: input.status,
      messageId: input.messageId,
      cursor: input.cursor,
      createdAt: this.now(),
    });
    // Late completion from a superseded attempt must not restate the Turn outcome.
    if (input.attempt < turn.attempt) return;
    await this.options.store.saveTurn({
      ...turn,
      status: input.status,
      // The reader's resume point moves with the answer, so a client reconnecting after the turn
      // ended asks for what follows this attempt rather than replaying it.
      cursor: input.cursor,
      updatedAt: this.now(),
    });
    this.mineForMemory(input.status, turn, input.runId);
  }

  /** Extracts Memory after completion for eligible user-owned chats only. */
  private mineForMemory(status: TurnCompletionStatus, turn: PersistedTurn, runId: string): void {
    const memory = this.options.memory;
    if (memory === undefined || status !== "succeeded") return;
    void (async () => {
      const { subject } = await this.authority(turn.businessId, runId);
      if (subject.kind !== "user") return;
      const messages = await this.options.store.listMessages(turn.businessId, turn.conversationId);
      await memory.extractFromTurn({
        userId: subject.id,
        runId,
        outcome: status,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
    })().catch(() => {
      // Inferring memory is best-effort; the turn it came from is already answered.
    });
  }
}
