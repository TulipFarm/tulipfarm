import type { TaskRecord, TaskStore, UpsertTaskInput } from "@tulipfarm/storage";
import { TaskStoreError } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { TASK_TOOLS, type TaskToolContext, taskCloseTool, taskCreateTool } from "./tools";

function taskFrom(input: UpsertTaskInput, id = "task-1"): TaskRecord {
  return {
    id,
    businessId: input.businessId,
    assigneeKind: input.assigneeKind,
    assigneeId: input.assigneeId,
    dedupeKey: input.dedupeKey,
    title: input.title,
    action: input.action,
    blocking: input.blocking ?? false,
    priority: input.priority ?? 0,
    status: "open",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.originAgentId === undefined ? {} : { originAgentId: input.originAgentId }),
    ...(input.originRunId === undefined ? {} : { originRunId: input.originRunId }),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
  };
}

class FakeTaskStore implements TaskStore {
  upserted: UpsertTaskInput[] = [];
  closed: { businessId: string; dedupeKey: string }[] = [];
  dismissedKeys = new Set<string>();

  async upsertOpen(input: UpsertTaskInput): Promise<TaskRecord> {
    if (this.dismissedKeys.has(input.dedupeKey)) {
      throw new TaskStoreError("dismissed_permanently", `task ${input.dedupeKey} was dismissed`);
    }
    this.upserted.push(input);
    return taskFrom(input);
  }
  async closeByDedupeKey(businessId: string, dedupeKey: string): Promise<void> {
    this.closed.push({ businessId, dedupeKey });
  }
  async get(): Promise<TaskRecord | undefined> {
    return undefined;
  }
  async listForPrincipal(): Promise<TaskRecord[]> {
    return [];
  }
  async claim(): Promise<TaskRecord> {
    throw new Error("not implemented");
  }
  async markDone(): Promise<TaskRecord> {
    throw new Error("not implemented");
  }
  async snooze(): Promise<TaskRecord> {
    throw new Error("not implemented");
  }
  async dismiss(): Promise<TaskRecord> {
    throw new Error("not implemented");
  }
}

function ctxFor(store: FakeTaskStore, agentId?: string, runId?: string): TaskToolContext {
  return { businessId: "biz-1", tasks: store, agentId, runId };
}

const VALID_CREATE_ARGS = {
  assignee: { kind: "role", id: "admin" },
  dedupeKey: "github-triage-agent-missing",
  title: "Set up the GitHub triage Agent",
  action: { kind: "chat", prompt: "Want me to set up GitHub triage?" },
};

describe("task_create / task_close Tool definitions", () => {
  it("derives an assignee target ref the broker can authority-intersect against", () => {
    expect(taskCreateTool.targetsFor(VALID_CREATE_ARGS)).toEqual([
      { type: "task.assignee", id: "role:admin" },
    ]);
    expect(taskCreateTool.targetsFor({ assignee: { kind: "user", id: "u-1" } })).toEqual([
      { type: "task.assignee", id: "user:u-1" },
    ]);
  });

  it("target derivation tolerates missing/malformed arguments", () => {
    for (const args of [{}, { unexpected: true }, null, { assignee: "nope" }]) {
      expect(() => taskCreateTool.targetsFor(args)).not.toThrow();
      expect(taskCreateTool.targetsFor(args)).toEqual([]);
    }
  });

  it("task_create upserts through the store and stamps origin lineage from ctx", async () => {
    const store = new FakeTaskStore();
    const res = await taskCreateTool.handler(VALID_CREATE_ARGS, ctxFor(store, "agent-1", "run-1"));
    expect(res).toMatchObject({ success: true, data: { status: "open" } });
    expect(store.upserted).toHaveLength(1);
    expect(store.upserted[0]).toMatchObject({
      businessId: "biz-1",
      assigneeKind: "role",
      assigneeId: "admin",
      dedupeKey: "github-triage-agent-missing",
      originAgentId: "agent-1",
      originRunId: "run-1",
    });
  });

  it("task_create omits origin lineage fields when ctx has no agent/run id", async () => {
    const store = new FakeTaskStore();
    await taskCreateTool.handler(VALID_CREATE_ARGS, ctxFor(store));
    expect(store.upserted[0].originAgentId).toBeUndefined();
    expect(store.upserted[0].originRunId).toBeUndefined();
  });

  it("rejects an unknown role assignee", async () => {
    const store = new FakeTaskStore();
    const res = await taskCreateTool.handler(
      { ...VALID_CREATE_ARGS, assignee: { kind: "role", id: "owner" } },
      ctxFor(store)
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(store.upserted).toHaveLength(0);
  });

  it("rejects malformed arguments (schema validation, additionalProperties:false)", async () => {
    const store = new FakeTaskStore();
    const res = await taskCreateTool.handler(
      { ...VALID_CREATE_ARGS, extra: "nope" },
      ctxFor(store)
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("surfaces a dismissed dedupe key as write_denied, not a thrown error", async () => {
    const store = new FakeTaskStore();
    store.dismissedKeys.add(VALID_CREATE_ARGS.dedupeKey);
    const res = await taskCreateTool.handler(VALID_CREATE_ARGS, ctxFor(store));
    expect(res).toMatchObject({ success: false, error: { code: "write_denied" } });
  });

  it("task_close closes by dedupe key on the store", async () => {
    const store = new FakeTaskStore();
    const res = await taskCloseTool.handler(
      { dedupeKey: "employee-count", reason: "answered in chat" },
      ctxFor(store)
    );
    expect(res).toMatchObject({ success: true, data: { closed: true } });
    expect(store.closed).toEqual([{ businessId: "biz-1", dedupeKey: "employee-count" }]);
  });

  it("task_close rejects a missing reason", async () => {
    const store = new FakeTaskStore();
    const res = await taskCloseTool.handler({ dedupeKey: "employee-count" }, ctxFor(store));
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("both Tools are mutating and never throw on bad input", async () => {
    for (const tool of TASK_TOOLS) {
      expect(tool.mutating).toBe(true);
      await expect(tool.handler(null, ctxFor(new FakeTaskStore()))).resolves.toMatchObject({
        success: false,
      });
    }
  });
});
