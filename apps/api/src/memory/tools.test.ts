import type { MemoryAssertion, RememberResult } from "@tulipfarm/memory";
import { describe, expect, it } from "vitest";
import { assertValidAssertion, type MemoryAssertionView, type MemoryRepo } from "./assertion-view";
import type { MemoryLifecycleService } from "./lifecycle-service";
import { MAX_ENTRIES, MAX_KEY_CHARS, MAX_VALUE_CHARS } from "./limits";
import type { MemoryRecallService } from "./recall-service";
import { MemoryService } from "./service";
import {
  deleteMemoryTool,
  MEMORY_TOOLS,
  recallMemoryTool,
  rememberCorrectionTool,
  type ToolContext,
  updateMemoryTool,
} from "./tools";

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

function makeCtx(): { ctx: ToolContext; repo: FakeMemoryRepo } {
  const repo = new FakeMemoryRepo();
  return {
    ctx: { userId: "u1", service: new MemoryService(repo), agentId: "agent-a" },
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
  it("exposes the three mutating write tools and the read-only recall tool", () => {
    expect(MEMORY_TOOLS.map((t) => t.name)).toEqual([
      "update_memory",
      "delete_memory",
      "recall_memory",
      "remember_correction",
    ]);
    expect(MEMORY_TOOLS.filter((t) => t.mutating).map((t) => t.name)).toEqual([
      "update_memory",
      "delete_memory",
      "remember_correction",
    ]);
  });
});

