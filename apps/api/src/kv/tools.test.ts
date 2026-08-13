import { describe, expect, it } from "vitest";
import { assertValidAssertion, type KvEntry, type KvRepo, type KvScope } from "./repo";
import { KvService } from "./service";
import {
  KV_TOOLS,
  type KvToolContext,
  kvDeleteTool,
  kvGetTool,
  kvListTool,
  kvSetTool,
} from "./tools";

function ownerKey(scope: KvScope, ownerId: string | undefined): string {
  return scope === "system" ? "" : (ownerId ?? "");
}

/** Minimal in-memory repo for tool tests; exposes `rows` so we can assert how entries were scoped. */
class FakeKvRepo implements KvRepo {
  rows: KvEntry[] = [];
  private idx(s: KvScope, o: string | undefined, ns: string, k?: string): number {
    return this.rows.findIndex(
      (e) =>
        e.scope === s &&
        ownerKey(e.scope, e.ownerId) === ownerKey(s, o) &&
        e.namespace === ns &&
        (k === undefined || e.key === k)
    );
  }
  private live(e: KvEntry): boolean {
    return !e.expiresAt || e.expiresAt.getTime() > Date.now();
  }
  async upsert(doc: KvEntry): Promise<void> {
    assertValidAssertion(doc);
    const n: KvEntry = { ...doc, ownerId: doc.scope === "system" ? undefined : doc.ownerId };
    const i = this.idx(n.scope, n.ownerId, n.namespace, n.key);
    if (i >= 0)
      this.rows[i] = {
        ...this.rows[i],
        value: n.value,
        expiresAt: n.expiresAt,
        updatedAt: n.updatedAt,
      };
    else this.rows.push({ ...n });
  }
  async get(s: KvScope, o: string | undefined, ns: string, k: string): Promise<KvEntry | null> {
    const i = this.idx(s, o, ns, k);
    return i >= 0 && this.live(this.rows[i]) ? { ...this.rows[i] } : null;
  }
  async delete(s: KvScope, o: string | undefined, ns: string, k: string): Promise<boolean> {
    const i = this.idx(s, o, ns, k);
    if (i < 0 || !this.live(this.rows[i])) return false;
    this.rows.splice(i, 1);
    return true;
  }
  async listByNamespace(s: KvScope, o: string | undefined, ns: string): Promise<KvEntry[]> {
    return this.rows.filter(
      (e) =>
        e.scope === s &&
        ownerKey(e.scope, e.ownerId) === ownerKey(s, o) &&
        e.namespace === ns &&
        this.live(e)
    );
  }
}

function ctxFor(repo: FakeKvRepo, agentId?: string): KvToolContext {
  return { userId: "u1", agentId, service: new KvService(repo) };
}

function expectNoMalformedTargets(tool: (typeof KV_TOOLS)[number], args: unknown): void {
  expect(() => tool.targetsFor(args)).not.toThrow();
  for (const ref of tool.targetsFor(args)) {
    expect(ref.type).not.toMatch(/undefined|null/);
    expect(ref.id).not.toMatch(/undefined|null/);
  }
}

