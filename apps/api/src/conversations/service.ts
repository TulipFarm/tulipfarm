/** SPEC §10/§18: persist the Turn before dispatch; stream resumes from its durable cursor. */

import type { ModelFailureDiagnostic } from "@tulipfarm/agent-runtime";
import {
  type ConversationTurn,
  contentText,
  type MessageContent,
  type MessageFilePart,
  textContent,
} from "@tulipfarm/schema";
import type { MessageDoc } from "../chat/messages";
import type { Queryable } from "../db";

export type TurnStatus = ConversationTurn["status"];

export interface PersistedMessage {
  readonly id: string;
  readonly businessId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly content: MessageContent;
  readonly metadata?: Record<string, unknown>;
  /** Worker attempt that wrote this Message; absent for user Messages and old rows. */
  readonly attempt?: number;
  readonly createdAt: Date;
}

export type AssistantAttemptStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded"
  | "incomplete";

export interface ContextMessage extends PersistedMessage {
  /** Model-facing status for assistant attempt evidence; never changes the persisted Message. */
  readonly attemptStatus?: AssistantAttemptStatus;
}

export type TurnCompletionStatus = Extract<TurnStatus, "succeeded" | "failed">;
export type TurnPersistenceStatus = "recorded" | "replayed" | "stale" | "ownership_lost";

export type AssistantMessageWriteResult =
  | { readonly status: "recorded" | "replayed"; readonly messageId: string }
  | { readonly status: "stale" | "ownership_lost"; readonly messageId: null };

/** One Worker attempt for a Turn; retries use a new attempt so dead records do not collide. */
export interface TurnCompletion {
  readonly businessId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly status: TurnCompletionStatus;
  readonly messageId: string | null;
  /** Last Run event sequence this attempt wrote; readers resume strictly after it. */
  readonly cursor: number;
  readonly createdAt: Date;
  /** Bounded, participant-safe failure evidence; absent for a succeeded completion. */
  readonly reason?: string;
  readonly modelFailure?: ModelFailureDiagnostic;
}

