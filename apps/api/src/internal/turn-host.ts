import { randomUUID } from "node:crypto";
import type { ModelRequirementsPolicy } from "@tulipfarm/agent-runtime";
import { readTurnAttachment, type TurnAttachmentStore } from "@tulipfarm/files";
import { type InvocationPrincipal, SUBAGENT_RUN_SOURCE } from "@tulipfarm/run-kernel";
import { type MessageContent, type ParticipantToolCall, textContent } from "@tulipfarm/schema";
import type { HostedAgent } from "@tulipfarm/tool-host";
import { fromToolResult, type MessageRepo } from "../chat/messages";
import type {
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

export type TurnAuthorityDenial = "run_not_found" | "run_not_running" | "turn_not_found";

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
  /**
   * Writes the tool-role rows that link a Turn's Surfaces into its Conversation.
   *
   * Separate from `store` because `ConversationStore` models LLM history, where every row is
   * prose. A Surface link is a reference, not text, and must never reach the model as either.
   */
  readonly messages?: MessageRepo;
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
      // Every Run records a `routineId`, but only a Routine Run's names a Routine: chat and
      // Curator Runs park their own source name there.
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
    return { turnId: turn.id, conversationId: turn.conversationId, attempt: turn.attempt };
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
    content: string;
    metadata?: { readonly toolCalls?: readonly ParticipantToolCall[] };
  }): Promise<{ messageId: string }> {
    const { turn } = await this.turnAuthority(input.businessId, input.runId);
    const messageId = this.newId();
    await this.options.store.appendMessage({
      id: messageId,
      businessId: input.businessId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      role: "assistant",
      content: textContent(input.content),
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
    surfaces?: readonly { artifactId: string; revision: number }[];
  }): Promise<void> {
    const { turn, subject } = await this.turnAuthority(input.businessId, input.runId);
    const now = this.now();
    // The Artifact is already durable; this records that *this* Conversation was shown it, which
    // is the only part a reload has to restore. One tool-role Message keeps the cards in the order
    // the reader saw them, and writing it here keeps the link and the outcome inseparable.
    if (input.surfaces?.length && this.options.messages !== undefined) {
      await this.options.messages.create(
        fromToolResult(
          turn.conversationId,
          input.surfaces.map((surface) => ({
            type: "surface" as const,
            artifactId: surface.artifactId,
            revision: surface.revision,
          }))
        )
      );
    }
    // Late completion from a superseded attempt must not restate the Turn outcome.
    const current = input.attempt >= turn.attempt;
    await this.options.store.completeTurn({
      completion: {
        businessId: input.businessId,
        turnId: turn.id,
        attempt: input.attempt,
        status: input.status,
        messageId: input.messageId,
        cursor: input.cursor,
        createdAt: now,
      },
      ...(current
        ? {
            turn: {
              ...turn,
              status: input.status,
              // The reader's resume point moves with the answer, so a client reconnecting after
              // the turn ended asks for what follows this attempt rather than replaying it.
              cursor: input.cursor,
              updatedAt: now,
            },
          }
        : {}),
      ...(current && input.status === "succeeded" && subject.kind === "user"
        ? {
            work: {
              businessId: input.businessId,
              userId: subject.id,
              reason: "turn_completed" as const,
              sourceKey: turn.id,
            },
          }
        : {}),
    });
  }
}
