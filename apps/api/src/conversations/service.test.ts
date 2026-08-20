import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  type CompleteTurnInput,
  type CompleteTurnResult,
  ConversationAccessError,
  ConversationService,
  type ConversationStore,
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

  async findTurnByIdempotencyKey(
    _businessId: string,
    key: string
  ): Promise<PersistedTurn | undefined> {
    return this.turns.find((turn) => turn.idempotencyKey === key);
  }

  async findTurn(_businessId: string, turnId: string): Promise<PersistedTurn | undefined> {
    return this.turns.find((turn) => turn.id === turnId);
  }

  async findTurnByRunId(_businessId: string, runId: string): Promise<PersistedTurn | undefined> {
    return this.turns.find((turn) => turn.runId === runId);
  }

  async appendMessage(message: PersistedMessage): Promise<void> {
    this.messages.push(message);
  }

  async saveTurn(turn: PersistedTurn): Promise<void> {
    const index = this.turns.findIndex((existing) => existing.id === turn.id);
    if (index === -1) this.turns.push(turn);
    else this.turns[index] = turn;
  }

  async listMessages(
    _businessId: string,
    conversationId: string
  ): Promise<readonly PersistedMessage[]> {
    return this.messages.filter((message) => message.conversationId === conversationId);
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
    const recorded = await this.findCompletion(
      input.completion.businessId,
      input.completion.turnId,
      input.completion.attempt
    );
    const completionInserted = recorded === undefined;
    if (completionInserted) this.completions.push(input.completion);
    if (input.turn) await this.saveTurn(input.turn);
    return { completionInserted };
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

    expect(second).toEqual(first);
    expect(store.messages).toHaveLength(1);
    expect(runs.starts).toHaveLength(1);
  });

  it("resumes a Turn whose Run never started, without duplicating the Message", async () => {
    const runs = new FakeLauncher();
    runs.failNext = true;
    const { conversations, store } = service({ runs });

    await expect(conversations.startTurn(turnInput)).rejects.toThrow("run kernel unavailable");
    expect(store.turns[0]).toMatchObject({ status: "start_failed" });

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
