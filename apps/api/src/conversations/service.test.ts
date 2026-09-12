import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import {
  type CompleteTurnInput,
  type CompleteTurnResult,
  ConversationAccessError,
  ConversationService,
  type ConversationStore,
  type NewConversation,
  type PersistedMessage,
  type PersistedTurn,
  type RunLauncher,
  type TurnCompletion,
  type TurnGrant,
} from "./service";

const GRANT: TurnGrant = {
  businessId: "biz-1",
  principal: "user:u-1",
  abilities: ["conversation.write"],
};

class FakeStore implements ConversationStore {
  messages: PersistedMessage[] = [];
  turns: PersistedTurn[] = [];
  completions: TurnCompletion[] = [];

  async withTransaction<T>(
    operation: (store: ConversationStore, transaction: Queryable) => Promise<T>
  ): Promise<T> {
    const messages = [...this.messages];
    const turns = [...this.turns];
    const completions = [...this.completions];
    try {
      return await operation(this, {
        query: async () => {
          throw new Error("fake transaction query is unavailable");
        },
      });
    } catch (error) {
      this.messages = messages;
      this.turns = turns;
      this.completions = completions;
      throw error;
    }
  }

  async findTurnByIdempotencyKey(
    _businessId: string,
    key: string
  ): Promise<PersistedTurn | undefined> {
    return this.turns.find((turn) => turn.idempotencyKey === key);
  }

  async findTurn(_businessId: string, turnId: string): Promise<PersistedTurn | undefined> {
    return this.turns.find((turn) => turn.id === turnId);
  }

  async lockTurnByIdempotencyKey(
    businessId: string,
    key: string
  ): Promise<PersistedTurn | undefined> {
    return this.findTurnByIdempotencyKey(businessId, key);
  }

  async lockTurn(businessId: string, turnId: string): Promise<PersistedTurn | undefined> {
    return this.findTurn(businessId, turnId);
  }

  async findLatestTurn(
    _businessId: string,
    conversationId: string
  ): Promise<PersistedTurn | undefined> {
    return [...this.turns].reverse().find((turn) => turn.conversationId === conversationId);
  }

  async findTurnByRunId(_businessId: string, runId: string): Promise<PersistedTurn | undefined> {
    return this.turns.find((turn) => turn.runId === runId);
  }

  async appendMessage(message: PersistedMessage): Promise<void> {
    this.messages.push(message);
  }

  async appendAssistantMessage(input: {
    readonly message: PersistedMessage;
    readonly runId: string;
    readonly attempt: number;
  }) {
    const turn = this.turns.find((candidate) => candidate.id === input.message.turnId);
    if (turn === undefined || turn.runId !== input.runId || turn.attempt !== input.attempt) {
      return { status: "stale" as const, messageId: null };
    }
    const existing = this.messages.find(
      (message) =>
        message.turnId === input.message.turnId &&
        message.role === "assistant" &&
        message.attempt === input.attempt
    );
    if (existing !== undefined) {
      return { status: "recorded" as const, messageId: existing.id };
    }
    this.messages.push(input.message);
    return { status: "recorded" as const, messageId: input.message.id };
  }

  async reserveTurn(input: {
    readonly message: PersistedMessage;
    readonly turn: PersistedTurn;
    readonly requestFingerprint?: string;
    readonly newConversation?: NewConversation;
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
    return {
      turn: input.turn,
      outcome: "created" as const,
      conversationCreated: input.newConversation !== undefined,
    };
  }

  async saveTurn(turn: PersistedTurn): Promise<void> {
    const index = this.turns.findIndex((existing) => existing.id === turn.id);
    if (index === -1) this.turns.push(turn);
    else this.turns[index] = turn;
  }

  async listMessages(
    _businessId: string,
    conversationId: string,
    throughRequestMessageId?: string
  ): Promise<readonly PersistedMessage[]> {
    const messages = this.messages.filter((message) => message.conversationId === conversationId);
    if (throughRequestMessageId === undefined) return messages;
    const cutoff = messages.findIndex((message) => message.id === throughRequestMessageId);
    return cutoff < 0 ? [] : messages.slice(0, cutoff + 1);
  }

  async findCompletion(
    _businessId: string,
    turnId: string,
    attempt: number
  ): Promise<TurnCompletion | undefined> {
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
    await this.saveTurn({
      ...turn,
      status: input.completion.status,
      cursor: input.completion.cursor,
      updatedAt: input.completion.createdAt,
    });
    return { completionInserted: true, status: "recorded" };
  }
}

class FakeLauncher implements RunLauncher {
  starts: { turnId: string; attempt: number }[] = [];
  failNext = false;

  async start(input: { turnId: string; attempt: number }): Promise<{ runId: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("run kernel unavailable");
    }
    this.starts.push({ turnId: input.turnId, attempt: input.attempt });
    return { runId: `run-${this.starts.length}` };
  }
}

function service(
  options: { grant?: TurnGrant | null; store?: FakeStore; runs?: FakeLauncher } = {}
) {
  const store = options.store ?? new FakeStore();
  const runs = options.runs ?? new FakeLauncher();
  let ids = 0;
  const authorizeCalls: string[] = [];

  const conversations = new ConversationService({
    store,
    runs,
    authorize: async (action) => {
      authorizeCalls.push(action);
      return options.grant === undefined ? GRANT : options.grant;
    },
    newId: () => {
      ids += 1;
      return `id-${ids}`;
    },
    now: () => new Date("2026-07-25T10:00:00.000Z"),
  });

  return { conversations, store, runs, authorizeCalls };
}

