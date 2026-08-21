import type { ResourceSideEffect } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  createRecord,
  type ResourceDoc,
  type ResourceRepo,
  type ResourceWritePorts,
  updateRecord,
} from "./service";

class MemoryRepo implements ResourceRepo {
  readonly records = new Map<string, ResourceDoc>();
  readonly keys = new Map<string, string>();
  readonly effects: ResourceSideEffect[] = [];

  async insert(doc: ResourceDoc, effect?: ResourceSideEffect): Promise<void> {
    this.records.set(doc._id, doc);
    if (effect) this.effects.push(effect);
  }

  async createIdempotently(
    doc: ResourceDoc,
    key: string,
    effect: ResourceSideEffect
  ): Promise<{ readonly created: boolean; readonly doc: ResourceDoc }> {
    const existing = this.keys.get(key);
    if (existing) return { created: false, doc: this.records.get(existing) as ResourceDoc };
    this.keys.set(key, doc._id);
    await this.insert(doc, effect);
    return { created: true, doc };
  }

  async findById(id: string): Promise<ResourceDoc | null> {
    return this.records.get(id) ?? null;
  }

  async replaceOne(
    id: string,
    expected: number,
    doc: ResourceDoc,
    _op: "create" | "update" | "delete",
    effect?: ResourceSideEffect
  ): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing || existing.version !== expected) return false;
    this.records.set(id, doc);
    if (effect) this.effects.push(effect);
    return true;
  }
}

function ports(repos: Record<string, MemoryRepo>): ResourceWritePorts {
  return {
    catalog: { has: (type) => repos[type] !== undefined },
    repositories: { forType: (type) => repos[type] as MemoryRepo },
    counter: async () => 1,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    newRecordId: () => "00000000-0000-4000-8000-000000000001",
  };
}

describe("Record write service", () => {
  it("creates exactly one durable side effect for an idempotent replay", async () => {
    const tickets = new MemoryRepo();
    const writePorts = ports({ ticket: tickets });
    const input = {
      type: "ticket",
      resource: { schema: { type: "object", properties: { name: { type: "string" } } } },
      data: { name: "first" },
      idempotencyKey: "caller-key",
    };

    const first = await createRecord(input, writePorts);
    const replay = await createRecord(input, writePorts);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(tickets.records).toHaveLength(1);
    expect(tickets.effects).toHaveLength(1);
  });

  it("revalidates a before-hook output and leaves immutable fields unchanged", async () => {
    const tickets = new MemoryRepo();
    tickets.records.set("ticket-1", {
      _id: "ticket-1",
      version: 1,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      owner: "fixed",
      name: "old",
    });
    const result = await updateRecord(
      {
        type: "ticket",
        resource: {
          schema: {
            type: "object",
            required: ["owner", "name"],
            properties: {
              owner: { type: "string", "x-immutable": true },
              name: { type: "string" },
            },
          },
          hookSource: "ignored-by-memory-port",
        },
        id: "ticket-1",
        expectedVersion: 1,
        data: { owner: "changed", name: "new" },
        mode: "replace",
      },
      {
        ...ports({ ticket: tickets }),
        beforeHook: { run: async () => ({ owner: "fixed", name: "" }) },
      }
    );

    expect(result).toMatchObject({
      ok: false,
      err: { code: 422, body: { path: "/name", error: "name must not be empty" } },
    });
    expect(tickets.effects).toHaveLength(0);
  });

  it("refuses a link to a missing Record before any mutation is enqueued", async () => {
    const tickets = new MemoryRepo();
    const result = await createRecord(
      {
        type: "ticket",
        resource: {
          schema: {
            type: "object",
            properties: { customerId: { type: "string", "x-links": { target: "customer" } } },
          },
        },
        data: { customerId: "missing" },
      },
      ports({ ticket: tickets, customer: new MemoryRepo() })
    );

    expect(result).toMatchObject({
      ok: false,
      err: { code: 422, body: { path: "/customerId" } },
    });
    expect(tickets.effects).toHaveLength(0);
  });
});