export interface PersistedTurn {
  readonly id: string;
  readonly businessId: string;
  readonly conversationId: string;
  readonly idempotencyKey: string;
  readonly requestMessageId: string;
  readonly status: TurnStatus;
  readonly attempt: number;
  readonly runId: string | null;
  /** Run event sequence already delivered to readers; a reconnect resumes strictly after it. */
  readonly cursor: number;
  readonly supersededRunIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ConversationStore {
  withTransaction<T>(
    operation: (store: ConversationStore, transaction: Queryable) => Promise<T>
  ): Promise<T>;
  findTurnByIdempotencyKey(businessId: string, key: string): Promise<PersistedTurn | undefined>;
  lockTurnByIdempotencyKey(businessId: string, key: string): Promise<PersistedTurn | undefined>;
  findTurn(businessId: string, turnId: string): Promise<PersistedTurn | undefined>;
  lockTurn(businessId: string, turnId: string): Promise<PersistedTurn | undefined>;
  findLatestTurn(businessId: string, conversationId: string): Promise<ConversationTurn | undefined>;
  /** Live Run→Turn mapping; `same_turn` retries supersede stale executors. */
  findTurnByRunId(businessId: string, runId: string): Promise<PersistedTurn | undefined>;
  appendMessage(message: PersistedMessage): Promise<void>;
  appendAssistantMessage(input: {
    readonly message: PersistedMessage;
    readonly runId: string;
    readonly attempt: number;
    readonly expectedLeaseGeneration?: number;
  }): Promise<AssistantMessageWriteResult>;
  /** Participant-safe history for the named attempt, if it has checkpointed any. */
  findAttemptMessage?(
    businessId: string,
    turnId: string,
    attempt: number
  ): Promise<PersistedMessage | undefined>;
  reserveTurn(input: {
    readonly message: PersistedMessage;
    readonly turn: PersistedTurn;
    readonly requestFingerprint?: string;
    readonly newConversation?: NewConversation;
    readonly conversationUpdate?: { readonly agentId?: string };
  }): Promise<{
    readonly turn: PersistedTurn;
    readonly outcome: "created" | "replayed" | "conflict";
    readonly conversationCreated: boolean;
  }>;
  saveTurn(turn: PersistedTurn): Promise<void>;
  listMessages(
    businessId: string,
    conversationId: string,
    throughRequestMessageId?: string
  ): Promise<readonly PersistedMessage[]>;
  listContextMessages(
    businessId: string,
    conversationId: string,
    throughRequestMessageId?: string,
    afterMessageId?: string
  ): Promise<readonly ContextMessage[]>;
  findCompletion(
    businessId: string,
    turnId: string,
    attempt: number
  ): Promise<TurnCompletion | undefined>;
  /** One transaction for the completion and the Turn status, so neither can land without the other. */
  completeTurn(input: CompleteTurnInput): Promise<CompleteTurnResult>;
}

export interface CompleteTurnInput {
  readonly completion: TurnCompletion;
  readonly runId: string;
  readonly expectedLeaseGeneration?: number;
  readonly surfaceMessage?: MessageDoc;
}

export interface CompleteTurnResult {
  /** False when this attempt's completion was already recorded. */
  readonly completionInserted: boolean;
  readonly status: TurnPersistenceStatus;
}

export interface SettleTerminalTurnInput {
  readonly businessId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly status: TurnCompletionStatus;
  readonly cursor: number;
  readonly reason?: string;
  readonly createdAt: Date;
  readonly historyOutcome: "succeeded" | "failed" | "cancelled";
}

export interface TerminalTurnStore
  extends Pick<
    ConversationStore,
    | "appendAssistantMessage"
    | "findAttemptMessage"
    | "findLatestTurn"
    | "findTurn"
    | "findTurnByRunId"
  > {
  settleTerminalTurn(input: SettleTerminalTurnInput): Promise<CompleteTurnResult>;
}

export interface RunLauncher {
  start(
    input: {
      businessId: string;
      conversationId: string;
      turnId: string;
      attempt: number;
    },
    transaction?: Queryable
  ): Promise<{ runId: string }>;
}

export interface TurnGrant {
  readonly businessId: string;
  readonly principal: string;
  readonly abilities: readonly string[];
}

export type ConversationAction = "start_turn" | "retry_turn" | "read_messages" | "read_stream";

export class ConversationAccessError extends Error {
  readonly name = "ConversationAccessError";

  constructor(readonly action: ConversationAction) {
    super(`conversation_access_denied:${action}`);
  }
}

export class ConversationIdempotencyConflictError extends Error {
  readonly name = "ConversationIdempotencyConflictError";

  constructor() {
    super("conversation_idempotency_payload_conflict");
  }
}

export interface ConversationServiceDeps {
  readonly store: ConversationStore;
  readonly runs: RunLauncher;
  authorize(action: ConversationAction, businessId: string): Promise<TurnGrant | null>;
  newId(): string;
  now(): Date;
}

export interface StartTurnInput {
  readonly businessId: string;
  readonly conversationId: string;
  readonly content: string;
  /**
   * Files to attach, already checked as readable by the caller.
   *
   * The check does not belong here: this service persists a Turn, and by the time it is called the
   * route has already resolved each id against the caller's authority. Passing resolved Files
   * rather than ids is what keeps that impossible to forget.
   */
  readonly files?: readonly MessageFilePart[];
  readonly idempotencyKey: string;
  /** Hash of the normalized submission. Reusing a client key for a different request conflicts. */
  readonly requestFingerprint?: string;
  /** New Chat Conversation to commit only if this request wins the idempotency claim. */
  readonly newConversation?: NewConversation;
  /** Existing Chat Conversation update to commit only if this request wins the claim. */
  readonly conversationUpdate?: { readonly agentId?: string };
}

export interface NewConversation {
  readonly id: string;
  readonly userId: string;
  readonly agentId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReservedTurn {
  readonly turnId: string;
  readonly runId: string | null;
  readonly cursor: number;
  readonly conversationId: string;
  readonly outcome: "created" | "replayed";
  readonly conversationCreated: boolean;
}

export interface StartedTurn {
  readonly turnId: string;
  readonly runId: string;
  readonly cursor: number;
  readonly conversationId: string;
  readonly outcome: "started" | "replayed";
  readonly conversationCreated: boolean;
}

export interface RetryTurnInput {
  readonly businessId: string;
  readonly turnId: string;
  /** `same_turn` re-dispatches the Turn; `new_turn` replays as a fresh Turn. */
  readonly mode: "same_turn" | "new_turn";
}

export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  async reserveTurn(input: StartTurnInput): Promise<ReservedTurn> {
    await this.require("start_turn", input.businessId);
    const reservation = await this.deps.store.withTransaction((store) =>
      this.reserve(input, store)
    );
    const { turn } = reservation;
    return {
      turnId: turn.id,
      runId: turn.runId,
      cursor: turn.cursor,
      conversationId: turn.conversationId,
      outcome: reservation.outcome,
      conversationCreated: reservation.conversationCreated,
    };
  }

