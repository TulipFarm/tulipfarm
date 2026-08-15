import { PGlite } from "@electric-sql/pglite";
import type { Queryable, TransactionPort } from "@tulipfarm/storage";
import { TASK_STORAGE_STATEMENTS, TaskRepo } from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateTaskChecks, type TaskCheckSignals } from "./task-checks";
import { reconcileTasks } from "./task-reconciler";

const BUSINESS = "business-1";

const UNSATISFIED: TaskCheckSignals = {
  hasProviderKey: false,
  businessName: undefined,
};

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

describe("reconcileTasks (against a real TaskRepo)", () => {
  let database: PGlite;
  let repo: TaskRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of TASK_STORAGE_STATEMENTS) {
      await database.exec(sql);
    }
    repo = new TaskRepo(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM tasks");
  });

  it("opens a task per unsatisfied check", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await reconcileTasks({ businessId: BUSINESS, signals: UNSATISFIED, taskStore: repo, now });

    const opened = await repo.listForPrincipal(BUSINESS, "u1", ["admin", "member"], false);
    expect(opened).toHaveLength(evaluateTaskChecks(UNSATISFIED).length);
    expect(opened.every((t) => t.status === "open")).toBe(true);
  });

  it("closes a task once its check reports satisfied, without touching others", async () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    await reconcileTasks({ businessId: BUSINESS, signals: UNSATISFIED, taskStore: repo, now: t1 });

    const t2 = new Date("2026-01-01T00:15:00Z");
    const fixedName: TaskCheckSignals = {
      ...UNSATISFIED,
      businessName: "Acme",
    };
    await reconcileTasks({
      businessId: BUSINESS,
      signals: fixedName,
      taskStore: repo,
      now: t2,
    });

    const remaining = await repo.listForPrincipal(BUSINESS, "u1", ["admin", "member"], false);
    expect(remaining.map((t) => t.dedupeKey)).not.toContain("business-name");
    expect(remaining).toHaveLength(evaluateTaskChecks(UNSATISFIED).length - 1);
  });

  it("never recreates a task a user dismissed permanently", async () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    await reconcileTasks({ businessId: BUSINESS, signals: UNSATISFIED, taskStore: repo, now: t1 });

    const opened = await repo.listForPrincipal(BUSINESS, "u1", ["admin", "member"], false);
    const providerKeyTask = opened.find((t) => t.dedupeKey === "provider-key");
    if (!providerKeyTask) throw new Error("expected a provider-key task");
    await repo.dismiss(BUSINESS, providerKeyTask.id, t1);

    const t2 = new Date("2026-01-01T00:15:00Z");
    await reconcileTasks({ businessId: BUSINESS, signals: UNSATISFIED, taskStore: repo, now: t2 });

    const live = await repo.listForPrincipal(BUSINESS, "u1", ["admin", "member"], true);
    expect(live.find((t) => t.dedupeKey === "provider-key")).toBeUndefined();
  });

  it("re-upserting the same open gap updates the row instead of duplicating it", async () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    await reconcileTasks({ businessId: BUSINESS, signals: UNSATISFIED, taskStore: repo, now: t1 });
    const t2 = new Date("2026-01-01T00:15:00Z");
    await reconcileTasks({ businessId: BUSINESS, signals: UNSATISFIED, taskStore: repo, now: t2 });

    const opened = await repo.listForPrincipal(BUSINESS, "u1", ["admin", "member"], false);
    expect(opened).toHaveLength(evaluateTaskChecks(UNSATISFIED).length);
  });
});
