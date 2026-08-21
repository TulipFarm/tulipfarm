import { PGlite } from "@electric-sql/pglite";
import { type CuratorEffect, curatorDedupeKey, type ProposalKind } from "@tulipfarm/curator";
import {
  CURATOR_STORAGE_STATEMENTS,
  CURATOR_WORK_STORAGE_STATEMENTS,
  type CuratorJobRecord,
  CuratorRepo,
  TASK_STORAGE_STATEMENTS,
  TaskRepo,
  type TaskStore,
  type TaskStoreError,
  type TransactionPort,
} from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CuratorTaskDelivery } from "./delivery";

const BUSINESS = "business-1";
const USER = "user-1";
const NOW = new Date("2026-08-21T00:00:00.000Z");

function transactions(database: PGlite): TransactionPort {
  return { withTransaction: (operation) => database.transaction((tx) => operation(tx as never)) };
}

function proposal(
  kind: ProposalKind = "create_agent_for_integration"
): Extract<CuratorEffect, { kind: "proposal" }> {
  const subjectId = "github";
  return {
    kind: "proposal",
    proposalKind: kind,
    subjectId,
    subjectLabel: "GitHub",
    deliver: ["task"],
    dedupeKey: curatorDedupeKey(kind, subjectId),
    rationale: "An agent can handle incoming GitHub work.",
    citations: [{ turnId: "turn-1", quote: "Please handle our GitHub issues." }],
  };
}

describe("CuratorTaskDelivery (PostgreSQL)", () => {
  let database: PGlite;
  let curator: CuratorRepo;
  let tasks: TaskRepo;

  async function seed(effect: CuratorEffect = proposal()): Promise<CuratorJobRecord> {
    const job = await curator.insertJob(database as never, {
      businessId: BUSINESS,
      scope: "user",
      userId: USER,
      state: "running",
      executionMode: "shadow",
      manifestDigest: "digest-1",
      manifest: { work: [], turnIds: [], candidateIds: [] },
    });
    if (!job) throw new Error("expected job");
    await curator.settle({
      job,
      outputDigest: `output-${job.id}`,
      generation: 1,
      effects: [
        {
          kind: effect.kind,
          payload: effect,
          executionMode:
            effect.kind === "proposal" && effect.deliver.includes("task") ? "apply" : "shadow",
        },
      ],
      rejections: [],
    });
    return job;
  }

  function delivery(taskStore: TaskStore = tasks) {
    return new CuratorTaskDelivery({ repo: curator, tasks: taskStore, now: () => NOW });
  }

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [
      ...TASK_STORAGE_STATEMENTS,
      ...CURATOR_STORAGE_STATEMENTS,
      ...CURATOR_WORK_STORAGE_STATEMENTS,
    ]) {
      await database.exec(sql);
    }
    curator = new CuratorRepo(database as never);
    tasks = new TaskRepo(transactions(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec(
      "DELETE FROM curator_task_metadata; DELETE FROM curator_job; DELETE FROM tasks;"
    );
  });

  it("creates one direct-user Task from a pending Proposal and records its delivery", async () => {
    const job = await seed();

    await expect(delivery().run(BUSINESS)).resolves.toEqual({
      delivered: 1,
      retryableFailed: 0,
      terminalRejected: 0,
    });

    const [effect] = await curator.listEffects(job.id);
    expect(effect).toMatchObject({ executionMode: "apply", state: "succeeded" });
    const visible = await tasks.listForPrincipal(BUSINESS, USER, [], false);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      assigneeKind: "user",
      assigneeId: USER,
      title: "Create an agent for GitHub",
      action: { kind: "chat", prompt: "Help me create an agent that works my GitHub integration." },
    });
    const metadata = await database.query<{ kind: string; rationale: string }>(
      "SELECT kind, rationale FROM curator_task_metadata WHERE task_id = $1",
      [visible[0]?.id]
    );
    expect(metadata.rows).toEqual([
      {
        kind: "create_agent_for_integration",
        rationale: "An agent can handle incoming GitHub work.",
      },
    ]);
  });

  it("retries a crash after the idempotent Task upsert without creating a duplicate", async () => {
    const job = await seed();
    let fail = true;
    const failAfterWrite = Object.assign(Object.create(tasks), {
      upsertOpen: async (...args: Parameters<TaskRepo["upsertOpen"]>) => {
        const task = await tasks.upsertOpen(...args);
        if (fail) {
          fail = false;
          throw new Error("crashed after task write");
        }
        return task;
      },
    }) as TaskStore;

    await expect(delivery(failAfterWrite).run(BUSINESS)).resolves.toMatchObject({
      retryableFailed: 1,
    });
    await expect(delivery().run(BUSINESS)).resolves.toMatchObject({ delivered: 1 });

    const [effect] = await curator.listEffects(job.id);
    expect(effect?.state).toBe("succeeded");
    expect(await tasks.listForPrincipal(BUSINESS, USER, [], false)).toHaveLength(1);
  });

  it("preserves a permanent dismissal instead of recreating the Task", async () => {
    const effect = proposal();
    const existing = await tasks.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "user",
        assigneeId: USER,
        dedupeKey: effect.dedupeKey,
        title: "Old suggestion",
        action: { kind: "ack" },
      },
      NOW
    );
    await tasks.dismiss(BUSINESS, existing.id, NOW);
    const job = await seed(effect);

    await expect(delivery().run(BUSINESS)).resolves.toMatchObject({ terminalRejected: 1 });

    const [stored] = await curator.listEffects(job.id);
    expect(stored?.state).toBe("terminal_rejected");
    await expect(
      tasks.upsertOpen(
        {
          businessId: BUSINESS,
          assigneeKind: "user",
          assigneeId: USER,
          dedupeKey: effect.dedupeKey,
          title: "Never recreate",
          action: { kind: "ack" },
        },
        NOW
      )
    ).rejects.toMatchObject({ code: "dismissed_permanently" } satisfies Partial<TaskStoreError>);
  });
});
