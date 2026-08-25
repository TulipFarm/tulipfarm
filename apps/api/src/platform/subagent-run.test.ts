import { createSubagentSpawning, DELEGATION_DEADLINE_LIMIT_KEY } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  type ChildLink,
  DurableInvocationGateway,
  type DurableInvocationRecord,
  type RegisteredWait,
  type RegisterWaitInput,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { RUN_ARTIFACT_SCHEMAS } from "@tulipfarm/schema";
import type { Queryable, QueryResult, TransactionPort } from "@tulipfarm/storage";
import { ChildLinkAncestryStore, ChildLinkStore } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { startSubagentRun } from "./subagent-run";

const PARENT_RUN = "00000000-0000-4000-8000-0000000000a1";
const PARENT_STATE = "invoke";
const PERSONA = { name: "Summarizer", instructions: "Answer in one sentence." };

/** The `run_child_links` rows a spawn writes, queried and inserted the way production does. */
class FakeLinkTable implements Queryable, TransactionPort {
  readonly rows: {
    business_id: string;
    parent_run_id: string;
    child_run_id: string;
    authority: ChildLink["authority"];
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
        resume: params[4] === null ? null : (JSON.parse(String(params[4])) as ChildLink["resume"]),
        call_id: params[5] === null ? null : String(params[5]),
        detached_at: null,
        created_at: String(params[6]),
      };
      const existing = this.rows.find(
        (r) => r.parent_run_id === row.parent_run_id && r.child_run_id === row.child_run_id
      );
      if (existing) return { rows: [] as Row[] };
      this.rows.push(row);
      return { rows: [row] as Row[] };
    }
    if (text.includes("FROM run_child_links") && text.includes("call_id = $3")) {
      return {
        rows: this.rows.filter(
          (r) =>
            r.business_id === params[0] && r.parent_run_id === params[1] && r.call_id === params[2]
        ) as Row[],
      };
    }
    if (text.includes("FROM run_child_links") && text.includes("child_run_id = $2")) {
      return {
        rows: this.rows.filter(
          (r) => r.business_id === params[0] && r.child_run_id === params[1]
        ) as Row[],
      };
    }
    if (text.includes("FROM run_child_links")) {
      return {
        rows: this.rows.filter(
          (r) => r.business_id === params[0] && r.parent_run_id === params[1]
        ) as Row[],
      };
    }
    throw new Error(`unexpected query: ${text}`);
  }

  async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class FakeWaits {
  readonly registered: RegisterWaitInput[] = [];

  async register(input: RegisterWaitInput): Promise<RegisteredWait> {
    this.registered.push(input);
    return { wait: { id: input.id } as RegisteredWait["wait"], token: `token-for-${input.id}` };
  }
}

function harness(
  options: {
    parentToolNames?: (agentId: string | undefined) => readonly string[] | undefined;
    answer?: { status: "succeeded" | "failed" | null; answer: string | null };
  } = {}
) {
  const links = new FakeLinkTable();
  const waits = new FakeWaits();
  const persisted: DurableInvocationRecord[] = [];
  let ids = 0;
  let waitIds = 0;
  const newId = () => `00000000-0000-4000-8000-0000000001${String(++ids).padStart(2, "0")}`;
  const invocations = new DurableInvocationGateway({
    store: {
      persist: async (record) => {
        persisted.push(record);
        return { outcome: "started" as const, runId: record.runId };
      },
    },
    validator: new TypedOutputValidator(RUN_ARTIFACT_SCHEMAS),
    nextId: newId,
  });

  const spawning = createSubagentSpawning({
    businessId: DEPLOYMENT_BUSINESS_ID,
    links: new ChildLinkStore(links),
    ancestry: new ChildLinkAncestryStore(links),
    startSubagentRun: startSubagentRun({ invocations }),
    answers: { read: async () => options.answer ?? { status: null, answer: null } },
    cancelRun: async () => true,
    catalog: () => [
      { name: "record_list", mutating: false, dataClasses: ["business_record"] },
      { name: "record_search", mutating: false, dataClasses: ["business_record"] },
      { name: "record_create", mutating: true, dataClasses: ["business_record"] },
    ],
    ...(options.parentToolNames === undefined ? {} : { parentToolNames: options.parentToolNames }),
    waits,
    newWaitId: () => `wait-${++waitIds}`,
  });

  return { spawning, links, waits, persisted };
}

const CALL = {
  parentRunId: PARENT_RUN,
  parentStateKey: PARENT_STATE,
  callId: "call-1",
  persona: PERSONA,
  task: "Summarize the incident.",
};

