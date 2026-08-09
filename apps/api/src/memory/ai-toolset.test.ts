import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { FRONTEND_TOOLS } from "../platform/frontend-tools";
import { buildToolRegistry } from "../tools/setup";
import { assertValidAssertion, type MemoryAssertionView, type MemoryRepo } from "./assertion-view";
import type { MemoryLifecycleService } from "./lifecycle-service";
import { MemoryService } from "./service";
import type { ToolCallResult } from "./tool-result";

class FakeMemoryRepo implements MemoryRepo {
  docs: MemoryAssertionView[] = [];
  async upsert(doc: MemoryAssertionView): Promise<void> {
    assertValidAssertion(doc);
    const i = this.docs.findIndex((d) => d.userId === doc.userId && d.key === doc.key);
    if (i >= 0) this.docs[i] = { ...doc };
    else this.docs.push({ ...doc });
  }
  async deleteByKey(userId: string, key: string): Promise<boolean> {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !(d.userId === userId && d.key === key));
    return this.docs.length < before;
  }
  async listByUser(userId: string): Promise<MemoryAssertionView[]> {
    return this.docs.filter((d) => d.userId === userId).map((d) => ({ ...d }));
  }
}

type ExecFn = (args: unknown, options: unknown) => Promise<ToolCallResult>;
function exec(set: ToolSet, name: string, args: unknown): Promise<ToolCallResult> {
  const fn = set[name].execute as unknown as ExecFn;
  return fn(args, { toolCallId: "call_1", messages: [] });
}

function setup(lifecycle?: MemoryLifecycleService): { set: ToolSet; repo: FakeMemoryRepo } {
  const repo = new FakeMemoryRepo();
  const registry = buildToolRegistry({
    memory: new MemoryService(repo),
    ...(lifecycle === undefined ? {} : { memoryLifecycle: lifecycle }),
  });
  const allowedToolNames = new Set(registry.getAll().map((tool) => tool.name));
  return {
    set: registry.buildToolSet(
      { userId: "u1" },
      undefined,
      undefined,
      undefined,
      undefined,
      allowedToolNames
    ),
    repo,
  };
}

function memoryToolNames(set: ToolSet): string[] {
  // Frontend tools are always-on (no service) and covered separately; filter to the memory family.
  const frontendNames = new Set(FRONTEND_TOOLS.map((t) => t.name));
  return Object.keys(set)
    .filter((k) => !frontendNames.has(k))
    .sort();
}

describe("memory tools via ToolRegistry", () => {
  it("offers only the tools whose services are wired", () => {
    // No recall service and no lifecycle service, so neither of their tools is registered — an
    // agent is never shown a tool that can only fail.
    expect(memoryToolNames(setup().set)).toEqual(["delete_memory", "update_memory"]);
  });

  it("registers remember_correction once the lifecycle service is supplied", () => {
    const lifecycle = { rememberCorrection: async () => ({ outcome: "saved" }) };
    const { set } = setup(lifecycle as unknown as MemoryLifecycleService);
    expect(memoryToolNames(set)).toEqual(["delete_memory", "remember_correction", "update_memory"]);
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
