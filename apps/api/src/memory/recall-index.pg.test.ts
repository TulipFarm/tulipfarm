import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgMemoryRecallIndex } from "./recall-index";

const BIZ = "biz-1";
const USER = "44444444-4444-4444-4444-444444444444";

describe("PgMemoryRecallIndex", () => {
  let db: PGlite;
  let index: PgMemoryRecallIndex;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    index = new PgMemoryRecallIndex(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function insert(
    subject: string,
    statement: string,
    overrides: {
      entities?: string[];
      status?: string;
      confirmation?: string;
      businessId?: string;
    } = {}
  ): Promise<string> {
    const assertionId = randomUUID();
    await db.query(
      `INSERT INTO memory_assertions (
         business_id, assertion_id, scope, subject_principal_id, subject, statement,
         memory_type, trust_tier, confidence, importance, origin, author_principal_id,
         confirmation, status, version, created_at, updated_at, valid_from, entities, access_count
       ) VALUES ($1,$2,'user_private',$3,$4,$5,'fact','user_stated',1,0.5,'explicit',$3,
                 $6,$7,1,now(),now(),now(),$8,0)`,
      [
        overrides.businessId ?? BIZ,
        assertionId,
        USER,
        subject,
        statement,
        overrides.confirmation ?? "confirmed",
        overrides.status ?? "active",
        overrides.entities ?? [],
      ]
    );
    return assertionId;
  }

  it("finds an assertion by a word in its statement", async () => {
    const id = await insert("diet", "allergic to shellfish");
    await insert("colour", "prefers blue");
    const signals = await index.search({ businessId: BIZ, query: "shellfish", limit: 10 });
    expect(signals.map((s) => s.assertionId)).toEqual([id]);
    expect(signals[0].lexicalRank).toBe(0);
  });

  it("finds an assertion by a word in its subject", async () => {
    const id = await insert("timezone", "UTC+5:30");
    const signals = await index.search({ businessId: BIZ, query: "timezone", limit: 10 });
    expect(signals.map((s) => s.assertionId)).toEqual([id]);
  });

  it("matches on entities the statement text never repeats", async () => {
    // The whole reason the entity arm exists: the query names something the prose does not.
    const id = await insert("ownership", "runs the billing rewrite", { entities: ["Priya"] });
    const signals = await index.search({
      businessId: BIZ,
      query: "what does Priya own",
      limit: 10,
    });
    expect(signals.map((s) => s.assertionId)).toEqual([id]);
    expect(signals[0].entityRank).toBe(0);
    expect(signals[0].lexicalRank).toBeUndefined();
  });

  it("reports both arms for an assertion each of them matched", async () => {
    const id = await insert("ownership", "Priya runs billing", { entities: ["Priya"] });
    const signals = await index.search({ businessId: BIZ, query: "Priya", limit: 10 });
    expect(signals).toHaveLength(1);
    expect(signals[0].assertionId).toBe(id);
    expect(signals[0].lexicalRank).toBe(0);
    expect(signals[0].entityRank).toBe(0);
  });

  it("excludes superseded, forgotten, and unconfirmed assertions", async () => {
    await insert("a", "shellfish", { status: "superseded" });
    await insert("b", "shellfish", { status: "forgotten" });
    await insert("c", "shellfish", { confirmation: "pending" });
    const live = await insert("d", "shellfish");
    const signals = await index.search({ businessId: BIZ, query: "shellfish", limit: 10 });
    expect(signals.map((s) => s.assertionId)).toEqual([live]);
  });

  it("never crosses a business boundary", async () => {
    await insert("a", "shellfish", { businessId: "other-biz" });
    const signals = await index.search({ businessId: BIZ, query: "shellfish", limit: 10 });
    expect(signals).toEqual([]);
  });

  it("returns nothing rather than everything for a query that matches no assertion", async () => {
    await insert("colour", "prefers blue");
    const signals = await index.search({ businessId: BIZ, query: "kayaking", limit: 10 });
    expect(signals).toEqual([]);
  });

  it("tolerates a query with no searchable terms", async () => {
    await insert("colour", "prefers blue");
    const signals = await index.search({ businessId: BIZ, query: "!!! ???", limit: 10 });
    expect(signals).toEqual([]);
  });

  it("honours the candidate limit per arm", async () => {
    for (let i = 0; i < 5; i++) await insert(`k${i}`, "shellfish allergy");
    const signals = await index.search({ businessId: BIZ, query: "shellfish", limit: 2 });
    expect(signals).toHaveLength(2);
  });

  it("keeps the generated tsv in step with an edited statement", async () => {
    const id = await insert("diet", "allergic to shellfish");
    await db.query(
      "UPDATE memory_assertions SET statement = 'allergic to peanuts' WHERE assertion_id = $1",
      [id]
    );
    expect(await index.search({ businessId: BIZ, query: "shellfish", limit: 10 })).toEqual([]);
    const after = await index.search({ businessId: BIZ, query: "peanuts", limit: 10 });
    expect(after.map((s) => s.assertionId)).toEqual([id]);
  });

  it("runs the vector arm when an embedder is available", async () => {
    const id = await insert("diet", "allergic to shellfish");
    await db.query(
      "UPDATE memory_assertions SET embedding = $1::vector, embedding_dim = 3, embedding_model = 'test' WHERE assertion_id = $2",
      [JSON.stringify([1, 0, 0]), id]
    );
    const withVector = new PgMemoryRecallIndex(db, {
      isAvailable: () => true,
      async embedMany(values) {
        return { embeddings: values.map(() => [1, 0, 0]), dimension: 3 };
      },
      getActive: () => ({ provider: "test", model: "test", dimension: 3 }),
    });
    // The query text matches nothing lexically, so a hit can only come from the vector arm.
    const signals = await withVector.search({ businessId: BIZ, query: "kayaking", limit: 10 });
    expect(signals.map((s) => s.assertionId)).toEqual([id]);
    expect(signals[0].vectorRank).toBe(0);
  });

  it("falls back to the other arms when no embedder is configured", async () => {
    const id = await insert("diet", "allergic to shellfish");
    const signals = await index.search({ businessId: BIZ, query: "shellfish", limit: 10 });
    expect(signals.map((s) => s.assertionId)).toEqual([id]);
    expect(signals[0].vectorRank).toBeUndefined();
  });
});
