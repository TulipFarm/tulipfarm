import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { TASK_STORAGE_STATEMENTS, TaskRepo, TaskStoreError } from "./task-repo";

const BUSINESS = "business-1";
const OTHER_BUSINESS = "business-2";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

describe("TaskRepo (PostgreSQL)", () => {
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

  it("creates an open task for a role assignee", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const task = await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "role",
        assigneeId: "admin",
        dedupeKey: "provider-key",
        title: "Plant your model key",
        action: { kind: "link", href: "/settings/secrets" },
        blocking: true,
      },
      now
    );
    expect(task.status).toBe("open");
    expect(task.assigneeKind).toBe("role");
    expect(task.assigneeId).toBe("admin");
    expect(task.blocking).toBe(true);
    expect(task.action).toEqual({ kind: "link", href: "/settings/secrets" });
  });

  it("re-detecting the same gap updates the existing row instead of duplicating", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const first = await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "role",
        assigneeId: "admin",
        dedupeKey: "business-name",
        title: "What's your business called?",
        action: { kind: "answer", field: "name", sink: "business_profile" },
      },
      now
    );
    const second = await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "role",
        assigneeId: "admin",
        dedupeKey: "business-name",
        title: "What's your business called? (again)",
        action: { kind: "answer", field: "name", sink: "business_profile" },
      },
      new Date("2026-01-02T00:00:00Z")
    );
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("What's your business called? (again)");

    const list = await repo.listForPrincipal(BUSINESS, "user-1", ["admin"], false);
    expect(list).toHaveLength(1);
  });

  it("closeByDedupeKey closes an open task and is a no-op once already closed", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "role",
        assigneeId: "admin",
        dedupeKey: "first-agent",
        title: "Create an agent",
        action: { kind: "chat", prompt: "Help me create an agent" },
      },
      now
    );
    await repo.closeByDedupeKey(BUSINESS, "first-agent", new Date("2026-01-02T00:00:00Z"));
    const list = await repo.listForPrincipal(BUSINESS, "user-1", ["admin"], false);
    expect(list).toHaveLength(0);

    // second close is a no-op, not an error
    await expect(
      repo.closeByDedupeKey(BUSINESS, "first-agent", new Date("2026-01-03T00:00:00Z"))
    ).resolves.toBeUndefined();
  });

  it("a dismissed task blocks recreation by the reconciler", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const task = await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "user",
        assigneeId: "user-1",
        dedupeKey: "employee-count",
        title: "How many employees do you have?",
        action: { kind: "answer", field: "employeeCount", sink: "memory" },
      },
      now
    );
    await repo.dismiss(BUSINESS, task.id, new Date("2026-01-02T00:00:00Z"));

    await expect(
      repo.upsertOpen(
        {
          businessId: BUSINESS,
          assigneeKind: "user",
          assigneeId: "user-1",
          dedupeKey: "employee-count",
          title: "How many employees do you have?",
          action: { kind: "answer", field: "employeeCount", sink: "memory" },
        },
        new Date("2026-01-03T00:00:00Z")
      )
    ).rejects.toThrow(TaskStoreError);

    const list = await repo.listForPrincipal(BUSINESS, "user-1", [], false);
    expect(list).toHaveLength(0);
  });

  it("listForPrincipal returns direct-user and role-matched tasks, ranked blocking first", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "role",
        assigneeId: "admin",
        dedupeKey: "business-description",
        title: "What does your business do?",
        action: { kind: "answer", field: "description", sink: "business_profile" },
        blocking: false,
      },
      now
    );
    await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "role",
        assigneeId: "admin",
        dedupeKey: "provider-key",
        title: "Plant your model key",
        action: { kind: "link", href: "/settings/secrets" },
        blocking: true,
      },
      now
    );
    await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "user",
        assigneeId: "user-1",
        dedupeKey: "meeting-nudge",
        title: "Meeting at 2pm",
        action: { kind: "ack" },
      },
      now
    );
    // Different business must never leak in.
    await repo.upsertOpen(
      {
        businessId: OTHER_BUSINESS,
        assigneeKind: "role",
        assigneeId: "admin",
        dedupeKey: "provider-key",
        title: "Plant your model key",
        action: { kind: "link", href: "/settings/secrets" },
        blocking: true,
      },
      now
    );

    const list = await repo.listForPrincipal(BUSINESS, "user-1", ["admin"], false);
    expect(list).toHaveLength(3);
    expect(list[0]?.dedupeKey).toBe("provider-key");
  });

  it("claim moves a role task from open to claimed, and a second claim fails", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const task = await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "role",
        assigneeId: "admin",
        dedupeKey: "github-triage-agent-missing",
        title: "No GitHub triage agent",
        action: { kind: "chat", prompt: "Help me build a GitHub triage agent" },
      },
      now
    );
    const claimed = await repo.claim(BUSINESS, task.id, "user-1", new Date("2026-01-02T00:00:00Z"));
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimedBy).toBe("user-1");

    await expect(
      repo.claim(BUSINESS, task.id, "user-2", new Date("2026-01-03T00:00:00Z"))
    ).rejects.toThrow(TaskStoreError);
  });

  it("markDone closes an open or claimed task", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const task = await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "user",
        assigneeId: "user-1",
        dedupeKey: "invite-teammates",
        title: "Invite your teammates",
        action: { kind: "link", href: "/settings/users" },
      },
      now
    );
    const done = await repo.markDone(BUSINESS, task.id, new Date("2026-01-02T00:00:00Z"));
    expect(done.status).toBe("done");
    expect(done.closedAt).toBeInstanceOf(Date);
  });

  it("snooze hides a task until a date, dismiss ends it permanently", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const task = await repo.upsertOpen(
      {
        businessId: BUSINESS,
        assigneeKind: "user",
        assigneeId: "user-1",
        dedupeKey: "first-knowledge",
        title: "Add knowledge",
        action: { kind: "chat", prompt: "Help me add a knowledge page" },
      },
      now
    );
    const snoozed = await repo.snooze(
      BUSINESS,
      task.id,
      new Date("2026-02-01T00:00:00Z"),
      new Date("2026-01-02T00:00:00Z")
    );
    expect(snoozed.status).toBe("snoozed");

    const withoutSnoozed = await repo.listForPrincipal(BUSINESS, "user-1", [], false);
    expect(withoutSnoozed).toHaveLength(0);
    const withSnoozed = await repo.listForPrincipal(BUSINESS, "user-1", [], true);
    expect(withSnoozed).toHaveLength(1);

    const dismissed = await repo.dismiss(BUSINESS, task.id, new Date("2026-01-03T00:00:00Z"));
    expect(dismissed.status).toBe("dismissed");
  });

  it("throws not_found for an unknown task id", async () => {
    await expect(
      repo.claim(BUSINESS, "00000000-0000-0000-0000-000000000000", "user-1", new Date())
    ).rejects.toThrow(TaskStoreError);
  });
});