  private async reserve(
    input: StartTurnInput,
    store: ConversationStore
  ): Promise<{
    turn: PersistedTurn;
    outcome: "created" | "replayed";
    conversationCreated: boolean;
  }> {
    const now = this.deps.now();
    const turnId = this.deps.newId();
    const messageId = this.deps.newId();

    const message: PersistedMessage = {
      id: messageId,
      businessId: input.businessId,
      conversationId: input.conversationId,
      turnId,
      role: "user",
      content: [...textContent(input.content), ...(input.files ?? [])],
      ...(input.requestFingerprint === undefined
        ? {}
        : { metadata: { submissionFingerprint: input.requestFingerprint } }),
      createdAt: now,
    };

    const turn: PersistedTurn = {
      id: turnId,
      businessId: input.businessId,
      conversationId: input.conversationId,
      idempotencyKey: input.idempotencyKey,
      requestMessageId: messageId,
      status: "pending",
      attempt: 1,
      runId: null,
      cursor: 0,
      supersededRunIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const reservation = await store.reserveTurn({
      message,
      turn,
      ...(input.requestFingerprint === undefined
        ? {}
        : { requestFingerprint: input.requestFingerprint }),
      ...(input.newConversation === undefined ? {} : { newConversation: input.newConversation }),
      ...(input.conversationUpdate === undefined
        ? {}
        : { conversationUpdate: input.conversationUpdate }),
    });
    if (reservation.outcome === "conflict") {
      throw new ConversationIdempotencyConflictError();
    }
    return {
      turn: reservation.turn,
      outcome: reservation.outcome,
      conversationCreated: reservation.conversationCreated,
    };
  }

  async dispatchReservedTurn(input: {
    businessId: string;
    idempotencyKey: string;
  }): Promise<StartedTurn> {
    await this.require("start_turn", input.businessId);
    return this.deps.store.withTransaction(async (store, transaction) => {
      const turn = await store.lockTurnByIdempotencyKey(input.businessId, input.idempotencyKey);
      if (turn === undefined) throw new ConversationAccessError("start_turn");
      if (turn.runId !== null) {
        return {
          turnId: turn.id,
          runId: turn.runId,
          cursor: turn.cursor,
          conversationId: turn.conversationId,
          outcome: "replayed",
          conversationCreated: false,
        };
      }
      return this.dispatch(turn, turn.attempt, store, transaction, "replayed", false);
    });
  }

  async startTurn(input: StartTurnInput): Promise<StartedTurn> {
    await this.require("start_turn", input.businessId);
    return this.deps.store.withTransaction(async (store, transaction) => {
      const reservation = await this.reserve(input, store);
      const { turn } = reservation;
      if (turn.runId !== null) {
        return {
          turnId: turn.id,
          runId: turn.runId,
          cursor: turn.cursor,
          conversationId: turn.conversationId,
          outcome: "replayed",
          conversationCreated: false,
        };
      }
      const locked = await store.lockTurn(input.businessId, turn.id);
      if (locked === undefined) throw new ConversationAccessError("start_turn");
      if (locked.runId !== null) {
        return {
          turnId: locked.id,
          runId: locked.runId,
          cursor: locked.cursor,
          conversationId: locked.conversationId,
          outcome: "replayed",
          conversationCreated: false,
        };
      }
      return this.dispatch(
        locked,
        locked.attempt,
        store,
        transaction,
        reservation.outcome === "created" ? "started" : "replayed",
        reservation.conversationCreated
      );
    });
  }

  async retryTurn(input: RetryTurnInput): Promise<StartedTurn> {
    await this.require("retry_turn", input.businessId);
    return this.deps.store.withTransaction(async (store, transaction) => {
      const turn = await store.lockTurn(input.businessId, input.turnId);
      if (turn === undefined) throw new ConversationAccessError("retry_turn");

      if (input.mode === "same_turn") {
        const superseded =
          turn.runId === null ? turn.supersededRunIds : [...turn.supersededRunIds, turn.runId];
        return this.dispatch(
          {
            ...turn,
            attempt: turn.attempt + 1,
            runId: null,
            // A new attempt streams its own Run, so the reader's cursor restarts with it.
            cursor: 0,
            supersededRunIds: superseded,
          },
          turn.attempt + 1,
          store,
          transaction,
          "started",
          false
        );
      }

      const messages = await store.listMessages(turn.businessId, turn.conversationId);
      const request = messages.find((message) => message.id === turn.requestMessageId);
      if (request === undefined) throw new ConversationAccessError("retry_turn");

      const replay: StartTurnInput = {
        businessId: turn.businessId,
        conversationId: turn.conversationId,
        content: contentText(request.content),
        idempotencyKey: `${turn.idempotencyKey}:retry:${this.deps.newId()}`,
      };
      const replayedTurn = await this.reserve(replay, store);
      return this.dispatch(
        replayedTurn.turn,
        replayedTurn.turn.attempt,
        store,
        transaction,
        "started",
        false
      );
    });
  }

  async listMessages(input: {
    businessId: string;
    conversationId: string;
  }): Promise<readonly PersistedMessage[]> {
    await this.require("read_messages", input.businessId);
    return this.deps.store.listMessages(input.businessId, input.conversationId);
  }

  /** Where a reconnecting reader should resume: the Turn's Run and its durable cursor. */
  async streamHandle(input: {
    businessId: string;
    turnId: string;
  }): Promise<{ runId: string; after: number }> {
    await this.require("read_stream", input.businessId);
    const turn = await this.load(input.businessId, input.turnId, "read_stream");
    if (turn.runId === null) throw new ConversationAccessError("read_stream");
    return { runId: turn.runId, after: turn.cursor };
  }

  private async dispatch(
    turn: PersistedTurn,
    attempt: number,
    store: ConversationStore,
    transaction: Queryable,
    outcome: "started" | "replayed",
    conversationCreated: boolean
  ): Promise<StartedTurn> {
    const { runId } = await this.deps.runs.start(
      {
        businessId: turn.businessId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        attempt,
      },
      transaction
    );
    await store.saveTurn({
      ...turn,
      attempt,
      runId,
      status: "running",
      updatedAt: this.deps.now(),
    });
    return {
      turnId: turn.id,
      runId,
      cursor: turn.cursor,
      conversationId: turn.conversationId,
      outcome,
      conversationCreated,
    };
  }

  private async require(action: ConversationAction, businessId: string): Promise<TurnGrant> {
    const grant = await this.deps.authorize(action, businessId);
    if (grant === null) throw new ConversationAccessError(action);
    return grant;
  }

  private async load(
    businessId: string,
    turnId: string,
    action: ConversationAction
  ): Promise<PersistedTurn> {
    const turn = await this.deps.store.findTurn(businessId, turnId);
    if (turn === undefined) throw new ConversationAccessError(action);
    return turn;
  }
}
