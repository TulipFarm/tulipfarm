import { DELEGATION_DEADLINE_LIMIT_KEY, DelegationError } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  type ChildLink,
  DurableInvocationGateway,
  type DurableInvocationRecord,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { INVOCATION_REQUEST_SCHEMAS, textContent } from "@tulipfarm/schema";
import type { Queryable, QueryResult, TransactionPort } from "@tulipfarm/storage";
import { ChildLinkAncestryStore, ChildLinkStore } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CompleteTurnInput,
  CompleteTurnResult,
  ConversationStore,
  PersistedMessage,
  PersistedTurn,
  TurnCompletion,
} from "../conversations/service";
import { createAgentDelegation, startChildConversation } from "./delegation";

const PARENT_RUN = "00000000-0000-4000-8000-0000000000a1";

/** The `run_child_links` rows a delegation writes, queried and inserted the way production does. */
class FakeLinkTable implements Queryable, TransactionPort {
  readonly rows: {
    business_id: string;
    parent_run_id: string;
    child_run_id: string;
    authority: ChildLink["authority"];
    detached_at: string | null;
    created_at: string;
  }[] = [];

  async query<Row = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<QueryResult<Row>> {
    if (text.includes("INSERT INTO run_child_links")) {
      const row = {
        business_id: String(params[0]),
        parent_run_id: String(params[1]),
        child_run_id: String(params[2]),
        authority: JSON.parse(String(params[3])) as ChildLink["authority"],
        detached_at: null,
        created_at: String(params[4]),
      };
      const existing = this.rows.find(
        (r) => r.parent_run_id === row.parent_run_id && r.child_run_id === row.child_run_id
      );
      if (existing) return { rows: [] as Row[] };
      this.rows.push(row);
      return { rows: [row] as Row[] };
    }
    if (text.includes("FROM run_child_links") && text.includes("child_run_id = $2")) {
      const found = this.rows.filter(
        (r) => r.business_id === params[0] && r.child_run_id === params[1]
      );
      return { rows: found as Row[] };
    }
    if (text.includes("FROM run_child_links")) {
      const found = this.rows.filter(
        (r) => r.business_id === params[0] && r.parent_run_id === params[1]
      );
      return { rows: found as Row[] };
    }
    throw new Error(`unexpected query: ${text}`);
  }

