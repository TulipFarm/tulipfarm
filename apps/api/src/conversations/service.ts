/** SPEC §10/§18: persist the Turn before dispatch; stream resumes from its durable cursor. */

import type { ModelFailureDiagnostic } from "@tulipfarm/agent-runtime";
import {
  type ConversationTurn,
  contentText,
  type MessageContent,
  type MessageFilePart,
  textContent,
} from "@tulipfarm/schema";
import type { CuratorWorkRef } from "@tulipfarm/storage";

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

export type TurnCompletionStatus = Extract<TurnStatus, "succeeded" | "failed">;

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
  findTurnByIdempotencyKey(businessId: string, key: string): Promise<PersistedTurn | undefined>;
  findTurn(businessId: string, turnId: string): Promise<PersistedTurn | undefined>;
  findLatestTurn(businessId: string, conversationId: string): Promise<ConversationTurn | undefined>;
  /** Live Run→Turn mapping; `same_turn` retries supersede stale executors. */
  findTurnByRunId(businessId: string, runId: string): Promise<PersistedTurn | undefined>;
  appendMessage(message: PersistedMessage): Promise<void>;
  saveTurn(turn: PersistedTurn): Promise<void>;
  listMessages(businessId: string, conversationId: string): Promise<readonly PersistedMessage[]>;
  findCompletion(
    businessId: string,
    turnId: string,
    attempt: number
  ): Promise<TurnCompletion | undefined>;
  /**
   * One transaction for the completion, the Turn status, and any Curator work the Turn earns.
   * Recording work afterwards would lose every Turn whose process died in between, and no later
   * sweep could discover it — the Turn is already `succeeded`, so nothing marks it unmined.
   */
  completeTurn(input: CompleteTurnInput): Promise<CompleteTurnResult>;
}

export interface CompleteTurnInput {
  readonly completion: TurnCompletion;
  /** Omitted for a superseded attempt, which must not restate the Turn outcome. */
  readonly turn?: PersistedTurn;
  /** Written only when the completion insert wins, so a redelivery cannot re-enqueue it. */
  readonly work?: CuratorWorkRef;
}

export interface CompleteTurnResult {
  /** False when this attempt's completion was already recorded. */
  readonly completionInserted: boolean;
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
  /**
   * Files to attach, already checked as readable by the caller.
   *
   * The check does not belong here: this service persists a Turn, and by the time it is called the
   * route has already resolved each id against the caller's authority. Passing resolved Files
   * rather than ids is what keeps that impossible to forget.
   */
  readonly files?: readonly MessageFilePart[];
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
  /** `same_turn` re-dispatches the Turn; `new_turn` replays as a fresh Turn. */
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
      content: [...textContent(input.content), ...(input.files ?? [])],
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
      content: contentText(request.content),
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
