import { randomUUID } from "node:crypto";
import { HookError, type HookExecutor } from "@tulipfarm/sandbox";
import type { SoulLoader, SoulResource } from "@tulipfarm/soul";
import type { PaginatedResult } from "@tulipfarm/storage";
import {
  authorizeToolIntent,
  type PublishedToolContract,
  toolContractSpecOf,
} from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import type {
  CounterStore,
  HistoryOp,
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
    this.log(doc._id, "create", doc);
  }

  private log(id: string, operation: HistoryOp, snapshot: ResourceDoc): void {
    this.history.push({ _id: randomUUID(), resourceId: id, operation, snapshot, at: new Date() });
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

  async replaceOne(
    id: string,
    expectedVersion: number,
    doc: ResourceDoc,
    op: HistoryOp
  ): Promise<boolean> {
    const ex = this.docs.get(id);
    if (!ex || ex.version !== expectedVersion) return false;
    this.docs.set(id, { ...doc });
    this.log(id, op, doc);
    return true;
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

function makeSoulLoader(
  types: Record<string, Record<string, unknown>>,
  domains: Readonly<Record<string, string>> = {}
): {
  resources: { get: (type: string) => SoulResource | undefined; has: (type: string) => boolean };
} {
  return {
    resources: {
      get: (type: string) => {
        const schema = types[type];
        if (!schema) return undefined;
        return {
          ...(domains[type] === undefined ? {} : { domain: domains[type] }),
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

function publishedContract(toolName: string): PublishedToolContract {
  const spec = toolContractSpecOf(getTool(toolName));
  return {
    ...spec,
    definitionId: `definition:${toolName}`,
    authoredVersion: 1,
    publishedDigest: "a".repeat(64),
    requiredActions: spec.requiredActions ?? [],
    requiredResources: spec.requiredResources ?? [],
    dataClasses: spec.dataClasses ?? [],
    allowedDestinations: spec.allowedDestinations ?? [],
  };
}

function expectNoMalformedTargets(toolName: string, args: unknown): void {
  const tool = getTool(toolName);
  expect(() => tool.targetsFor(args)).not.toThrow();
  for (const ref of tool.targetsFor(args)) {
    expect(ref.type).not.toMatch(/undefined|null/);
    expect(ref.id).not.toMatch(/undefined|null/);
  }
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

describe("RESOURCE_TOOLS targetsFor", () => {
  it("target derivations tolerate empty and unexpected raw arguments", () => {
    for (const tool of RESOURCE_TOOLS) {
      expectNoMalformedTargets(tool.name, {});
      expectNoMalformedTargets(tool.name, { unexpected: true });
      expectNoMalformedTargets(tool.name, null);
    }
  });

  it("record id tools derive only genuinely determined partial targets", () => {
    for (const name of ["record_get", "record_update", "record_delete"]) {
      const tool = getTool(name);
      expect(tool.targetsFor({ type: "ticket" })).toEqual([{ type: "record", id: "ticket" }]);
      expect(tool.targetsFor({ id: "rec-1" })).toEqual([]);
      expect(tool.targetsFor({ type: { name: "ticket" }, id: "rec-1" })).toEqual([]);
    }
  });

  it("derives different resource-type refs from each record tool's type argument", () => {
    const cases = [
      {
        name: "record_create",
        first: { type: "ticket", data: { title: "T" } },
        second: { type: "leave-request", data: { title: "T" } },
        expected: [{ type: "record", id: "ticket" }],
        expectedSecond: [{ type: "record", id: "leave-request" }],
      },
      {
        name: "record_list",
        first: { type: "ticket" },
        second: { type: "leave-request" },
        expected: [{ type: "record", id: "ticket" }],
        expectedSecond: [{ type: "record", id: "leave-request" }],
      },
      {
        name: "record_get",
        first: { type: "ticket", id: "rec-1" },
        second: { type: "leave-request", id: "rec-1" },
        expected: [
          { type: "record", id: "ticket" },
          { type: "record.ticket", id: "rec-1" },
        ],
        expectedSecond: [
          { type: "record", id: "leave-request" },
          { type: "record.leave-request", id: "rec-1" },
        ],
      },
      {
        name: "record_update",
        first: { type: "ticket", id: "rec-1", version: 1, data: { title: "T" } },
        second: { type: "leave-request", id: "rec-1", version: 1, data: { title: "T" } },
        expected: [
          { type: "record", id: "ticket" },
          { type: "record.ticket", id: "rec-1" },
        ],
        expectedSecond: [
          { type: "record", id: "leave-request" },
          { type: "record.leave-request", id: "rec-1" },
        ],
      },
      {
        name: "record_delete",
        first: { type: "ticket", id: "rec-1", version: 1 },
        second: { type: "leave-request", id: "rec-1", version: 1 },
        expected: [
          { type: "record", id: "ticket" },
          { type: "record.ticket", id: "rec-1" },
        ],
        expectedSecond: [
          { type: "record", id: "leave-request" },
          { type: "record.leave-request", id: "rec-1" },
        ],
      },
      {
        name: "record_search",
        first: { type: "ticket", filters: { status: "open" } },
        second: { type: "leave-request", filters: { status: "open" } },
        expected: [{ type: "record", id: "ticket" }],
        expectedSecond: [{ type: "record", id: "leave-request" }],
      },
    ];

    for (const entry of cases) {
      const tool = getTool(entry.name);
      expect(tool.targetsFor(entry.first), entry.name).toEqual(entry.expected);
      expect(tool.targetsFor(entry.second), entry.name).toEqual(entry.expectedSecond);
    }
  });

  it("derives record domains from the trusted resource type definition", () => {
    const soulLoader = makeSoulLoader(
      {
        engineering_ticket: { type: "object", properties: { title: { type: "string" } } },
        hr_review: { type: "object", properties: { title: { type: "string" } } },
        note: { type: "object", properties: { title: { type: "string" } } },
      },
      { engineering_ticket: "engineering", hr_review: "hr" }
    );
    const ctx = makeCtx(new FakeRepoFactory(), soulLoader);
    const tool = getTool("record_update");

    expect(
      tool.targetsFor(
        { type: "hr_review", id: "rec-1", version: 1, data: {}, domain: "engineering" },
        ctx
      )
    ).toEqual([
      { type: "record", id: "hr_review", domain: "hr" },
      { type: "record.hr_review", id: "rec-1", domain: "hr" },
    ]);
    expect(tool.targetsFor({ type: "note", id: "rec-1", version: 1, data: {} }, ctx)).toEqual([
      { type: "record", id: "note" },
      { type: "record.note", id: "rec-1" },
    ]);
  });

  it("denies HR record mutation to an engineering-only principal", () => {
    const soulLoader = makeSoulLoader(
      {
        engineering_ticket: { type: "object", properties: { title: { type: "string" } } },
        hr_review: { type: "object", properties: { title: { type: "string" } } },
      },
      { engineering_ticket: "engineering", hr_review: "hr" }
    );
    const ctx = makeCtx(new FakeRepoFactory(), soulLoader);
    const tool = getTool("record_update");
    const contract = { ...publishedContract("record_update"), dataClasses: ["internal"] };
    const policy = {
      authorityLayers: [
        {
          name: "principal",
          grants: [
            {
              action: "record.update",
              resourceType: "*",
              domain: "engineering",
              effect: "allow" as const,
            },
          ],
        },
      ],
      guardrailRules: [{ id: "allow", effect: "allow" as const, action: "*", resourceType: "*" }],
      dlpRules: [{ dataClass: "internal" }],
      guardrailRevision: "test",
    };

    const hrOutcome = authorizeToolIntent(
      {
        intentId: "intent-hr",
        businessId: "business-1",
        runId: "run-1",
        stateId: "state-1",
        toolId: "record_update",
        toolVersion: "1",
        action: "record.update",
        targetRefs: tool.targetsFor(
          { type: "hr_review", id: "rec-1", version: 1, data: { title: "No" } },
          ctx
        ),
        arguments: {},
        idempotencyKey: "hr",
      },
      contract,
      policy
    );
    const engineeringOutcome = authorizeToolIntent(
      {
        intentId: "intent-eng",
        businessId: "business-1",
        runId: "run-1",
        stateId: "state-1",
        toolId: "record_update",
        toolVersion: "1",
        action: "record.update",
        targetRefs: tool.targetsFor(
          { type: "engineering_ticket", id: "rec-1", version: 1, data: { title: "Yes" } },
          ctx
        ),
        arguments: {},
        idempotencyKey: "eng",
      },
      contract,
      policy
    );

    expect(hrOutcome).toMatchObject({ outcome: "denied", reason: "authorization_denied" });
    expect(engineeringOutcome).toMatchObject({ outcome: "authorized" });
  });

  it("keeps undomained record mutation authorized by today's domainless grant", () => {
    const ctx = makeCtx(
      new FakeRepoFactory(),
      makeSoulLoader({
        note: { type: "object", properties: { title: { type: "string" } } },
      })
    );
    const tool = getTool("record_update");
    const contract = { ...publishedContract("record_update"), dataClasses: ["internal"] };
    const outcome = authorizeToolIntent(
      {
        intentId: "intent-note",
        businessId: "business-1",
        runId: "run-1",
        stateId: "state-1",
        toolId: "record_update",
        toolVersion: "1",
        action: "record.update",
        targetRefs: tool.targetsFor(
          { type: "note", id: "rec-1", version: 1, data: { title: "Still allowed" } },
          ctx
        ),
        arguments: {},
        idempotencyKey: "note",
      },
      contract,
      {
        authorityLayers: [
          {
            name: "principal",
            grants: [{ action: "record.update", resourceType: "*", effect: "allow" }],
          },
        ],
        guardrailRules: [{ id: "allow", effect: "allow" as const, action: "*", resourceType: "*" }],
        dlpRules: [{ dataClass: "internal" }],
        guardrailRevision: "test",
      }
    );

    expect(outcome).toMatchObject({ outcome: "authorized" });
  });
});

describe("record_create", () => {
  it("creates a record and returns it with id + version:1", async () => {
    const factory = new FakeRepoFactory();
    const ctx = makeCtx(factory);
    const tool = getTool("record_create");
    const result = await tool.handler({ type: "ticket", data: { title: "Hello" } }, ctx);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const rec = result.data as Record<string, unknown>;
    expect(typeof rec.id).toBe("string");
    expect(rec.version).toBe(1);
    expect(rec.title).toBe("Hello");
  });

  it("returns not_found for unknown type", async () => {
    const tool = getTool("record_create");
    const result = await tool.handler({ type: "unknown", data: {} }, makeCtx());
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns validation_error for missing required field", async () => {
    const tool = getTool("record_create");
    const result = await tool.handler({ type: "ticket", data: {} }, makeCtx());
    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  // The Agent path has to refuse the same blank the HTTP route refuses, or a Record an operator
  // could not create by hand is one `record_create` call away (#434).
  it("returns validation_error and writes nothing when a required field is only whitespace", async () => {
    const factory = new FakeRepoFactory();
    const tool = getTool("record_create");
    const result = await tool.handler({ type: "ticket", data: { title: "   " } }, makeCtx(factory));
    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect((factory.forType("ticket") as FakeRepo).docs.size).toBe(0);
  });

  it("returns validation_error for bad args (no type)", async () => {
    const tool = getTool("record_create");
    const result = await tool.handler({ data: {} }, makeCtx());
    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

describe("record_list", () => {
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
    const tool = getTool("record_list");
    const result = await tool.handler({ type: "ticket" }, makeCtx(factory));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data as { items: unknown[]; nextCursor: null };
    expect(d.items).toHaveLength(1);
  });

  it("returns not_found for unknown type", async () => {
    const tool = getTool("record_list");
    const result = await tool.handler({ type: "unknown" }, makeCtx());
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});

describe("record_get", () => {
  it("returns a record by id", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 1, createdAt: now, updatedAt: now, title: "T1" });
    const tool = getTool("record_get");
    const result = await tool.handler({ type: "ticket", id }, makeCtx(factory));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).id).toBe(id);
  });

  it("returns not_found for missing id", async () => {
    const tool = getTool("record_get");
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
    const tool = getTool("record_get");
    const result = await tool.handler({ type: "ticket", id }, makeCtx(factory));
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});

describe("record_update", () => {
  it("merge-updates and returns new version", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 1, createdAt: now, updatedAt: now, title: "Old" });
    const tool = getTool("record_update");
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
    const tool = getTool("record_update");
    const result = await tool.handler(
      { type: "ticket", id, version: 1, data: { title: "X" } },
      makeCtx(factory)
    );
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});

describe("record_delete", () => {
  it("soft-deletes and returns id", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 1, createdAt: now, updatedAt: now, title: "T" });
    const tool = getTool("record_delete");
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
    const tool = getTool("record_delete");
    const result = await tool.handler({ type: "ticket", id, version: 1 }, makeCtx(factory));
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("runs before and after hooks on delete", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 1, createdAt: now, updatedAt: now, title: "T" });

    const runBeforeHook = vi.fn().mockImplementation(async (_src, _type, record) => record);
    const runAfterHook = vi.fn().mockResolvedValue(undefined);
    const hookExecutor = { runBeforeHook, runAfterHook } as unknown as HookExecutor;

    const hookRes: SoulResource = {
      name: "ticket",
      schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      hasHooks: true,
      hookSource: "({})",
      hookHash: "h",
      hooksEnabled: true,
    };
    const soulLoader = {
      resources: {
        get: (t: string) => (t === "ticket" ? hookRes : undefined),
        has: (t: string) => t === "ticket",
      },
    } as unknown as SoulLoader;

    const ctx = { ...makeCtx(factory), soulLoader, hookExecutor };
    const tool = getTool("record_delete");
    const result = await tool.handler({ type: "ticket", id, version: 1 }, ctx);
    expect(result).toMatchObject({ success: true, data: { id } });
    expect(runBeforeHook).toHaveBeenCalledOnce();
    expect(runAfterHook).toHaveBeenCalledOnce();
  });

  it("blocks delete when before hook throws HookError", async () => {
    const factory = new FakeRepoFactory();
    const repo = factory.forType("ticket") as FakeRepo;
    const id = randomUUID();
    const now = new Date();
    await repo.insert({ _id: id, version: 1, createdAt: now, updatedAt: now, title: "T" });

    const runBeforeHook = vi.fn().mockRejectedValue(new HookError("cannot delete"));
    const runAfterHook = vi.fn().mockResolvedValue(undefined);
    const hookExecutor = { runBeforeHook, runAfterHook } as unknown as HookExecutor;

    const hookRes: SoulResource = {
      name: "ticket",
      schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      hasHooks: true,
      hookSource: "({})",
      hookHash: "h",
      hooksEnabled: true,
    };
    const soulLoader = {
      resources: {
        get: (t: string) => (t === "ticket" ? hookRes : undefined),
        has: (t: string) => t === "ticket",
      },
    } as unknown as SoulLoader;

    const ctx = { ...makeCtx(factory), soulLoader, hookExecutor };
    const tool = getTool("record_delete");
    const result = await tool.handler({ type: "ticket", id, version: 1 }, ctx);
    expect(result).toMatchObject({
      success: false,
      error: { code: "validation_error", message: "cannot delete" },
    });
    expect(runAfterHook).not.toHaveBeenCalled();
    const stored = repo.docs.get(id);
    expect(stored?.deletedAt).toBeUndefined();
  });
});

describe("record_search", () => {
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
    const tool = getTool("record_search");
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
    const tool = getTool("record_search");
    const result = await tool.handler({ type: "ticket" }, makeCtx(factory));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { items: unknown[] }).items).toHaveLength(2);
  });
});