describe("KV agent tools", () => {
  it("target derivations tolerate empty and unexpected raw arguments", () => {
    for (const tool of KV_TOOLS) {
      expectNoMalformedTargets(tool, {});
      expectNoMalformedTargets(tool, { unexpected: true });
      expectNoMalformedTargets(tool, null);
    }
  });

  it("entry operations derive both namespace and entry targets", () => {
    for (const tool of [kvGetTool, kvSetTool, kvDeleteTool]) {
      expect(tool.targetsFor({ namespace: "scratch", key: "k" })).toEqual([
        { type: "platform.kv", id: "namespace:scratch" },
        { type: "platform.kv", id: "entry:scratch:k" },
      ]);
    }
  });

  it("entry operations derive only genuinely determined partial targets", () => {
    for (const tool of [kvGetTool, kvSetTool, kvDeleteTool]) {
      expect(tool.targetsFor({ namespace: "scratch" })).toEqual([
        { type: "platform.kv", id: "namespace:scratch" },
      ]);
      expect(tool.targetsFor({ key: "k" })).toEqual([]);
      expect(tool.targetsFor({ namespace: { name: "scratch" }, key: "k" })).toEqual([]);
    }
  });

  it("kv_set pins the entry to scope='agent' and owner = ctx.agentId", async () => {
    const repo = new FakeKvRepo();
    const res = await kvSetTool.handler(
      { namespace: "scratch", key: "k", value: { a: 1 } },
      ctxFor(repo, "agent-x")
    );
    expect(res).toMatchObject({ success: true });
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({
      scope: "agent",
      ownerId: "agent-x",
      namespace: "scratch",
      key: "k",
    });
  });

  it("rejects args that try to specify scope or owner (additionalProperties:false)", async () => {
    const res = await kvSetTool.handler(
      { namespace: "scratch", key: "k", value: 1, scope: "system", owner_id: "x" },
      ctxFor(new FakeKvRepo(), "agent-x")
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("prevents cross-agent reads: agent-y cannot see agent-x's key", async () => {
    const repo = new FakeKvRepo();
    await kvSetTool.handler(
      { namespace: "scratch", key: "secret", value: 42 },
      ctxFor(repo, "agent-x")
    );
    const res = await kvGetTool.handler(
      { namespace: "scratch", key: "secret" },
      ctxFor(repo, "agent-y")
    );
    expect(res).toEqual({
      success: true,
      data: { namespace: "scratch", key: "secret", found: false },
    });
  });

  it("kv_get returns the stored value for the owning agent", async () => {
    const repo = new FakeKvRepo();
    await kvSetTool.handler(
      { namespace: "scratch", key: "k", value: { a: 1 } },
      ctxFor(repo, "agent-x")
    );
    const res = await kvGetTool.handler(
      { namespace: "scratch", key: "k" },
      ctxFor(repo, "agent-x")
    );
    expect(res).toMatchObject({ success: true, data: { found: true, value: { a: 1 } } });
  });

  it("rejects an oversize value with code oversize_value, storing nothing", async () => {
    const repo = new FakeKvRepo();
    const res = await kvSetTool.handler(
      { namespace: "scratch", key: "big", value: "x".repeat(256 * 1024 + 1) },
      ctxFor(repo, "agent-x")
    );
    expect(res).toMatchObject({ success: false, error: { code: "oversize_value" } });
    expect(repo.rows).toHaveLength(0);
  });

  it("errors when the agent identity is missing", async () => {
    const res = await kvSetTool.handler(
      { namespace: "scratch", key: "k", value: 1 },
      ctxFor(new FakeKvRepo(), undefined)
    );
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("kv_delete is idempotent and kv_get reports absence", async () => {
    const repo = new FakeKvRepo();
    const del = await kvDeleteTool.handler(
      { namespace: "n", key: "missing" },
      ctxFor(repo, "agent-x")
    );
    expect(del).toEqual({
      success: true,
      data: { namespace: "n", key: "missing", deleted: false },
    });
  });

  it("kv_set with ttlSeconds stores an expiry and kv_list returns live entries", async () => {
    const repo = new FakeKvRepo();
    await kvSetTool.handler(
      { namespace: "n", key: "k", value: 1, ttlSeconds: 60 },
      ctxFor(repo, "agent-x")
    );
    expect(repo.rows[0].expiresAt).toBeInstanceOf(Date);
    const list = await kvListTool.handler({ namespace: "n" }, ctxFor(repo, "agent-x"));
    expect(list).toMatchObject({ success: true, data: { entries: [{ key: "k", value: 1 }] } });
  });

  it("exposes exactly the four kv_* tools", () => {
    expect(KV_TOOLS.map((t) => t.name).sort()).toEqual([
      "kv_delete",
      "kv_get",
      "kv_list",
      "kv_set",
    ]);
  });
});
