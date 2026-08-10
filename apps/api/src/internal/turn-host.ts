import { randomUUID } from "node:crypto";
import type { InvocationPrincipal } from "@tulipfarm/run-kernel";
import type { ParticipantToolCall } from "@tulipfarm/schema";
import type {
  ConversationStore,
  PersistedTurn,
  TurnCompletion,
  TurnCompletionStatus,
} from "../conversations/service";

/**
 * The internal turn host (blocker §2, plan §3).
 *
 * The Worker executes turns but cannot reach the conversation history, the Soul artifacts, or the
 * Tool catalog — those still live in this app, and an app may not import another app. This is the
 * boundary it calls across, and its whole reason to exist is where authority comes from:
 *
 * **The caller states which Run, never as whom.** Every operation loads the Run and uses the
 * `effectiveSubject` recorded when the Run was minted. A worker credential is therefore a key to
 * *act on a Run*, not a principal — leaking it cannot widen what any turn is allowed to do.
 *
 * PR 4 replaces the implementations behind these ports with in-worker ones. The contract does not
 * move, so nothing the Worker calls changes when it does.
 */

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
  /**
   * Which Worker executor owns the Run — `chat`, `integration`, `routine`, and so on.
   *
   * It decides which Artifact holds the turn's parameters: a Chat Run's request *is* the Chat
   * request, while an Integration Run's request is a provider envelope that a classifier turned
   * into one. Taking it from the Run rather than from a caller-supplied hint is what keeps a
   * delivery from claiming to be an interactive turn. The invocation source (for example,
   * `manual` or `schedule`) remains separate audit/idempotency metadata.
   */
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
  readonly contextDigest: string;
  readonly guardrailDigest: string;
  /**
   * The validated guardrail policy `guardrailDigest` names.
   *
   * The Worker enforces the three stages and cannot read the Soul, so the policy travels with the
   * Context rather than being compiled twice from two sources. It rebuilds the identical guards and
   * refuses the turn if its own hash disagrees with the digest above.
   */
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
  /**
   * Per-Skill tool narrowing: once the loop sees a successful `load_skill` for a name present here,
   * later iterations offer only that Skill's declared list (plus the loop's own always-exposed
   * baseline) instead of the full `tools` catalog. Built from each loaded Skill's `tools:`
   * frontmatter; a Skill absent from this map is not narrowed. Context-size optimization only, not
   * an authorization boundary — `tools` above remains the ceiling `ToolDispatchPort` enforces.
   */
  readonly skillToolScopes?: Record<string, readonly string[]>;
}

export interface TurnContextResolver {
  resolve(authority: TurnAuthority): Promise<HostedTurnContext>;
}

/**
 * Which Turn a Run is answering, and on which attempt.
 *
 * The Worker holds only a Run id — the Turn was minted by this app when the request was submitted.
 * It needs these three before it can write a single event, because the event stream is keyed by
 * `(turnId, attempt)`; asking for them is also how it learns a Run it claimed has already been
 * superseded, since a superseded Run names no Turn.
 */
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

/**
 * Parks a Run on the durable wait for an approval it already requested.
 *
 * Called once the Worker's loop has actually stopped on the call, which is why it is not folded
 * into dispatch: a wait registered for a Run that then failed or was cancelled would be a resume
 * with nothing waiting for it.
 */
export interface TurnApprovalRegistrar {
  registerWait(
    authority: TurnAuthority,
    input: { readonly stateKey: string; readonly approvalId: string }
  ): Promise<{ waitId: string }>;
}

/**
 * The seam the memory extractor is supplied through.
 *
 * Narrow on purpose. The host must not be able to read a candidate, a confirmation, or anything
 * else about memory — it hands over a finished turn and learns nothing back, so a change in how
 * memory is inferred can never change how a turn completes.
 */
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
  /**
   * Where a completed turn goes to be mined for durable memory. Optional: absent simply means no
   * memory is ever inferred, which is the correct behaviour for a deployment that has not opted in.
   */
  readonly memory?: TurnMemoryExtractor;
  newId?(): string;
  now?(): Date;
}

/**
 * A Run may only be operated on while it is `running`.
 *
 * The dispatcher claims a Run to `running` before it hands the turn to an executor and leaves it
 * only when the turn is over, so this is exactly the window in which a live executor speaks. A Run
 * that already succeeded, failed, or is parked on a wait has no executor entitled to write for it —
 * a request naming one is a redelivery or a stale worker, and must not land an effect.
 */
const OPERABLE_RUN_STATUS = "running";

export class InternalTurnHost {
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: InternalTurnHostOptions) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Resolves what the named Run is allowed to do.
   *
   * The Turn is found **by Run id**, not by a Turn id the caller supplies. A Run superseded by a
   * `same_turn` retry no longer names the Turn, so a worker still executing it cannot be handed the
   * live Turn and write over the newer attempt's answer.
   */
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

  /**
   * Registers the durable wait a Run parks on, as the subject the Run was minted with.
   *
   * The Worker names the approval and the State; who may decide it is taken from the Run, exactly
   * as every other operation here — so a worker credential cannot widen an approval to a principal
   * the turn never acted as.
   */
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

  /**
   * Writes one attempt's reply.
   *
   * The Message is durable before any completion names it, and only a named Message is replayed
   * into history — so an attempt killed between these two writes leaves a row nobody reads rather
   * than a second answer in the conversation.
   */
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
    // A late completion from a superseded attempt must not restate the Turn's outcome: the newer
    // attempt is the one answering it now, and a `failed` arriving after it succeeded would tell
    // every reader the conversation broke.
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

  /**
   * Mine the finished turn for durable memory, off the critical path.
   *
   * Three deliberate constraints:
   *
   * - **Only successful turns.** A turn that failed part-way is an unreliable record of what the
   *   user actually meant, and inferring durable facts from it is how a memory store fills with
   *   things nobody said.
   * - **Only turns acting for a user.** Memory here is `user_private`, so a Run whose subject is a
   *   service or an Agent has no owner to attribute it to. Silence is the right answer.
   * - **Never awaited, never able to throw.** Extraction costs an LLM call. Blocking the turn on it
   *   would put that latency in front of the user, and letting it reject would fail a turn that has
   *   already succeeded — so the promise is detached and its rejection swallowed.
   */
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
