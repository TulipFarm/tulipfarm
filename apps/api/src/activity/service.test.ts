import { describe, expect, it, vi } from "vitest";
import type { PaginatedResult } from "../pagination";
import type { ActivityListOpts, ActivityRepo, ActivityRow } from "./repo";
import { ActivityService } from "./service";

class FakeRepo implements ActivityRepo {
  rows: ActivityRow[] = [];
  async insert(row: ActivityRow): Promise<void> {
    this.rows.push(row);
  }
  async list(_opts: ActivityListOpts): Promise<PaginatedResult<ActivityRow>> {
    return { items: this.rows, nextCursor: null };
  }
}

class ThrowingRepo implements ActivityRepo {
  async insert(): Promise<void> {
    throw new Error("db down");
  }
  async list(): Promise<PaginatedResult<ActivityRow>> {
    return { items: [], nextCursor: null };
  }
}

describe("ActivityService.record", () => {
  it("builds a row with an id, timestamp, and user actor when actorId is given", async () => {
    const repo = new FakeRepo();
    const svc = new ActivityService(repo);
    await svc.record({
      category: "knowledge",
      action: "page.created",
      actorId: "user-1",
      targetType: "page",
      targetId: "p1",
      summary: "Created page p1",
      metadata: { title: "Hi" },
    });
    expect(repo.rows).toHaveLength(1);
    const r = repo.rows[0];
    expect(r._id).toMatch(/[0-9a-f-]{36}/);
    expect(r.createdAt).toBeInstanceOf(Date);
    expect(r.actorType).toBe("user");
    expect(r.actorId).toBe("user-1");
    expect(r.status).toBe("ok");
    expect(r.metadata).toEqual({ title: "Hi" });
  });

  it("defaults to a system actor when actorId is absent", async () => {
    const repo = new FakeRepo();
    const svc = new ActivityService(repo);
    await svc.record({ category: "job", action: "job.run", summary: "soul-sync ran" });
    expect(repo.rows[0]?.actorType).toBe("system");
    expect(repo.rows[0]?.actorId).toBeNull();
  });

  it("maps an empty-string actorId to a system row (never to the uuid column)", async () => {
    const repo = new FakeRepo();
    const svc = new ActivityService(repo);
    await svc.record({
      category: "resource",
      action: "resource.created",
      actorId: "",
      summary: "x",
    });
    expect(repo.rows[0]?.actorType).toBe("system");
    expect(repo.rows[0]?.actorId).toBeNull();
  });

  it("never throws when the repo insert fails — audit is best-effort", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const svc = new ActivityService(new ThrowingRepo());
    await expect(
      svc.record({ category: "resource", action: "resource.created", summary: "x" })
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("passes list options through to the repo", async () => {
    const repo = new FakeRepo();
    repo.rows = [{ summary: "one" } as ActivityRow];
    const svc = new ActivityService(repo);
    const page = await svc.list({ limit: 5, category: "chat" });
    expect(page.items).toHaveLength(1);
  });
});
