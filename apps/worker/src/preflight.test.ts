import { describe, expect, it } from "vitest";
import type { Queryable } from "./db";
import { assertSchemaFloor, PreflightError } from "./preflight";

function stubDatabase(result: Record<string, unknown>[] | Error): Queryable {
  return {
    async query() {
      if (result instanceof Error) throw result;
      return { rows: result };
    },
  };
}

describe("assertSchemaFloor", () => {
  it("returns the version when the database is at or above the floor", async () => {
    await expect(assertSchemaFloor(stubDatabase([{ version: 15 }]), 15)).resolves.toBe(15);
    await expect(assertSchemaFloor(stubDatabase([{ version: 21 }]), 15)).resolves.toBe(21);
  });

  it("accepts the string form pg returns for bigint columns", async () => {
    await expect(assertSchemaFloor(stubDatabase([{ version: "16" }]), 15)).resolves.toBe(16);
  });

  it("refuses to boot below the floor and names the remedy", async () => {
    await expect(assertSchemaFloor(stubDatabase([{ version: 14 }]), 15)).rejects.toThrow(
      "schema_version is 14, but this worker requires 15. Deploy the API first"
    );
  });

  it("refuses to boot when schema_version is unreadable", async () => {
    await expect(
      assertSchemaFloor(stubDatabase(new Error('relation "schema_version" does not exist')), 15)
    ).rejects.toThrow(PreflightError);
  });

  it("refuses to boot when the API has never migrated this database", async () => {
    await expect(assertSchemaFloor(stubDatabase([]), 15)).rejects.toThrow(
      "schema_version is empty"
    );
  });

  it("refuses to boot on a non-integer version rather than coercing it", async () => {
    await expect(assertSchemaFloor(stubDatabase([{ version: "v15" }]), 15)).rejects.toThrow(
      "non-integer value: v15"
    );
  });
});
