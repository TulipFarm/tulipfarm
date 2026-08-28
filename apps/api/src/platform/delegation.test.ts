import { DELEGATION_DEADLINE_LIMIT_KEY, DelegationError } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  type ChildLink,
  DurableInvocationGateway,
  type DurableInvocationRecord,
  type RegisteredWait,
  type RegisterWaitInput,
  type SignalWaitInput,
  signalChildCompletion,
  TypedOutputValidator,
  type WaitSignalResult,
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
    authority_binding: string;
    resume: ChildLink["resume"];
    call_id: string | null;
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
        authority_binding: String(params[4]),
        resume: params[5] === null ? null : (JSON.parse(String(params[5])) as ChildLink["resume"]),
        call_id: params[6] === null ? null : String(params[6]),
        detached_at: null,
        created_at: String(params[7]),
      };
      const existing = this.rows.find(
        (r) => r.parent_run_id === row.parent_run_id && r.child_run_id === row.child_run_id
      );
      if (existing) return { rows: [] as Row[] };
      this.rows.push(row);
      return { rows: [row] as Row[] };
    }
    if (text.includes("FROM run_child_links") && text.includes("call_id = $3")) {
      const found = this.rows.filter(
        (r) =>
          r.business_id === params[0] && r.parent_run_id === params[1] && r.call_id === params[2]
      );
      return { rows: found as Row[] };
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
  /** Fires once, on the first lookup by Run id, so a test can make a helper win the link race. */
  onFirstRunLookup?: (runId: string) => void;
  readonly turns: PersistedTurn[] = [];
  readonly messages: PersistedMessage[] = [];
  private readonly completions: TurnCompletion[] = [];

  async findTurnByIdempotencyKey(_b: string, key: string) {
    return this.turns.find((turn) => turn.idempotencyKey === key);
  }
  async findTurn(_b: string, turnId: string) {
    return this.turns.find((turn) => turn.id === turnId);
  }
  async findLatestTurn(_b: string, conversationId: string) {
    return [...this.turns].reverse().find((turn) => turn.conversationId === conversationId);
  }
  async findTurnByRunId(_b: string, runId: string) {
    const hook = this.onFirstRunLookup;
    this.onFirstRunLookup = undefined;
    hook?.(runId);
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

/** Records what the delegating turn parked on, so a test can redeem the grant the child gets. */
class FakeWaits {
  readonly registered: { id: string; runId: string; stateKey: string; kind: string }[] = [];
  readonly signalled: { id: string; token: string; digest: string; principal: string }[] = [];

  async register(input: RegisterWaitInput): Promise<RegisteredWait> {
    this.registered.push({
      id: input.id,
      runId: input.runId,
      stateKey: input.stateKey,
      kind: input.kind,
    });
    return { wait: { id: input.id } as RegisteredWait["wait"], token: `token-for-${input.id}` };
  }

  async signal(input: SignalWaitInput): Promise<WaitSignalResult> {
    this.signalled.push({
      id: input.id,
      token: input.token,
      digest: input.signalDigest,
      principal: input.principal,
    });
    return { outcome: "resumed", wait: { id: input.id }, signalCount: 1 } as WaitSignalResult;
  }
}

function harness(
  options: { parentToolNames?: (agentId: string | undefined) => readonly string[] | undefined } = {}
) {
  const links = new FakeLinkTable();
  const store = new FakeConversationStore();
  const waits = new FakeWaits();
  let waitIds = 0;
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
  const ancestry = new ChildLinkAncestryStore(links);
  const delegation = createAgentDelegation({
    businessId: DEPLOYMENT_BUSINESS_ID,
    links: new ChildLinkStore(links),
    ancestry,
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
    waits,
    newWaitId: () => `wait-${++waitIds}`,
  });
  return { delegation, links, store, created, persisted, cancelled, waits, ancestry };
}

describe("ChildLinkAncestryStore", () => {
  it("returns null for a Run that was never delegated to", async () => {
    const table = new FakeLinkTable();

    expect(await new ChildLinkAncestryStore(table).parentLink("biz", PARENT_RUN)).toBeNull();
  });
});

describe("createAgentDelegation", () => {
  let context: ReturnType<typeof harness>;
  let callIds = 0;
  const nextCallId = () => `call-${++callIds}`;

  beforeEach(() => {
    context = harness();
    callIds = 0;
  });

  /** The delegating call, as the Tool makes it: one call id, parked on the parent's own State. */
  function delegate(
    ctx: ReturnType<typeof harness>,
    input: { parentRunId?: string; callId?: string; agentId?: string; task?: string } = {}
  ) {
    return ctx.delegation.delegate({
      parentRunId: input.parentRunId ?? PARENT_RUN,
      parentStateKey: "invoke",
      callId: input.callId ?? nextCallId(),
      agentId: input.agentId ?? "researcher",
      task: input.task ?? "Summarise the open issues",
    });
  }

  it("mints a child chat Run for the target agent and links it under the parent", async () => {
    const outcome = await delegate(context);

    const [record] = context.persisted;
    expect(record.runSource).toBe("chat");
    expect(record.state.definitionRef).toBe("published:agent:researcher");
    expect(context.created).toEqual([{ id: outcome.conversationId, agentId: "researcher" }]);
    expect(context.links.rows).toHaveLength(1);
    expect(context.links.rows[0]).toMatchObject({
      parent_run_id: PARENT_RUN,
      child_run_id: outcome.childRunId,
    });
    expect(outcome.depth).toBe(1);
  });

  it("parks the delegating turn on a durable wait instead of answering for the helper", async () => {
    const outcome = await delegate(context);

    expect(outcome.status).toBe("awaiting");
    expect(outcome.result).toBeNull();
    expect(outcome.waitId).not.toBeNull();
    expect(context.waits.registered).toEqual([
      { id: outcome.waitId, runId: PARENT_RUN, stateKey: "invoke", kind: "child_run" },
    ]);
  });

  it("persists the resume grant on the link before the helper can finish", async () => {
    const outcome = await delegate(context);

    // The child's completion is detected by a process that never held the token, so the only
    // way it can resume the parent is by reading this back off the row the spawn wrote.
    expect(context.links.rows[0].resume).toEqual({
      waitId: outcome.waitId,
      token: `token-for-${outcome.waitId}`,
    });
  });

  it("resumes a helper that outlives the old fixed wait rather than dead-ending it", async () => {
    const outcome = await delegate(context);
    expect(outcome.status).toBe("awaiting");

    // Far past the 60s the poll used to give up at.
    const finishedAt = new Date(Date.now() + 5 * 60_000).toISOString();
    context.store.settle(context.persisted[0].runId, "succeeded", "Three issues are open.");
    const signalled = await signalChildCompletion(
      { ancestry: context.ancestry, waits: context.waits },
      {
        businessId: DEPLOYMENT_BUSINESS_ID,
        childRunId: outcome.childRunId,
        status: "succeeded",
        completedAt: finishedAt,
      }
    );

    expect(signalled).toMatchObject({ kind: "signalled", parentRunId: PARENT_RUN });
    expect(context.waits.signalled).toEqual([
      {
        id: outcome.waitId,
        token: `token-for-${outcome.waitId}`,
        digest: "succeeded",
        principal: `run:${outcome.childRunId}`,
      },
    ]);
  });

  it("answers the replayed call from the helper it already spawned", async () => {
    const callId = nextCallId();
    const first = await delegate(context, { callId });
    context.store.settle(context.persisted[0].runId, "succeeded", "Three issues are open.");

    const replay = await delegate(context, { callId });

    expect(replay.status).toBe("succeeded");
    expect(replay.result).toBe("Three issues are open.");
    expect(replay.childRunId).toBe(first.childRunId);
    // The whole point of keying on the call: a resumed turn must not start a second helper.
    expect(context.persisted).toHaveLength(1);
    expect(context.links.rows).toHaveLength(1);
  });

  it("keeps the replayed call parked while its helper is still running", async () => {
    const callId = nextCallId();
    const first = await delegate(context, { callId });

    const replay = await delegate(context, { callId });

    expect(replay.status).toBe("awaiting");
    expect(replay.waitId).toBe(first.waitId);
    expect(context.persisted).toHaveLength(1);
  });

  it("answers directly when the helper finished before its link was written", async () => {
    // The child Run is claimable the moment it is minted, so it can beat its own link row. A
    // parent that parked here would wait on a completion that was signalled before the grant
    // existed to receive it.
    context.store.onFirstRunLookup = (runId) =>
      context.store.settle(runId, "succeeded", "Already done.");

    const outcome = await delegate(context);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.result).toBe("Already done.");
    expect(outcome.waitId).toBeNull();
  });

  it("records a bounded delegation deadline the chain can only narrow", async () => {
    const outcome = await delegate(context);

    const recorded = context.links.rows[0].authority.limits[DELEGATION_DEADLINE_LIMIT_KEY];
    expect(recorded).toBe(Date.parse(outcome.deadlineAt));
    expect(recorded).toBeGreaterThan(Date.now());
  });

  it("does not let transfer to a laxer Agent exceed the delegating Agent's restrictions", async () => {
    await context.delegation.delegate({
      parentRunId: PARENT_RUN,
      parentStateKey: "invoke",
      callId: nextCallId(),
      parentAgentId: "reporter",
      parentToolAllowlist: ["record_list"],
      agentId: "mutator",
      task: "Delete the oldest ticket.",
    });

    expect(context.links.rows[0].authority.tools).toEqual(["record_list"]);
    expect(context.links.rows[0].authority.tools).not.toContain("record_create");
  });

  it("narrows the root authority from the delegating Agent's own restrictions", async () => {
    const scoped = harness({
      parentToolNames: (agentId) => (agentId === "reporter" ? ["record_list"] : undefined),
    });
    await scoped.delegation.delegate({
      parentRunId: PARENT_RUN,
      parentStateKey: "invoke",
      callId: nextCallId(),
      parentAgentId: "reporter",
      agentId: "mutator",
      task: "Delete the oldest ticket.",
    });

    expect(scoped.links.rows[0].authority.tools).toEqual(["record_list"]);
  });

  it("leaves the root authority whole for a delegating Agent that authored no restrictions", async () => {
    const scoped = harness({ parentToolNames: () => undefined });
    await scoped.delegation.delegate({
      parentRunId: PARENT_RUN,
      parentStateKey: "invoke",
      callId: nextCallId(),
      parentAgentId: "plain",
      agentId: "researcher",
      task: "Look",
    });

    expect(scoped.links.rows[0].authority.tools).toContain("record_list");
  });

  it("reports a failed helper as failed and returns no answer", async () => {
    const callId = nextCallId();
    await delegate(context, { callId, task: "Break" });
    context.store.settle(context.persisted[0].runId, "failed");

    const outcome = await delegate(context, { callId, task: "Break" });

    expect(outcome.status).toBe("failed");
    expect(outcome.result).toBeNull();
  });

  it("refuses the hop past the depth ceiling instead of minting another Run", async () => {
    let parentRunId = PARENT_RUN;
    for (let hop = 0; hop < 3; hop += 1) {
      parentRunId = (await delegate(context, { parentRunId, task: `hop ${hop}` })).childRunId;
    }

    await expect(delegate(context, { parentRunId, task: "one too many" })).rejects.toThrow(
      DelegationError
    );
    expect(context.persisted).toHaveLength(3);
    expect(context.links.rows).toHaveLength(3);
  });
});
