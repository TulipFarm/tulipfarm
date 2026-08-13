import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { PgPrincipalRepo, type PrincipalRecord } from "./principal-repo";
import { AUTHORIZATION_STORAGE_STATEMENTS } from "./role-repo";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

function record(overrides: Partial<PrincipalRecord> = {}): PrincipalRecord {
  return {
    id: "principal-1",
    businessId: "business-1",
    kind: "user",
    status: "active",
    ...overrides,
  };
}

describe("PgPrincipalRepo", () => {
  let database: PGlite;
  let repo: PgPrincipalRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of AUTHORIZATION_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    repo = new PgPrincipalRepo(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("TRUNCATE TABLE principals CASCADE");
  });

  it("round-trips every principal column", async () => {
    const expiresAt = new Date("2026-08-12T12:00:00Z");
    await repo.put(record({ kind: "service", status: "expired", expiresAt }));

    await expect(repo.get("business-1", "principal-1")).resolves.toEqual(
      record({ kind: "service", status: "expired", expiresAt })
    );
  });

  it("updates an existing principal without duplicating it", async () => {
    await repo.put(record({ status: "active" }));
    await repo.put(record({ status: "disabled" }));

    await expect(repo.get("business-1", "principal-1")).resolves.toMatchObject({
      status: "disabled",
    });
  });

  it("isolates the same principal id by business", async () => {
    await repo.put(record({ businessId: "business-1", status: "active" }));
    await repo.put(record({ businessId: "business-2", status: "disabled" }));

    await expect(repo.get("business-1", "principal-1")).resolves.toMatchObject({
      status: "active",
    });
    await expect(repo.get("business-2", "principal-1")).resolves.toMatchObject({
      status: "disabled",
    });
  });
});
