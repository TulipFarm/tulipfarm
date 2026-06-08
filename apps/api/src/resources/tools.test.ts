import { randomUUID } from "node:crypto";
import type { SoulLoader, SoulResource } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import type { PaginatedResult } from "../pagination.js";
import type {
  CounterStore,
  ListOpts,
  ResourceDoc,
  ResourceHistoryDoc,
  ResourceRepo,
  ResourceRepoFactory,
  SearchOpts,
} from "./repo.js";
import { RESOURCE_TOOLS } from "./tools.js";

class FakeRepo implements ResourceRepo {
  docs = new Map<string, ResourceDoc>();
  history: ResourceHistoryDoc[] = [];

  async insert(doc: ResourceDoc): Promise<void> {
    this.docs.set(doc._id, { ...doc });
  }

  async findById(id: string): Promise<ResourceDoc | null> {
    return this.docs.get(id) ?? null;
  }

  async list(opts: ListOpts): Promise<PaginatedResult<ResourceDoc>> {
    let items = [...this.docs.values()];
    if (!opts.includeDeleted) items = items.filter((d) => d.deletedAt == null);
    return { items: items.slice(0, opts.limit), nextCursor: null };
  }

  async search(opts: SearchOpts): Promise<PaginatedResult<ResourceDoc>> {
    let items = [...this.docs.values()];
    if (!opts.includeDeleted) items = items.filter((d) => d.deletedAt == null);
    if (opts.filter) {
      const filter = opts.filter;
      items = items.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
    }
    return { items: items.slice(0, opts.limit), nextCursor: null };
  }

  async replaceOne(id: string, expectedVersion: number, doc: ResourceDoc): Promise<boolean> {
    const ex = this.docs.get(id);
    if (!ex || ex.version !== expectedVersion) return false;
    this.docs.set(id, { ...doc });
    return true;
  }

  async appendHistory(entry: ResourceHistoryDoc): Promise<void> {
    this.history.push(entry);
  }
}

class FakeRepoFactory implements ResourceRepoFactory {
  repos = new Map<string, FakeRepo>();
  forType(type: string): ResourceRepo {
    if (!this.repos.has(type)) this.repos.set(type, new FakeRepo());
    const repo = this.repos.get(type);
    if (!repo) throw new Error(`repo not found: ${type}`);
    return repo;
  }
}

const stubCounterStore: CounterStore = { makeCounterFn: () => async () => 1 };

function makeSoulLoader(types: Record<string, Record<string, unknown>>): {
  resources: { get: (type: string) => SoulResource | undefined; has: (type: string) => boolean };
} {
  return {
    resources: {
      get: (type: string) => {
        const schema = types[type];
        if (!schema) return undefined;
        return {
          schema,
          hooksEnabled: false,
          hookSource: undefined,
          hookHash: undefined,
        } as unknown as SoulResource;
      },
      has: (type: string) => type in types,
    },
  };
}

function getTool(name: string) {
  const t = RESOURCE_TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

function makeCtx(factory?: FakeRepoFactory, soulLoader?: ReturnType<typeof makeSoulLoader>) {
  return {
    userId: "u1",
    agentId: undefined,
    repoFactory: factory ?? new FakeRepoFactory(),
    counterStore: stubCounterStore,
    // The resource tools only read `soulLoader.resources`; cast the stub to the full type so the
    // fixture satisfies ResourceToolContext (pre-existing typecheck gap, fixed alongside this work).
    soulLoader: (soulLoader ??
      makeSoulLoader({
        ticket: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: true,
        },
      })) as unknown as SoulLoader,
    hookExecutor: undefined,
    events: undefined,
  };
}

