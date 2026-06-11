import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { buildToolRegistry } from "../tools/setup";
import { WorkingMemoryService } from "./service";
import type { ToolCallResult } from "./tool-result";
import { assertValidEntry, type WorkingMemoryDoc, type WorkingMemoryRepo } from "./working-memory";

class FakeWorkingMemoryRepo implements WorkingMemoryRepo {
  docs: WorkingMemoryDoc[] = [];
  async upsert(doc: WorkingMemoryDoc): Promise<void> {
    assertValidEntry(doc);
    const i = this.docs.findIndex((d) => d.userId === doc.userId && d.key === doc.key);
    if (i >= 0) this.docs[i] = { ...doc };
    else this.docs.push({ ...doc });
  }
  async deleteByKey(userId: string, key: string): Promise<boolean> {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !(d.userId === userId && d.key === key));
    return this.docs.length < before;
  }
  async listByUser(userId: string): Promise<WorkingMemoryDoc[]> {
    return this.docs.filter((d) => d.userId === userId).map((d) => ({ ...d }));
  }
}

type ExecFn = (args: unknown, options: unknown) => Promise<ToolCallResult>;
function exec(set: ToolSet, name: string, args: unknown): Promise<ToolCallResult> {
  const fn = set[name].execute as unknown as ExecFn;
  return fn(args, { toolCallId: "call_1", messages: [] });
}

function setup(): { set: ToolSet; repo: FakeWorkingMemoryRepo } {
  const repo = new FakeWorkingMemoryRepo();
  const registry = buildToolRegistry({ workingMemory: new WorkingMemoryService(repo) });
  return { set: registry.buildToolSet({ userId: "u1" }), repo };
}

describe("memory tools via ToolRegistry", () => {
  it("exposes the two memory tools keyed by name", () => {
    const { set } = setup();
    expect(Object.keys(set).sort()).toEqual(["delete_memory", "update_memory"]);
  });

  it("update_memory.execute round-trips to the service, scoped to the context user", async () => {
    const { set, repo } = setup();
    const res = await exec(set, "update_memory", { key: "plan", value: "enterprise" });
    expect(res).toMatchObject({ success: true });
    expect(repo.docs).toHaveLength(1);
    expect(repo.docs[0]).toMatchObject({ userId: "u1", key: "plan", value: "enterprise" });
  });

  it("surfaces an oversized write as a result (not a throw)", async () => {
    const { set, repo } = setup();
    const res = await exec(set, "update_memory", { key: "bio", value: "x".repeat(1025) });
    expect(res).toMatchObject({ success: false, error: { code: "oversize_value" } });
    expect(repo.docs).toHaveLength(0);
  });
});
