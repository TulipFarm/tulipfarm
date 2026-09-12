import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { MessageDoc } from "../chat/messages";
import type {
  CompleteTurnInput,
  CompleteTurnResult,
  ConversationStore,
  PersistedMessage,
  PersistedTurn,
  TurnCompletion,
} from "../conversations/service";
import type { Queryable } from "../db";
import type { HostedRunReader } from "../internal/turn-host";

/** Shared doubles for the internal turn host's tests. */

export const BUSINESS_ID = DEPLOYMENT_BUSINESS_ID;
export const CONVERSATION_ID = "conversation-1";
export const TURN_ID = "turn-1";
export const RUN_ID = "run-1";
export const CREATED_AT = new Date("2026-07-27T00:00:00.000Z");

export function turn(overrides: Partial<PersistedTurn> = {}): PersistedTurn {
  return {
    id: TURN_ID,
    businessId: BUSINESS_ID,
    conversationId: CONVERSATION_ID,
    idempotencyKey: "key-1",
    requestMessageId: "message-1",
    status: "running",
    attempt: 1,
    runId: RUN_ID,
    cursor: 0,
    supersededRunIds: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export class FakeConversationStore implements ConversationStore {
  onFindTurnByRunId?: () => void;
  readonly messages: PersistedMessage[] = [];
  readonly turns: PersistedTurn[] = [];
  readonly completions: TurnCompletion[] = [];
  readonly surfaceMessages: MessageDoc[] = [];

  async withTransaction<T>(
    operation: (store: ConversationStore, transaction: Queryable) => Promise<T>
  ): Promise<T> {
    return operation(this, {
      query: async () => {
        throw new Error("fake transaction query is unavailable");
      },
    });
  }

  async findTurnByIdempotencyKey(_businessId: string, key: string) {
    return this.turns.find((candidate) => candidate.idempotencyKey === key);
  }

  async findTurn(_businessId: string, turnId: string) {
    return this.turns.find((candidate) => candidate.id === turnId);
  }

  async lockTurnByIdempotencyKey(businessId: string, key: string) {
    return this.findTurnByIdempotencyKey(businessId, key);
  }

  async lockTurn(businessId: string, turnId: string) {
    return this.findTurn(businessId, turnId);
  }

  async findLatestTurn(_businessId: string, conversationId: string) {
    return [...this.turns]
      .reverse()
      .find((candidate) => candidate.conversationId === conversationId);
  }

  async findTurnByRunId(_businessId: string, runId: string) {
    const found = this.turns.find((candidate) => candidate.runId === runId);
    const hook = this.onFindTurnByRunId;
    this.onFindTurnByRunId = undefined;
    hook?.();
    return found;
  }

  async appendMessage(message: PersistedMessage) {
    this.messages.push(message);
  }

  async appendAssistantMessage(input: {
    readonly message: PersistedMessage;
    readonly runId: string;
    readonly attempt: number;
  }) {
    const current = this.turns.find((candidate) => candidate.id === input.message.turnId);
    if (
      current === undefined ||
      current.runId !== input.runId ||
      current.attempt !== input.attempt
    ) {
      return { status: "stale" as const, messageId: null };
    }
    const existing = this.messages.find(
      (message) =>
        message.turnId === input.message.turnId &&
        message.role === "assistant" &&
        message.attempt === input.attempt
    );
    if (existing !== undefined) {
      const index = this.messages.indexOf(existing);
      this.messages[index] = { ...input.message, id: existing.id, createdAt: existing.createdAt };
      return { status: "recorded" as const, messageId: existing.id };
    }
    this.messages.push(input.message);
    return { status: "recorded" as const, messageId: input.message.id };
  }

  async findAttemptMessage(_businessId: string, turnId: string, attempt: number) {
    return this.messages.find(
      (message) =>
        message.turnId === turnId && message.role === "assistant" && message.attempt === attempt
    );
  }

  async reserveTurn(input: {
    readonly message: PersistedMessage;
    readonly turn: PersistedTurn;
    readonly requestFingerprint?: string;
  }) {
    const existing = await this.findTurnByIdempotencyKey(
      input.turn.businessId,
      input.turn.idempotencyKey
    );
    if (existing !== undefined) {
      const request = this.messages.find((message) => message.id === existing.requestMessageId);
      const fingerprint = request?.metadata?.submissionFingerprint;
      return {
        turn: existing,
        outcome:
          input.requestFingerprint !== undefined &&
          fingerprint !== undefined &&
          fingerprint !== input.requestFingerprint
            ? ("conflict" as const)
            : ("replayed" as const),
        conversationCreated: false,
      };
    }
    this.turns.push(input.turn);
    this.messages.push(input.message);
    return { turn: input.turn, outcome: "created" as const, conversationCreated: false };
  }

  async saveTurn(saved: PersistedTurn) {
    const index = this.turns.findIndex((candidate) => candidate.id === saved.id);
    if (index === -1) this.turns.push(saved);
    else this.turns[index] = saved;
  }

  async listMessages(
    _businessId: string,
    conversationId: string,
    throughRequestMessageId?: string
  ) {
    const messages = this.messages.filter((message) => message.conversationId === conversationId);
    if (throughRequestMessageId === undefined) return messages;
    const cutoff = messages.findIndex((message) => message.id === throughRequestMessageId);
    return cutoff < 0 ? [] : messages.slice(0, cutoff + 1);
  }

  async listContextMessages(
    businessId: string,
    conversationId: string,
    throughRequestMessageId?: string,
    afterMessageId?: string
  ) {
    const messages = await this.listMessages(businessId, conversationId, throughRequestMessageId);
    if (afterMessageId === undefined) return messages;
    const cutoff = messages.findIndex((message) => message.id === afterMessageId);
    return cutoff < 0 ? [] : messages.slice(cutoff + 1);
  }

  async findCompletion(_businessId: string, turnId: string, attempt: number) {
    return this.completions.find(
      (completion) => completion.turnId === turnId && completion.attempt === attempt
    );
  }

  async completeTurn(input: CompleteTurnInput): Promise<CompleteTurnResult> {
    const turn = this.turns.find((candidate) => candidate.id === input.completion.turnId);
    if (
      turn === undefined ||
      turn.runId !== input.runId ||
      turn.attempt !== input.completion.attempt
    ) {
      return { completionInserted: false, status: "stale" };
    }
    const recorded = await this.findCompletion(
      input.completion.businessId,
      input.completion.turnId,
      input.completion.attempt
    );
    const completionInserted = recorded === undefined;
    if (completionInserted) this.completions.push(input.completion);
    if (!completionInserted) return { completionInserted: false, status: "replayed" };
    if (input.surfaceMessage !== undefined) this.surfaceMessages.push(input.surfaceMessage);
    await this.saveTurn({
      ...turn,
      status: input.completion.status,
      cursor: input.completion.cursor,
      updatedAt: input.completion.createdAt,
    });
    return { completionInserted: true, status: "recorded" };
  }
}

/** A Run reader holding one Run, so a test states only what it is varying. */
export function fakeRuns(
  run: {
    status?: string;
    digest?: string;
    /** What minted the Run, persisted independently from its pinned Routine identity. */
    source?: string;
    subject?: { kind: string; id: string };
  } | null = {}
): HostedRunReader {
  return {
    async find() {
      if (run === null) return null;
      return {
        status: run.status ?? "running",
        source: run.source ?? "chat",
        bundle: { digest: run.digest ?? "bundle-digest", routineId: "routine-id" },
        identity: { effectiveSubject: run.subject ?? { kind: "user", id: "user-1" } },
      };
    },
  };
}
