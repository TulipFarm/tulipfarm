import { describe, expect, it } from "vitest";
import { WorkingMemoryService } from "./service";
import { assertValidEntry, type WorkingMemoryDoc, type WorkingMemoryRepo } from "./working-memory";

// In-memory repo mirroring the store's semantics (upsert by {userId,key}; list oldest-written first).
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
    return this.docs
      .filter((d) => d.userId === userId)
      .sort((a, b) => a.lastWrittenAt.getTime() - b.lastWrittenAt.getTime())
      .map((d) => ({ ...d }));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const U = "u1";

describe("WorkingMemoryService.update", () => {
  it("stores a new key", async () => {
    const repo = new FakeWorkingMemoryRepo();
    const svc = new WorkingMemoryService(repo);

    await expect(svc.update(U, "plan", "enterprise")).resolves.toEqual({ kind: "ok" });
    const entries = await repo.listByUser(U);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: "plan", value: "enterprise" });
  });

  it("upsert of an existing key replaces value, preserves createdAt, advances lastWrittenAt", async () => {
    const repo = new FakeWorkingMemoryRepo();
    const svc = new WorkingMemoryService(repo);

    await svc.update(U, "plan", "free");
    const first = (await repo.listByUser(U))[0];
    await sleep(3);
    await svc.update(U, "plan", "enterprise");
    const second = (await repo.listByUser(U))[0];

    expect(await repo.listByUser(U)).toHaveLength(1);
    expect(second.value).toBe("enterprise");
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.lastWrittenAt.getTime()).toBeGreaterThan(first.lastWrittenAt.getTime());
  });

  it("records the writing agent for attribution", async () => {
    const repo = new FakeWorkingMemoryRepo();
    const svc = new WorkingMemoryService(repo);
    await svc.update(U, "plan", "enterprise", "agent-a");
    expect((await repo.listByUser(U))[0].writtenByAgentId).toBe("agent-a");
  });

  it("rejects an oversized value and writes nothing", async () => {
    const repo = new FakeWorkingMemoryRepo();
    const svc = new WorkingMemoryService(repo);

    const outcome = await svc.update(U, "bio", "x".repeat(1025));
    expect(outcome).toEqual({ kind: "rejected_oversize" });
    expect(await repo.listByUser(U)).toHaveLength(0);
  });

  it("LRU-evicts the oldest entry once over the 30-entry cap, keeping the just-written key", async () => {
    const repo = new FakeWorkingMemoryRepo();
    const svc = new WorkingMemoryService(repo);

    for (let i = 0; i < 30; i++) await svc.update(U, `k${i}`, `v${i}`);
    expect(await repo.listByUser(U)).toHaveLength(30);

    await svc.update(U, "k30", "v30");
    const keys = (await repo.listByUser(U)).map((e) => e.key);
    expect(keys).toHaveLength(30);
    expect(keys).not.toContain("k0"); // oldest evicted
    expect(keys).toContain("k30"); // just-written survives
  });

  it("LRU-evicts oldest entries once over the ~2k total-char cap", async () => {
    const repo = new FakeWorkingMemoryRepo();
    const svc = new WorkingMemoryService(repo);
    const big = "x".repeat(600); // 4 × ~602 chars = ~2408 > 2048

    await svc.update(U, "k0", big);
    await svc.update(U, "k1", big);
    await svc.update(U, "k2", big);
    await svc.update(U, "k3", big);

    const entries = await repo.listByUser(U);
    const total = entries.reduce((s, e) => s + e.key.length + e.value.length, 0);
    expect(total).toBeLessThanOrEqual(2048);
    const keys = entries.map((e) => e.key);
    expect(keys).not.toContain("k0");
    expect(keys).toContain("k3");
  });

  it("re-writing an existing key while at the entry cap does not evict", async () => {
    const repo = new FakeWorkingMemoryRepo();
    const svc = new WorkingMemoryService(repo);

    for (let i = 0; i < 30; i++) await svc.update(U, `k${i}`, `v${i}`);
    await svc.update(U, "k5", "updated");

    const entries = await repo.listByUser(U);
    expect(entries).toHaveLength(30);
    expect(entries.map((e) => e.key)).toContain("k0");
    expect(entries.find((e) => e.key === "k5")?.value).toBe("updated");
  });
});

describe("WorkingMemoryService.delete", () => {
  it("returns true when a present key is removed", async () => {
    const repo = new FakeWorkingMemoryRepo();
    const svc = new WorkingMemoryService(repo);
    await svc.update(U, "plan", "enterprise");
    await expect(svc.delete(U, "plan")).resolves.toBe(true);
    expect(await repo.listByUser(U)).toHaveLength(0);
  });

  it("returns false (idempotent no-op) when the key is absent", async () => {
    const repo = new FakeWorkingMemoryRepo();
    const svc = new WorkingMemoryService(repo);
    await expect(svc.delete(U, "never-set")).resolves.toBe(false);
  });
});