describe("resource_create", () => {
  it("creates a record and returns it with id + version:1", async () => {
    const factory = new FakeRepoFactory();
    const ctx = makeCtx(factory);
    const tool = getTool("resource_create");
    const result = await tool.handler({ type: "ticket", data: { title: "Hello" } }, ctx);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const rec = result.data as Record<string, unknown>;
    expect(typeof rec.id).toBe("string");
    expect(rec.version).toBe(1);
    expect(rec.title).toBe("Hello");
  });

  it("returns not_found for unknown type", async () => {
    const tool = getTool("resource_create");
    const result = await tool.handler({ type: "unknown", data: {} }, makeCtx());
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns validation_error for missing required field", async () => {
    const tool = getTool("resource_create");
    const result = await tool.handler({ type: "ticket", data: {} }, makeCtx());
    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("returns validation_error for bad args (no type)", async () => {
    const tool = getTool("resource_create");
    const result = await tool.handler({ data: {} }, makeCtx());
    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

describe("resource_list", () => {
  it("lists records for a type", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const now = new Date();
    await repo.insert({
      _id: randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      title: "T1",
    });
    const tool = getTool("resource_list");
    const result = await tool.handler({ type: "ticket" }, makeCtx(factory));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data as { items: unknown[]; nextCursor: null };
    expect(d.items).toHaveLength(1);
  });

  it("returns not_found for unknown type", async () => {
    const tool = getTool("resource_list");
    const result = await tool.handler({ type: "unknown" }, makeCtx());
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});

describe("resource_get", () => {
  it("returns a record by id", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 1, createdAt: now, updatedAt: now, title: "T1" });
    const tool = getTool("resource_get");
    const result = await tool.handler({ type: "ticket", id }, makeCtx(factory));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).id).toBe(id);
  });

  it("returns not_found for missing id", async () => {
    const tool = getTool("resource_get");
    const result = await tool.handler({ type: "ticket", id: randomUUID() }, makeCtx());
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns not_found for soft-deleted record", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({
      _id: id,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
      title: "T1",
    });
    const tool = getTool("resource_get");
    const result = await tool.handler({ type: "ticket", id }, makeCtx(factory));
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});

describe("resource_update", () => {
  it("merge-updates and returns new version", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 1, createdAt: now, updatedAt: now, title: "Old" });
    const tool = getTool("resource_update");
    const result = await tool.handler(
      { type: "ticket", id, version: 1, data: { title: "New" } },
      makeCtx(factory)
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const rec = result.data as Record<string, unknown>;
    expect(rec.version).toBe(2);
    expect(rec.title).toBe("New");
  });

  it("returns not_found on version conflict", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 2, createdAt: now, updatedAt: now, title: "T" });
    const tool = getTool("resource_update");
    const result = await tool.handler(
      { type: "ticket", id, version: 1, data: { title: "X" } },
      makeCtx(factory)
    );
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});

describe("resource_delete", () => {
  it("soft-deletes and returns id", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 1, createdAt: now, updatedAt: now, title: "T" });
    const tool = getTool("resource_delete");
    const result = await tool.handler({ type: "ticket", id, version: 1 }, makeCtx(factory));
    expect(result).toMatchObject({ success: true, data: { id } });
    const stored = repo.docs.get(id);
    expect(stored?.deletedAt).toBeDefined();
  });

  it("returns not_found on version conflict", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 2, createdAt: now, updatedAt: now, title: "T" });
    const tool = getTool("resource_delete");
    const result = await tool.handler({ type: "ticket", id, version: 1 }, makeCtx(factory));
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});

describe("resource_search", () => {
  it("returns only matching records", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const now = new Date();
    await repo.insert({
      _id: randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      title: "open-ticket",
      status: "open",
    });
    await repo.insert({
      _id: randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      title: "closed-ticket",
      status: "closed",
    });
    const tool = getTool("resource_search");
    const result = await tool.handler(
      { type: "ticket", filters: { status: "open" } },
      makeCtx(factory)
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data as { items: unknown[] };
    expect(d.items).toHaveLength(1);
  });

  it("returns all records when no filters", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const now = new Date();
    await repo.insert({
      _id: randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      title: "A",
    });
    await repo.insert({
      _id: randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      title: "B",
    });
    const tool = getTool("resource_search");
    const result = await tool.handler({ type: "ticket" }, makeCtx(factory));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { items: unknown[] }).items).toHaveLength(2);
  });
});
