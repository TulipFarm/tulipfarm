import { describe, expect, it } from "vitest";
import { WorkingMemoryService } from "./service";
import { deleteMemoryTool, MEMORY_TOOLS, type ToolContext, updateMemoryTool } from "./tools";
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

function makeCtx(): { ctx: ToolContext; repo: FakeWorkingMemoryRepo } {
  const repo = new FakeWorkingMemoryRepo();
  return {
    ctx: { userId: "u1", service: new WorkingMemoryService(repo), agentId: "agent-a" },
    repo,
  };
}

describe("updateMemoryTool", () => {
  it("upserts a fact scoped to the context user and returns success", async () => {
    const { ctx, repo } = makeCtx();
    const res = await updateMemoryTool.handler({ key: "plan", value: "enterprise" }, ctx);
    expect(res).toEqual({ success: true, data: { key: "plan", stored: true } });
    expect(repo.docs).toHaveLength(1);
    expect(repo.docs[0]).toMatchObject({ userId: "u1", key: "plan", value: "enterprise" });
  });

  it("rejects an oversized value with an oversize_value error that points to knowledge", async () => {
    const { ctx, repo } = makeCtx();
    const res = await updateMemoryTool.handler({ key: "bio", value: "x".repeat(1025) }, ctx);
    expect(res.success).toBe(false);
    if (res.success) throw new Error("expected failure");
    expect(res.error.code).toBe("oversize_value");
    expect(res.error.message).toContain("create_knowledge_page");
    expect(repo.docs).toHaveLength(0);
  });

  it("returns a validation_error result (never throws) for bad args", async () => {
    const { ctx } = makeCtx();
    await expect(updateMemoryTool.handler({ value: "no key" }, ctx)).resolves.toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    await expect(updateMemoryTool.handler({ key: "k", value: 5 }, ctx)).resolves.toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
  });

  it("documents the appropriate-use guidance in its description", () => {
    expect(updateMemoryTool.description).toContain("small, stable, personal facts");
    expect(updateMemoryTool.description).toContain("create_knowledge_page");
    expect(updateMemoryTool.mutating).toBe(true);
  });
});

describe("deleteMemoryTool", () => {
  it("removes a present key", async () => {
    const { ctx, repo } = makeCtx();
    await updateMemoryTool.handler({ key: "plan", value: "enterprise" }, ctx);
    const res = await deleteMemoryTool.handler({ key: "plan" }, ctx);
    expect(res).toEqual({ success: true, data: { key: "plan", deleted: true } });
    expect(repo.docs).toHaveLength(0);
  });

  it("is idempotent — deleting an absent key still succeeds", async () => {
    const { ctx } = makeCtx();
    const res = await deleteMemoryTool.handler({ key: "never-set" }, ctx);
    expect(res).toEqual({ success: true, data: { key: "never-set", deleted: false } });
  });

  it("returns a validation_error result for missing key", async () => {
    const { ctx } = makeCtx();
    await expect(deleteMemoryTool.handler({}, ctx)).resolves.toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
  });
});

describe("MEMORY_TOOLS registry", () => {
  it("exposes exactly the two mutating memory tools", () => {
    expect(MEMORY_TOOLS.map((t) => t.name)).toEqual(["update_memory", "delete_memory"]);
    expect(MEMORY_TOOLS.every((t) => t.mutating)).toBe(true);
  });
});
