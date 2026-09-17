import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../db";
import { makeMigratedPglite } from "../test/pglite";
import { createResourceTableSql } from "./schema";
import { ResourceSchemaCompatibilityService } from "./schema-compatibility";

const TYPE = "invoice";
const DECIMAL_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

async function insertRecord(
  db: PGlite,
  id: string,
  version: number,
  data: Record<string, unknown>
): Promise<void> {
  await db.query(
    `INSERT INTO resources."${TYPE}" (id, version, created_at, updated_at, data)
     VALUES ($1, $2, now(), now(), $3::jsonb)`,
    [id, version, JSON.stringify(data)]
  );
}

async function storedRecord(db: PGlite, id: string) {
  const { rows } = await db.query<{ id: string; version: number; data: Record<string, unknown> }>(
    `SELECT id, version, data FROM resources."${TYPE}" WHERE id = $1`,
    [id]
  );
  return rows[0];
}

async function storedRecords(db: PGlite) {
  const { rows } = await db.query<{
    id: string;
    version: number;
    data: Record<string, unknown>;
  }>(`SELECT id, version, data FROM resources."${TYPE}" ORDER BY id`);
  return rows;
}

describe("ResourceSchemaCompatibilityService", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    await db.query(createResourceTableSql(TYPE));
  });

  afterEach(async () => {
    await db.close();
  });

  it("rejects an incompatible Record beyond the first page without publishing or mutating it", async () => {
    for (let index = 0; index < 26; index += 1) {
      await insertRecord(db, randomUUID(), 1, { title: `Control ${index}`, amount: index });
    }
    await insertRecord(db, DECIMAL_ID, 7, { title: "Decimal", amount: 19.99 });
    const originalSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        amount: { type: "number" },
      },
      required: ["title", "amount"],
    };
    const proposedSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        amount: { type: "integer" },
      },
      required: ["title", "amount"],
    };
    const before = await storedRecords(db);
    let publishedSchema = originalSchema;
    const publish = vi.fn(async () => {
      publishedSchema = proposedSchema;
      return "published";
    });
    const service = new ResourceSchemaCompatibilityService(db, 20);

    const result = await service.publishIfCompatible(TYPE, proposedSchema, publish);

    expect(result).toEqual({
      ok: false,
      affectedRecordIds: [DECIMAL_ID],
      affectedRecordCount: 1,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(publishedSchema).toBe(originalSchema);
    expect(await storedRecords(db)).toEqual(before);
  });

  it("publishes additive and required-field changes after Records are backfilled", async () => {
    await insertRecord(db, DECIMAL_ID, 3, {
      title: "Backfilled",
      amount: 19.99,
      currency: "USD",
    });
    const publish = vi.fn(async () => "published");
    const service = new ResourceSchemaCompatibilityService(db, 20);

    const result = await service.publishIfCompatible(
      TYPE,
      {
        type: "object",
        properties: {
          title: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
        },
        required: ["title", "amount", "currency"],
      },
      publish
    );

    expect(result).toEqual({ ok: true, value: "published" });
    expect(publish).toHaveBeenCalledOnce();
    expect(await storedRecord(db, DECIMAL_ID)).toMatchObject({
      id: DECIMAL_ID,
      version: 3,
      data: { title: "Backfilled", amount: 19.99, currency: "USD" },
    });
  });

  it("validates Record data without mistaking generated IDs for schema fields", async () => {
    const customerId = "11111111-1111-4111-8111-111111111111";
    await insertRecord(db, DECIMAL_ID, 4, {
      title: "Related invoice",
      customerId,
      amount: 19.99,
    });
    const before = await storedRecord(db, DECIMAL_ID);
    const publish = vi.fn(async () => "published");
    const service = new ResourceSchemaCompatibilityService(db);

    const result = await service.publishIfCompatible(
      TYPE,
      {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          customerId: { type: "string", format: "uuid" },
          amount: { type: "number" },
        },
        required: ["title", "customerId", "amount"],
      },
      publish
    );

    expect(result).toEqual({ ok: true, value: "published" });
    expect(publish).toHaveBeenCalledOnce();
    expect(await storedRecord(db, DECIMAL_ID)).toEqual(before);
  });

  it("holds a conflicting table lock until the compatible schema is published", async () => {
    const events: string[] = [];
    const transaction = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("LOCK TABLE")) events.push("lock");
        if (sql.startsWith("SELECT id, data")) events.push("scan");
        return { rows: [] };
      }),
    };
    const database = {
      transaction: async <T>(callback: (tx: Queryable) => Promise<T>) => {
        events.push("begin");
        const result = await callback(transaction as unknown as Queryable);
        events.push("commit");
        return result;
      },
    } as unknown as Queryable;
    const service = new ResourceSchemaCompatibilityService(database);

    const result = await service.publishIfCompatible(TYPE, { type: "object" }, async () => {
      events.push("publish");
      return "published";
    });

    expect(result).toEqual({ ok: true, value: "published" });
    expect(transaction.query).toHaveBeenNthCalledWith(
      1,
      'LOCK TABLE resources."invoice" IN SHARE MODE'
    );
    expect(events).toEqual(["begin", "lock", "scan", "publish", "commit"]);
  });
});
