import type { ResourceSideEffect } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import {
  createRecord,
  deleteRecord,
  previewRecordDelete,
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

  async findDependents(
    field: string,
    targetId: string,
    limit: number
  ): Promise<readonly ResourceDoc[]> {
    return Array.from(this.records.values())
      .filter((record) => record.deletedAt === undefined && record[field] === targetId)
      .slice(0, limit);
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

function ports(
  repos: Record<string, MemoryRepo>,
  definitions: Record<string, { schema: Record<string, unknown> }> = Object.fromEntries(
    Object.keys(repos).map((type) => [type, { schema: { type: "object" } }])
  )
): ResourceWritePorts {
  return {
    catalog: {
      has: (type) => definitions[type] !== undefined,
      get: (type) => definitions[type],
      entries: () => Object.entries(definitions)[Symbol.iterator](),
    },
    repositories: {
      forType: (type) => repos[type] as MemoryRepo,
      withTransaction: async (_types, operation) =>
        operation({ forType: (type) => repos[type] as MemoryRepo }),
    },
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

  describe("Record delete dependency policies", () => {
    const customerDefinition = {
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    };

    function ticketDefinition(onDelete?: "restrict" | "cascade") {
      return {
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            customerId: {
              type: "string",
              "x-links": {
                target: "customer",
                ...(onDelete === undefined ? {} : { onDelete }),
              },
            },
          },
        },
      };
    }

    function record(id: string, fields: Record<string, unknown> = {}): ResourceDoc {
      return {
        _id: id,
        version: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...fields,
      };
    }

    it("preserves the existing dangling-link behavior when no delete policy is configured", async () => {
      const customers = new MemoryRepo();
      const tickets = new MemoryRepo();
      const customer = record("customer-1");
      const ticket = record("ticket-1", { customerId: customer._id });
      customers.records.set(customer._id, customer);
      tickets.records.set(ticket._id, ticket);
      const writePorts = ports(
        { customer: customers, ticket: tickets },
        { customer: customerDefinition, ticket: ticketDefinition() }
      );

      const result = await deleteRecord(
        {
          type: "customer",
          resource: customerDefinition,
          id: customer._id,
          expectedVersion: 1,
        },
        writePorts
      );

      expect(result.ok).toBe(true);
      expect(customers.records.get(customer._id)?.deletedAt).toBeInstanceOf(Date);
      expect(tickets.records.get(ticket._id)?.deletedAt).toBeUndefined();
    });

    it("restricts deletion before writes and identifies the exact dependent Record", async () => {
      const customers = new MemoryRepo();
      const tickets = new MemoryRepo();
      const customer = record("customer-1");
      const ticket = record("ticket-1", { customerId: customer._id });
      customers.records.set(customer._id, customer);
      tickets.records.set(ticket._id, ticket);
      const writePorts = ports(
        { customer: customers, ticket: tickets },
        { customer: customerDefinition, ticket: ticketDefinition("restrict") }
      );

      const preview = await previewRecordDelete(
        { type: "customer", id: customer._id, expectedVersion: 1 },
        writePorts
      );
      const result = await deleteRecord(
        {
          type: "customer",
          resource: customerDefinition,
          id: customer._id,
          expectedVersion: 1,
        },
        writePorts
      );

      expect(preview).toMatchObject({
        ok: true,
        plan: {
          records: [{ type: "customer", id: "customer-1", version: 1 }],
          restrictedBy: [{ type: "ticket", id: "ticket-1", version: 1 }],
        },
      });
      expect(result).toMatchObject({
        ok: false,
        err: { code: 409, body: { error: "record has restricted delete dependencies" } },
      });
      expect(customers.records.get(customer._id)?.deletedAt).toBeUndefined();
      expect(tickets.records.get(ticket._id)?.deletedAt).toBeUndefined();
    });

    it("requires and executes an exact cascade preview while retaining unrelated Records", async () => {
      const customers = new MemoryRepo();
      const tickets = new MemoryRepo();
      const customer = record("customer-1");
      const ticket = record("ticket-1", { customerId: customer._id });
      const sentinel = record("ticket-2", { customerId: "another-customer" });
      customers.records.set(customer._id, customer);
      tickets.records.set(ticket._id, ticket);
      tickets.records.set(sentinel._id, sentinel);
      const writePorts = ports(
        { customer: customers, ticket: tickets },
        { customer: customerDefinition, ticket: ticketDefinition("cascade") }
      );
      const preview = await previewRecordDelete(
        { type: "customer", id: customer._id, expectedVersion: 1 },
        writePorts
      );
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      const withoutPreview = await deleteRecord(
        {
          type: "customer",
          resource: customerDefinition,
          id: customer._id,
          expectedVersion: 1,
        },
        writePorts
      );
      expect(withoutPreview).toMatchObject({
        ok: false,
        err: { code: 409, body: { error: "delete dependency preview required" } },
      });

      const result = await deleteRecord(
        {
          type: "customer",
          resource: customerDefinition,
          id: customer._id,
          expectedVersion: 1,
          plan: preview.plan,
        },
        writePorts
      );

      expect(preview.plan.records).toEqual([
        { type: "customer", id: "customer-1", version: 1 },
        { type: "ticket", id: "ticket-1", version: 1 },
      ]);
      expect(result.ok).toBe(true);
      expect(customers.records.get(customer._id)?.deletedAt).toBeInstanceOf(Date);
      expect(tickets.records.get(ticket._id)?.deletedAt).toBeInstanceOf(Date);
      expect(tickets.records.get(sentinel._id)?.deletedAt).toBeUndefined();
    });

    it("rejects an injected preview without deleting any Record", async () => {
      const customers = new MemoryRepo();
      const tickets = new MemoryRepo();
      const customer = record("customer-1");
      const ticket = record("ticket-1", { customerId: customer._id });
      customers.records.set(customer._id, customer);
      tickets.records.set(ticket._id, ticket);
      const writePorts = ports(
        { customer: customers, ticket: tickets },
        { customer: customerDefinition, ticket: ticketDefinition("cascade") }
      );
      const preview = await previewRecordDelete(
        { type: "customer", id: customer._id, expectedVersion: 1 },
        writePorts
      );
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      const result = await deleteRecord(
        {
          type: "customer",
          resource: customerDefinition,
          id: customer._id,
          expectedVersion: 1,
          plan: {
            ...preview.plan,
            records: [...preview.plan.records, { type: "ticket", id: "ticket-2", version: 1 }],
          },
        },
        writePorts
      );

      expect(result).toMatchObject({
        ok: false,
        err: { code: 409, body: { error: "delete dependency preview is stale" } },
      });
      expect(customers.records.get(customer._id)?.deletedAt).toBeUndefined();
      expect(tickets.records.get(ticket._id)?.deletedAt).toBeUndefined();
    });

    it("rejects a stale preview when a concurrent dependent appears", async () => {
      const customers = new MemoryRepo();
      const tickets = new MemoryRepo();
      const customer = record("customer-1");
      const first = record("ticket-1", { customerId: customer._id });
      customers.records.set(customer._id, customer);
      tickets.records.set(first._id, first);
      const writePorts = ports(
        { customer: customers, ticket: tickets },
        { customer: customerDefinition, ticket: ticketDefinition("cascade") }
      );
      const preview = await previewRecordDelete(
        { type: "customer", id: customer._id, expectedVersion: 1 },
        writePorts
      );
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      tickets.records.set("ticket-2", record("ticket-2", { customerId: customer._id }));

      const result = await deleteRecord(
        {
          type: "customer",
          resource: customerDefinition,
          id: customer._id,
          expectedVersion: 1,
          plan: preview.plan,
        },
        writePorts
      );

      expect(result).toMatchObject({
        ok: false,
        err: { code: 409, body: { error: "delete dependency preview is stale" } },
      });
      expect(customers.records.get(customer._id)?.deletedAt).toBeUndefined();
      expect(tickets.records.get(first._id)?.deletedAt).toBeUndefined();
      expect(tickets.records.get("ticket-2")?.deletedAt).toBeUndefined();
    });

    it("deduplicates an explicitly cascading cycle", async () => {
      const customers = new MemoryRepo();
      const tickets = new MemoryRepo();
      const customer = record("customer-1", { primaryTicketId: "ticket-1" });
      const ticket = record("ticket-1", { customerId: customer._id });
      customers.records.set(customer._id, customer);
      tickets.records.set(ticket._id, ticket);
      const cycleCustomerDefinition = {
        schema: {
          type: "object",
          properties: {
            primaryTicketId: {
              type: "string",
              "x-links": { target: "ticket", onDelete: "cascade" },
            },
          },
        },
      };
      const writePorts = ports(
        { customer: customers, ticket: tickets },
        { customer: cycleCustomerDefinition, ticket: ticketDefinition("cascade") }
      );

      const preview = await previewRecordDelete(
        { type: "customer", id: customer._id, expectedVersion: 1 },
        writePorts
      );

      expect(preview).toMatchObject({
        ok: true,
        plan: {
          records: [
            { type: "customer", id: "customer-1", version: 1 },
            { type: "ticket", id: "ticket-1", version: 1 },
          ],
        },
      });
    });
  });

  it("rejects a malformed email without persisting the Record", async () => {
    const customers = new MemoryRepo();
    const result = await createRecord(
      {
        type: "customer",
        resource: {
          schema: {
            type: "object",
            properties: { email: { type: "string", format: "email" } },
            required: ["email"],
          },
        },
        data: { email: "not-an-email" },
      },
      ports({ customer: customers })
    );

    expect(result).toMatchObject({
      ok: false,
      err: { code: 422, body: { path: "/email", boundary: "resource" } },
    });
    expect(customers.records).toHaveLength(0);
    expect(customers.effects).toHaveLength(0);
  });

  it("accepts a valid email", async () => {
    const customers = new MemoryRepo();
    const result = await createRecord(
      {
        type: "customer",
        resource: {
          schema: {
            type: "object",
            properties: { email: { type: "string", format: "email" } },
            required: ["email"],
          },
        },
        data: { email: "muskan@example.com" },
      },
      ports({ customer: customers })
    );

    expect(result).toMatchObject({ ok: true, doc: { email: "muskan@example.com" } });
    expect(customers.records).toHaveLength(1);
  });

  it.each([
    [{ metadata: { address: { city: "London", postcode: 123 } } }, "/metadata/address/postcode"],
    [{ metadata: { address: { postcode: "00123" } } }, "/metadata/address/city"],
    [
      { metadata: { address: { city: "London", postcode: "00123", "legacy/code": true } } },
      "/metadata/address/legacy~1code",
    ],
    [
      { metadata: { contacts: [{ city: "London", postcode: 123 }] } },
      "/metadata/contacts/0/postcode",
    ],
  ])("returns the complete nested validation path without persisting", async (data, path) => {
    const customers = new MemoryRepo();
    const address = {
      type: "object",
      properties: {
        city: { type: "string" },
        postcode: { type: "string" },
      },
      required: ["city", "postcode"],
      additionalProperties: false,
    };
    const result = await createRecord(
      {
        type: "customer",
        resource: {
          schema: {
            type: "object",
            properties: {
              metadata: {
                type: "object",
                properties: {
                  address,
                  contacts: { type: "array", items: address },
                },
                additionalProperties: false,
              },
            },
            required: ["metadata"],
          },
        },
        data,
      },
      ports({ customer: customers })
    );

    expect(result).toMatchObject({
      ok: false,
      err: { code: 422, body: { path, boundary: "resource" } },
    });
    expect(customers.records).toHaveLength(0);
    expect(customers.effects).toHaveLength(0);
  });

  it("rejects an impossible calendar date and accepts a valid leap day", async () => {
    const customers = new MemoryRepo();
    const resource = {
      schema: {
        type: "object",
        properties: { joinedOn: { type: "string", format: "date" } },
        required: ["joinedOn"],
      },
    };
    const writePorts = ports({ customer: customers });

    const invalid = await createRecord(
      { type: "customer", resource, data: { joinedOn: "2026-02-30" } },
      writePorts
    );
    expect(invalid).toMatchObject({
      ok: false,
      err: { code: 422, body: { path: "/joinedOn", boundary: "resource" } },
    });
    expect(customers.records).toHaveLength(0);

    const valid = await createRecord(
      { type: "customer", resource, data: { joinedOn: "2024-02-29" } },
      writePorts
    );
    expect(valid).toMatchObject({ ok: true, doc: { joinedOn: "2024-02-29", version: 1 } });
  });

  it("rejects an impossible calendar date update without changing the Record", async () => {
    const customers = new MemoryRepo();
    customers.records.set("customer-1", {
      _id: "customer-1",
      version: 1,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      joinedOn: "2024-02-29",
    });

    const result = await updateRecord(
      {
        type: "customer",
        resource: {
          schema: {
            type: "object",
            properties: { joinedOn: { type: "string", format: "date" } },
            required: ["joinedOn"],
          },
        },
        id: "customer-1",
        expectedVersion: 1,
        data: { joinedOn: "2026-02-30" },
        mode: "patch",
      },
      ports({ customer: customers })
    );

    expect(result).toMatchObject({
      ok: false,
      err: { code: 422, body: { path: "/joinedOn", boundary: "resource" } },
    });
    expect(customers.records.get("customer-1")).toMatchObject({
      joinedOn: "2024-02-29",
      version: 1,
    });
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

  it("keeps the generated default human ID stable on replace updates", async () => {
    const tickets = new MemoryRepo();
    tickets.records.set("ticket-1", {
      _id: "ticket-1",
      version: 1,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      id: "TICK-7",
      title: "old",
    });
    const counter = vi.fn(async () => 8);

    const result = await updateRecord(
      {
        type: "ticket",
        resource: {
          schema: {
            type: "object",
            "x-id-strategy": { prefix: "TICK-", sequence: true },
            properties: {
              id: { type: "string" },
              title: { type: "string", "x-normalize": ["trim"] },
            },
          },
        },
        id: "ticket-1",
        expectedVersion: 1,
        data: { id: "TICK-999", title: "  new  " },
        mode: "replace",
      },
      { ...ports({ ticket: tickets }), counter }
    );

    expect(result).toMatchObject({ ok: true, doc: { id: "TICK-7", title: "new" } });
    expect(counter).not.toHaveBeenCalled();
  });

  it("keeps a generated custom-field human ID stable on patch updates", async () => {
    const tickets = new MemoryRepo();
    tickets.records.set("ticket-1", {
      _id: "ticket-1",
      version: 1,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      ref: "REF-12",
      title: "old",
    });
    const counter = vi.fn(async () => 13);

    const result = await updateRecord(
      {
        type: "ticket",
        resource: {
          schema: {
            type: "object",
            "x-id-strategy": { field: "ref", prefix: "REF-", sequence: true },
            properties: { ref: { type: "string" }, title: { type: "string" } },
          },
        },
        id: "ticket-1",
        expectedVersion: 1,
        data: { ref: "REF-999", title: "new" },
        mode: "patch",
      },
      { ...ports({ ticket: tickets }), counter }
    );

    expect(result).toMatchObject({ ok: true, doc: { ref: "REF-12", title: "new" } });
    expect(counter).not.toHaveBeenCalled();
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