describe("recallMemoryTool", () => {
  function ctxWith(
    recall: (
      userId: string,
      query: string,
      limit: number,
      agentId?: string
    ) => Promise<readonly MemoryAssertion[]>
  ): ToolContext {
    const { ctx } = makeCtx();
    return { ...ctx, recall: { recall } as unknown as MemoryRecallService };
  }

  function assertion(over: Partial<MemoryAssertion> = {}): MemoryAssertion {
    const at = "2025-01-01T00:00:00.000Z";
    return {
      assertionId: "a1",
      businessId: "biz",
      target: { scope: "user_private", businessId: "biz", subjectPrincipalId: "u1" },
      subject: "coffee",
      statement: "prefers oat milk",
      memoryType: "preference",
      trustTier: "user_stated",
      confidence: 1,
      importance: 0.5,
      provenance: {
        origin: "explicit",
        authorPrincipalId: "u1",
        evidence: [{ kind: "message", ref: "m1" }],
      },
      confirmation: "confirmed",
      status: "active",
      version: 1,
      createdAt: at,
      updatedAt: at,
      validFrom: at,
      entities: [],
      accessCount: 0,
      ...over,
    };
  }

  it("returns only model-facing fields, never ids or provenance", async () => {
    const ctx = ctxWith(async () => [assertion()]);
    const res = await recallMemoryTool.handler({ query: "milk" }, ctx);
    expect(res).toEqual({
      success: true,
      data: {
        query: "milk",
        memories: [
          {
            subject: "coffee",
            statement: "prefers oat milk",
            type: "preference",
            recordedAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      },
    });
  });

  it("recalls as the context user and agent, ignoring any caller-supplied identity", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith(async (userId, query, limit, agentId) => {
      seen.push({ userId, query, limit, agentId });
      return [];
    });
    await recallMemoryTool.handler({ query: "milk", userId: "attacker" }, ctx);
    // The extra property is rejected outright, so nothing is recalled under a forged identity.
    expect(seen).toEqual([]);

    await recallMemoryTool.handler({ query: "milk" }, ctx);
    expect(seen).toEqual([{ userId: "u1", query: "milk", limit: 10, agentId: "agent-a" }]);
  });

  it("clamps limit to the ceiling rather than trusting the model", async () => {
    const seen: number[] = [];
    const ctx = ctxWith(async (_u, _q, limit) => {
      seen.push(limit);
      return [];
    });
    // Above the schema maximum is a validation error, not a silent clamp.
    const tooBig = await recallMemoryTool.handler({ query: "milk", limit: 999 }, ctx);
    expect(tooBig).toMatchObject({ success: false, error: { code: "validation_error" } });

    await recallMemoryTool.handler({ query: "milk", limit: 3 }, ctx);
    expect(seen).toEqual([3]);
  });

  it("rejects an empty query", async () => {
    const ctx = ctxWith(async () => []);
    const res = await recallMemoryTool.handler({ query: "" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("is read-only", () => {
    expect(recallMemoryTool.mutating).toBe(false);
  });
});

describe("rememberCorrectionTool", () => {
  type Recorded = Parameters<MemoryLifecycleService["rememberCorrection"]>[0];

  function ctxWith(rememberCorrection: (input: Recorded) => Promise<RememberResult>): {
    ctx: ToolContext;
    recorded: Recorded[];
  } {
    const recorded: Recorded[] = [];
    const { ctx } = makeCtx();
    return {
      ctx: {
        ...ctx,
        lifecycle: {
          rememberCorrection: (input: Recorded) => {
            recorded.push(input);
            return rememberCorrection(input);
          },
        } as unknown as MemoryLifecycleService,
      },
      recorded,
    };
  }

  const saved: RememberResult = {
    outcome: "saved",
    assertion: { assertionId: "a1" } as unknown as MemoryAssertion,
  };

  it("records the correction as the context user and agent, not a caller-supplied identity", async () => {
    const { ctx, recorded } = ctxWith(async () => saved);

    const forged = await rememberCorrectionTool.handler(
      { subject: "reports", statement: "always include churn", userId: "attacker" },
      ctx
    );
    // The extra property is rejected outright, so nothing is written under a forged identity.
    expect(forged).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(recorded).toEqual([]);

    const res = await rememberCorrectionTool.handler(
      { subject: "reports", statement: "always include churn" },
      ctx
    );
    expect(res).toEqual({ success: true, data: { subject: "reports", stored: true } });
    expect(recorded).toEqual([
      {
        userId: "u1",
        subject: "reports",
        statement: "always include churn",
        agentId: "agent-a",
      },
    ]);
  });

  it("reports a refusal without leaking the engine's denial reason to the model", async () => {
    const { ctx } = ctxWith(async () => ({
      outcome: "denied",
      reason: "procedural_requires_explicit_correction",
    }));
    const res = await rememberCorrectionTool.handler(
      { subject: "reports", statement: "always include churn" },
      ctx
    );
    expect(res).toMatchObject({ success: false, error: { code: "write_denied" } });
    expect(JSON.stringify(res)).not.toContain("procedural_requires_explicit_correction");
  });

  it("rejects empty and oversized fields before reaching the engine", async () => {
    const { ctx, recorded } = ctxWith(async () => saved);
    for (const args of [
      { subject: "", statement: "x" },
      { subject: "x", statement: "" },
      { subject: "x".repeat(MAX_KEY_CHARS + 1), statement: "y" },
      { subject: "x", statement: "y".repeat(MAX_VALUE_CHARS + 1) },
    ]) {
      await expect(rememberCorrectionTool.handler(args, ctx)).resolves.toMatchObject({
        success: false,
        error: { code: "validation_error" },
      });
    }
    expect(recorded).toEqual([]);
  });

  it("re-applies the KV cap, so a correction cannot cost the user their whole memory block", async () => {
    // The engine write bypasses MemoryService, so without enforceCaps the `<memory>` block grows
    // past MAX_TOTAL_CHARS — and the prompt assembler drops the block whole, not the overflow.
    const { ctx, repo } = makeCtx();
    for (let i = 0; i < MAX_ENTRIES; i++) {
      await repo.upsert({
        _id: `e${i}`,
        userId: "u1",
        key: `k${i}`,
        value: "v",
        createdAt: new Date(i),
        lastWrittenAt: new Date(i),
      });
    }

    const lifecycleCtx: ToolContext = {
      ...ctx,
      lifecycle: {
        rememberCorrection: async ({
          subject,
          statement,
        }: {
          subject: string;
          statement: string;
        }) => {
          // Stand in for the engine write, which lands in the same projection MemoryService reads.
          await repo.upsert({
            _id: "correction",
            userId: "u1",
            key: subject,
            value: statement,
            createdAt: new Date(MAX_ENTRIES),
            lastWrittenAt: new Date(MAX_ENTRIES),
          });
          return saved;
        },
      } as unknown as MemoryLifecycleService,
    };

    await rememberCorrectionTool.handler(
      { subject: "reports", statement: "always include churn" },
      lifecycleCtx
    );

    const entries = await repo.listByUser("u1");
    expect(entries).toHaveLength(MAX_ENTRIES);
    // The correction survives; the oldest entry was evicted to make room for it.
    expect(entries.map((e) => e.key)).toContain("reports");
    expect(entries.map((e) => e.key)).not.toContain("k0");
  });

  it("mutates, so the broker treats it as a write", () => {
    expect(rememberCorrectionTool.mutating).toBe(true);
  });
});
