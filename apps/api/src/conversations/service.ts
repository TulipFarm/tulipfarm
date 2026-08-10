/**
 * Governed Conversations and Turns (SPEC §10, §18).
 *
 * A Turn is durable before it is dispatched: the user Message and the Turn row are written first,
 * then a Run is started for it. That ordering is what makes a lost response safe to retry — a
 * replayed idempotency key resolves to the same Turn and Run instead of a second Message, and a
 * Turn whose Run never started resumes rather than duplicating.
 *
 * Streaming is cursor-based: readers resume from the Turn's persisted cursor over the Run event
 * stream, so a reconnect never replays or drops. Authorization is re-checked on every Turn and
 * every read; nothing here caches a decision across calls.
 */

export type TurnStatus = "pending" | "running" | "start_failed" | "succeeded" | "failed";

export interface PersistedMessage {
  readonly id: string;
  readonly businessId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
  /**
   * Which Worker attempt wrote this Message. Absent on a user Message — the request belongs to the
   * Turn, not to an attempt at answering it — and on rows written before attempts existed.
   */
  readonly attempt?: number;
  readonly createdAt: Date;
}

export type TurnCompletionStatus = Extract<TurnStatus, "succeeded" | "failed">;

/**
 * What one Worker attempt produced for a Turn.
 *
 * Keyed by `(turnId, attempt)` because a Worker killed mid-turn is retried under a *new* attempt:
 * the dead attempt's record stays, and the retry's cannot collide with it. The Turn's answer is
 * whichever attempt wrote a completion naming a Message.
 */
export interface TurnCompletion {
  readonly businessId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly status: TurnCompletionStatus;
  readonly messageId: string | null;
  /** Last Run event sequence this attempt wrote; readers resume strictly after it. */
  readonly cursor: number;
  readonly createdAt: Date;
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
  findTurnByIdempotencyKey(businessId: string, key: string): Promise<PersistedTurn | undefined>;
  findTurn(businessId: string, turnId: string): Promise<PersistedTurn | undefined>;
  /**
   * The Turn a Run is currently answering. A Run that was superseded by a `same_turn` retry no
   * longer matches, which is what stops a stale executor from being handed the live Turn.
   */
  findTurnByRunId(businessId: string, runId: string): Promise<PersistedTurn | undefined>;
  appendMessage(message: PersistedMessage): Promise<void>;
  saveTurn(turn: PersistedTurn): Promise<void>;
  listMessages(businessId: string, conversationId: string): Promise<readonly PersistedMessage[]>;
  findCompletion(
    businessId: string,
    turnId: string,
    attempt: number
  ): Promise<TurnCompletion | undefined>;
  /** First write for an attempt wins; a redelivery of the same attempt must not overwrite it. */
  saveCompletion(completion: TurnCompletion): Promise<void>;
}

export interface RunLauncher {
  start(input: {
    businessId: string;
    conversationId: string;
    turnId: string;
    attempt: number;
  }): Promise<{ runId: string }>;
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
  readonly idempotencyKey: string;
}

export interface StartedTurn {
  readonly turnId: string;
  readonly runId: string;
  readonly cursor: number;
}

export interface RetryTurnInput {
  readonly businessId: string;
  readonly turnId: string;
  /** `same_turn` re-dispatches the existing Turn; `new_turn` replays the request as a fresh Turn. */
  readonly mode: "same_turn" | "new_turn";
}

export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  async startTurn(input: StartTurnInput): Promise<StartedTurn> {
    await this.require("start_turn", input.businessId);

    const existing = await this.deps.store.findTurnByIdempotencyKey(
      input.businessId,
      input.idempotencyKey
    );
    if (existing !== undefined) {
      if (existing.runId !== null) {
        return { turnId: existing.id, runId: existing.runId, cursor: existing.cursor };
      }
      // The Message is already durable; only the dispatch is missing.
      return this.dispatch(existing, existing.attempt);
    }

    const now = this.deps.now();
    const turnId = this.deps.newId();
    const messageId = this.deps.newId();

    await this.deps.store.appendMessage({
      id: messageId,
      businessId: input.businessId,
      conversationId: input.conversationId,
      turnId,
      role: "user",
      content: input.content,
      createdAt: now,
    });

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
    await this.deps.store.saveTurn(turn);

    return this.dispatch(turn, 1);
  }

  async retryTurn(input: RetryTurnInput): Promise<StartedTurn> {
    await this.require("retry_turn", input.businessId);
    const turn = await this.load(input.businessId, input.turnId, "retry_turn");

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
        turn.attempt + 1
      );
    }

    const messages = await this.deps.store.listMessages(turn.businessId, turn.conversationId);
    const request = messages.find((message) => message.id === turn.requestMessageId);
    if (request === undefined) throw new ConversationAccessError("retry_turn");

    return this.startTurn({
      businessId: turn.businessId,
      conversationId: turn.conversationId,
      content: request.content,
      idempotencyKey: `${turn.idempotencyKey}:retry:${this.deps.newId()}`,
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

  private async dispatch(turn: PersistedTurn, attempt: number): Promise<StartedTurn> {
    let runId: string;
    try {
      const started = await this.deps.runs.start({
        businessId: turn.businessId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        attempt,
      });
      runId = started.runId;
    } catch (error) {
      // The Turn stays durable and resumable; only the dispatch failed.
      await this.deps.store.saveTurn({
        ...turn,
        attempt,
        status: "start_failed",
        updatedAt: this.deps.now(),
      });
      throw error;
    }

    await this.deps.store.saveTurn({
      ...turn,
      attempt,
      runId,
      status: "running",
      updatedAt: this.deps.now(),
    });
    return { turnId: turn.id, runId, cursor: turn.cursor };
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