  async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class FakeConversationStore implements ConversationStore {
  readonly turns: PersistedTurn[] = [];
  readonly messages: PersistedMessage[] = [];
  private readonly completions: TurnCompletion[] = [];

  async findTurnByIdempotencyKey(_b: string, key: string) {
    return this.turns.find((turn) => turn.idempotencyKey === key);
  }
  async findTurn(_b: string, turnId: string) {
    return this.turns.find((turn) => turn.id === turnId);
  }
  async findTurnByRunId(_b: string, runId: string) {
    return this.turns.find((turn) => turn.runId === runId);
  }
  async appendMessage(message: PersistedMessage) {
    this.messages.push(message);
  }
  async saveTurn(turn: PersistedTurn) {
    const index = this.turns.findIndex((existing) => existing.id === turn.id);
    if (index === -1) this.turns.push(turn);
    else this.turns[index] = turn;
  }
  async listMessages(_b: string, conversationId: string) {
    return this.messages.filter((message) => message.conversationId === conversationId);
  }
  async findCompletion(_b: string, turnId: string, attempt: number) {
    return this.completions.find(
      (completion) => completion.turnId === turnId && completion.attempt === attempt
    );
  }
  async saveCompletion(completion: TurnCompletion) {
    this.completions.push(completion);
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

  /** Stands in for the Worker answering the helper's Turn. */
  settle(runId: string, status: "succeeded" | "failed", answer?: string): void {
    const turn = this.turns.find((existing) => existing.runId === runId);
    if (turn === undefined) throw new Error(`no turn for run ${runId}`);
    if (answer !== undefined) {
      this.messages.push({
        id: `msg-${this.messages.length}`,
        businessId: turn.businessId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        role: "assistant",
        content: textContent(answer),
        createdAt: new Date(),
      });
    }
    this.turns[this.turns.indexOf(turn)] = { ...turn, status };
  }
}

function harness(
  options: {
    waitMs?: number;
    parentToolNames?: (agentId: string | undefined) => readonly string[] | undefined;
  } = {}
) {
  const links = new FakeLinkTable();
  const store = new FakeConversationStore();
  const created: { id: string; agentId?: string }[] = [];
  const persisted: DurableInvocationRecord[] = [];
  const cancelled: string[] = [];
  let ids = 0;
  const newId = () => `00000000-0000-4000-8000-0000000001${String(++ids).padStart(2, "0")}`;
  const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
  const invocations = new DurableInvocationGateway({
    store: {
      persist: async (record) => {
        persisted.push(record);
        return { outcome: "started" as const, runId: record.runId };
      },
    },
    validator,
    nextId: newId,
  });
  const delegation = createAgentDelegation({
    businessId: DEPLOYMENT_BUSINESS_ID,
    links: new ChildLinkStore(links),
    ancestry: new ChildLinkAncestryStore(links),
    startChildConversation: startChildConversation({
      conversations: {
        create: async (doc) => {
          created.push({ id: doc._id, ...(doc.agentId ? { agentId: doc.agentId } : {}) });
        },
      },
      store,
      invocations,
      newId,
    }),
    conversations: store,
    cancelRun: async ({ runId }) => {
      cancelled.push(runId);
      return true;
    },
    catalog: () => [
      { name: "record_list", mutating: false, dataClasses: ["business_record"] },
      { name: "record_create", mutating: true, dataClasses: ["business_record"] },
    ],
    ...(options.parentToolNames === undefined ? {} : { parentToolNames: options.parentToolNames }),
    waitMs: options.waitMs ?? 200,
    pollMs: 5,
  });
  return { delegation, links, store, created, persisted, cancelled };
}

describe("ChildLinkAncestryStore", () => {
  it("returns null for a Run that was never delegated to", async () => {
    const table = new FakeLinkTable();

    expect(await new ChildLinkAncestryStore(table).parentLink("biz", PARENT_RUN)).toBeNull();
  });
});

describe("createAgentDelegation", () => {
  let context: ReturnType<typeof harness>;

  beforeEach(() => {
    context = harness();
  });

  it("mints a child chat Run for the target agent and links it under the parent", async () => {
    const settled = context.delegation.delegate({
      parentRunId: PARENT_RUN,
      agentId: "researcher",
      task: "Summarise the open issues",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [record] = context.persisted;
    context.store.settle(record.runId, "succeeded", "Three issues are open.");
    const outcome = await settled;

    expect(record.runSource).toBe("chat");
    expect(record.state.definitionRef).toBe("published:agent:researcher");
    expect(context.created).toEqual([{ id: outcome.conversationId, agentId: "researcher" }]);
    expect(context.links.rows).toHaveLength(1);
    expect(context.links.rows[0]).toMatchObject({
      parent_run_id: PARENT_RUN,
      child_run_id: outcome.childRunId,
    });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.result).toBe("Three issues are open.");
    expect(outcome.depth).toBe(1);
  });

  it("records a bounded delegation deadline the chain can only narrow", async () => {
    const settled = context.delegation.delegate({
      parentRunId: PARENT_RUN,
      agentId: "researcher",
      task: "Look",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    context.store.settle(context.persisted[0].runId, "succeeded", "done");
    const outcome = await settled;

    const recorded = context.links.rows[0].authority.limits[DELEGATION_DEADLINE_LIMIT_KEY];
    expect(recorded).toBe(Date.parse(outcome.deadlineAt));
    expect(recorded).toBeGreaterThan(Date.now());
  });

  it("does not let transfer to a laxer Agent exceed the delegating Agent's restrictions", async () => {
    const settled = context.delegation.delegate({
      parentRunId: PARENT_RUN,
      parentAgentId: "reporter",
      parentToolAllowlist: ["record_list"],
      agentId: "mutator",
      task: "Delete the oldest ticket.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    context.store.settle(context.persisted[0].runId, "succeeded", "I cannot delete it.");
    await settled;

    expect(context.links.rows[0].authority.tools).toEqual(["record_list"]);
    expect(context.links.rows[0].authority.tools).not.toContain("record_create");
  });

  it("narrows the root authority from the delegating Agent's own restrictions", async () => {
    const scoped = harness({
      waitMs: 200,
      parentToolNames: (agentId) => (agentId === "reporter" ? ["record_list"] : undefined),
    });
    const settled = scoped.delegation.delegate({
      parentRunId: PARENT_RUN,
      parentAgentId: "reporter",
      agentId: "mutator",
      task: "Delete the oldest ticket.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    scoped.store.settle(scoped.persisted[0].runId, "succeeded", "I cannot delete it.");
    await settled;

    expect(scoped.links.rows[0].authority.tools).toEqual(["record_list"]);
  });

  it("leaves the root authority whole for a delegating Agent that authored no restrictions", async () => {
    const scoped = harness({ waitMs: 200, parentToolNames: () => undefined });
    const settled = scoped.delegation.delegate({
      parentRunId: PARENT_RUN,
      parentAgentId: "plain",
      agentId: "researcher",
      task: "Look",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    scoped.store.settle(scoped.persisted[0].runId, "succeeded", "done");
    await settled;

    expect(scoped.links.rows[0].authority.tools).toContain("record_list");
  });

  it("reports the helper as running rather than answering for it when it does not settle", async () => {
    const outcome = await harness({ waitMs: 30 }).delegation.delegate({
      parentRunId: PARENT_RUN,
      agentId: "researcher",
      task: "Take your time",
    });

    expect(outcome.status).toBe("running");
    expect(outcome.result).toBeNull();
    expect(outcome.childRunId).not.toBe("");
  });

  it("reports a failed helper as failed and returns no answer", async () => {
    const settled = context.delegation.delegate({
      parentRunId: PARENT_RUN,
      agentId: "researcher",
      task: "Break",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    context.store.settle(context.persisted[0].runId, "failed");
    const outcome = await settled;

    expect(outcome.status).toBe("failed");
    expect(outcome.result).toBeNull();
  });

  it("refuses the hop past the depth ceiling instead of minting another Run", async () => {
    let parentRunId = PARENT_RUN;
    for (let hop = 0; hop < 3; hop += 1) {
      const settled = context.delegation.delegate({
        parentRunId,
        agentId: "researcher",
        task: `hop ${hop}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const record = context.persisted[context.persisted.length - 1];
      context.store.settle(record.runId, "succeeded", "ok");
      parentRunId = (await settled).childRunId;
    }

    await expect(
      context.delegation.delegate({ parentRunId, agentId: "researcher", task: "one too many" })
    ).rejects.toThrow(DelegationError);
    expect(context.persisted).toHaveLength(3);
    expect(context.links.rows).toHaveLength(3);
  });
});