describe("createSubagentSpawning", () => {
  it("mints a subagent Run with no Conversation and parks the caller on a wait", async () => {
    const { spawning, persisted, waits } = harness();

    const outcome = await spawning.spawn(CALL);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.source).toBe("chat");
    expect(outcome.status).toBe("awaiting");
    expect(outcome.waitId).toBe("wait-1");
    expect(waits.registered).toHaveLength(1);
  });

  it("names the Run source the sub-agent executor is registered for", async () => {
    const { spawning, persisted } = harness();

    await spawning.spawn(CALL);

    // A different source here would leave the Run with no executor and park it forever.
    expect(persisted[0]?.runSource).toBe("subagent");
  });

  it("carries the persona and task into the Run's request payload", async () => {
    const { spawning, persisted } = harness();

    await spawning.spawn({ ...CALL, context: { ticketId: "T-9" } });

    const payload = persisted[0]?.requestArtifact.value as Record<string, unknown>;
    expect(payload.persona).toEqual(PERSONA);
    expect(payload.task).toBe("Summarize the incident.");
    expect(payload.context).toEqual({ ticketId: "T-9" });
    expect(payload.parentRunId).toBe(PARENT_RUN);
  });

  it("binds the helper to the Agent that spawned it, not to the default assistant", async () => {
    // The helper's capability restrictions and autonomy are resolved from this id. Without it the
    // helper falls back to the default assistant, whose scope is wider than its spawner's — so a
    // Tool the parent may only call against one Resource type would come back unscoped.
    const { spawning, persisted } = harness();

    await spawning.spawn({ ...CALL, parentAgentId: "support-triage" });

    expect(persisted[0]?.requestArtifact.value).toMatchObject({ agentId: "support-triage" });
  });

  it("names no Agent when the spawning turn named none", async () => {
    const { spawning, persisted } = harness();

    await spawning.spawn(CALL);

    expect(persisted[0]?.requestArtifact.value).not.toHaveProperty("agentId");
  });

  it("scopes the wait to the child Run, so no other Run can resume the caller", async () => {
    const { spawning, waits, persisted } = harness();

    await spawning.spawn(CALL);

    expect(waits.registered[0]?.allowedPrincipals).toEqual([`run:${persisted[0]?.runId}`]);
    expect(waits.registered[0]?.runId).toBe(PARENT_RUN);
    expect(waits.registered[0]?.stateKey).toBe(PARENT_STATE);
  });

  it("withholds a mutating Tool even when the caller asks for it", async () => {
    const { spawning, links } = harness();

    await spawning.spawn({ ...CALL, toolNames: ["record_list", "record_create"] });

    // A helper that did not ask for effects never gets them, and this one cannot ask.
    expect(links.rows[0]?.authority.tools).toEqual(["record_list"]);
  });

  it("refuses the spawn when the caller names a Tool the spawning Agent does not hold", async () => {
    const { spawning, persisted } = harness({ parentToolNames: () => ["record_list"] });

    // Refusing beats silently dropping the name: a helper quieter than its caller believed fails
    // confusingly mid-run, while a refusal says exactly what was wrong and can be retried.
    await expect(
      spawning.spawn({ ...CALL, toolNames: ["record_list", "record_search"] })
    ).rejects.toThrow(/amplification/);
    expect(persisted).toHaveLength(0);
  });

  it("grants only what the spawning Agent itself holds", async () => {
    const { spawning, links } = harness({ parentToolNames: () => ["record_list"] });

    await spawning.spawn({ ...CALL, toolNames: ["record_list"] });

    expect(links.rows[0]?.authority.tools).toEqual(["record_list"]);
  });

  it("gives the helper no Tools when the caller named none", async () => {
    const { spawning, links, persisted } = harness();

    await spawning.spawn(CALL);

    // Inheriting the parent's whole read-only set here would hand a helper nobody scoped the run
    // of every record in the business.
    expect(links.rows[0]?.authority.tools).toEqual([]);
    expect(persisted[0]?.requestArtifact.value).not.toHaveProperty("toolNames");
  });

  it("bounds the helper with a deadline it cannot outlive", async () => {
    const { spawning, links } = harness();

    await spawning.spawn(CALL);

    const deadline = links.rows[0]?.authority.limits[DELEGATION_DEADLINE_LIMIT_KEY];
    expect(typeof deadline).toBe("number");
    expect(deadline).toBeGreaterThan(Date.now());
  });

  it("adopts the helper it already spawned when the parked call is replayed", async () => {
    const { spawning, persisted } = harness();

    const first = await spawning.spawn(CALL);
    const replay = await spawning.spawn(CALL);

    // A second helper here would double the work and park on a child nothing is waiting for.
    expect(persisted).toHaveLength(1);
    expect(replay.childRunId).toBe(first.childRunId);
    expect(replay.waitId).toBe(first.waitId);
  });

  it("spawns a second helper for a different Tool call", async () => {
    const { spawning, persisted } = harness();

    await spawning.spawn(CALL);
    await spawning.spawn({ ...CALL, callId: "call-2" });

    expect(persisted).toHaveLength(2);
  });

  it("answers directly when the helper already finished before the caller could park", async () => {
    const { spawning } = harness({ answer: { status: "succeeded", answer: "all clear" } });

    const outcome = await spawning.spawn(CALL);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.answer).toBe("all clear");
    expect(outcome.waitId).toBeNull();
  });

  it("reports a failed helper rather than parking on one that will never answer", async () => {
    const { spawning } = harness({ answer: { status: "failed", answer: null } });

    const outcome = await spawning.spawn(CALL);

    expect(outcome.status).toBe("failed");
    expect(outcome.waitId).toBeNull();
  });
});