const turnInput = {
  businessId: "biz-1",
  conversationId: "conv-1",
  content: "summarize the incident",
  idempotencyKey: "key-1",
};

describe("ConversationService", () => {
  it("keeps a reserved Turn pending until post-ack dispatch", async () => {
    const { conversations, store, runs } = service();

    const reserved = await conversations.reserveTurn(turnInput);
    expect(reserved.runId).toBeNull();
    expect(store.turns[0]).toMatchObject({ status: "pending", runId: null });
    expect(runs.starts).toEqual([]);

    const started = await conversations.dispatchReservedTurn({
      businessId: turnInput.businessId,
      idempotencyKey: turnInput.idempotencyKey,
    });
    expect(started.runId).toBe("run-1");
    expect(runs.starts).toEqual([{ turnId: reserved.turnId, attempt: 1 }]);
  });

  it("persists the user Message and Turn before the Run is started", async () => {
    const { conversations, store, runs } = service();
    const started = await conversations.startTurn(turnInput);

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      role: "user",
      content: textContent("summarize the incident"),
    });
    expect(runs.starts).toEqual([{ turnId: started.turnId, attempt: 1 }]);
    expect(started).toMatchObject({ runId: "run-1", cursor: 0 });
  });

  it("returns the same Turn and Run for a replayed idempotency key", async () => {
    const { conversations, store, runs } = service();
    const first = await conversations.startTurn(turnInput);
    const second = await conversations.startTurn(turnInput);

    expect(second).toMatchObject({
      turnId: first.turnId,
      runId: first.runId,
      conversationId: first.conversationId,
      outcome: "replayed",
    });
    expect(store.messages).toHaveLength(1);
    expect(runs.starts).toHaveLength(1);
  });

  it("resumes a Turn whose Run never started, without duplicating the Message", async () => {
    const runs = new FakeLauncher();
    runs.failNext = true;
    const { conversations, store } = service({ runs });

    await expect(conversations.startTurn(turnInput)).rejects.toThrow("run kernel unavailable");
    expect(store.turns).toEqual([]);
    expect(store.messages).toEqual([]);

    const retried = await conversations.startTurn(turnInput);
    expect(store.messages).toHaveLength(1);
    expect(retried).toMatchObject({ runId: "run-1", turnId: store.turns[0]?.id });
    expect(store.turns).toHaveLength(1);
  });

  it("retries the same Turn as a new attempt that supersedes the old Run", async () => {
    const { conversations, store, runs } = service();
    const started = await conversations.startTurn(turnInput);
    const retried = await conversations.retryTurn({
      businessId: "biz-1",
      turnId: started.turnId,
      mode: "same_turn",
    });

    expect(retried.turnId).toBe(started.turnId);
    expect(retried.runId).toBe("run-2");
    expect(runs.starts).toEqual([
      { turnId: started.turnId, attempt: 1 },
      { turnId: started.turnId, attempt: 2 },
    ]);
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]).toMatchObject({ attempt: 2, supersededRunIds: ["run-1"] });
  });

  it("retries as a new Turn that replays the request without touching the original", async () => {
    const { conversations, store } = service();
    const started = await conversations.startTurn(turnInput);
    const retried = await conversations.retryTurn({
      businessId: "biz-1",
      turnId: started.turnId,
      mode: "new_turn",
    });

    expect(retried.turnId).not.toBe(started.turnId);
    expect(store.turns).toHaveLength(2);
    expect(store.turns[0]).toMatchObject({ attempt: 1, runId: "run-1" });
    expect(store.messages).toHaveLength(2);
    expect(store.messages[1]).toMatchObject({
      role: "user",
      content: textContent("summarize the incident"),
    });
  });

  it("rechecks authorization on every Turn and persists nothing when it is denied", async () => {
    const { conversations, store, runs, authorizeCalls } = service({ grant: null });

    await expect(conversations.startTurn(turnInput)).rejects.toBeInstanceOf(
      ConversationAccessError
    );
    expect(store.messages).toEqual([]);
    expect(runs.starts).toEqual([]);
    expect(authorizeCalls).toEqual(["start_turn"]);
  });

  it("rechecks authorization on reads", async () => {
    const { conversations } = service({ grant: null });

    await expect(
      conversations.listMessages({ businessId: "biz-1", conversationId: "conv-1" })
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });

  it("hands a reconnecting reader the Turn's Run and its durable cursor", async () => {
    const { conversations, store } = service();
    const started = await conversations.startTurn(turnInput);
    const turn = store.turns[0];
    if (turn === undefined) throw new Error("turn missing");
    await store.saveTurn({ ...turn, cursor: 7 });

    expect(
      await conversations.streamHandle({ businessId: "biz-1", turnId: started.turnId })
    ).toEqual({ runId: "run-1", after: 7 });
  });

  it("refuses to stream a Turn the reader may not see", async () => {
    const store = new FakeStore();
    const authorized = service({ store });
    const started = await authorized.conversations.startTurn(turnInput);
    const denied = service({ store, grant: null });

    await expect(
      denied.conversations.streamHandle({ businessId: "biz-1", turnId: started.turnId })
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });
});
