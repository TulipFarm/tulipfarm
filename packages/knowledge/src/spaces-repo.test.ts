/**
 * A malformed Space id must never reach the database.
 *
 * `knowledge_spaces.id` is a `uuid` column, so a non-UUID id does not return zero rows — it raises
 * `invalid input syntax for type uuid`, which surfaces as a 500 instead of the 404 an unknown id
 * gets. The route gate already filters these, but these repos are exported from the package and the
 * worker's Tool host calls them without that gate, so the guard has to hold here too.
 *
 * The Queryable throws on any call, so the assertion is "the query was never issued" rather than
 * the weaker "the result was empty".
 */

import type { Queryable } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { isKnowledgeId } from "./ids";
import { PgKnowledgeSpaceRepo } from "./spaces-repo";

/** Any query at all is a failure: a guarded call must short-circuit before touching Postgres. */
function unreachableDb(): Queryable {
  return {
    query: async () => {
      throw new Error("reached the database with an id that cannot name a row");
    },
  } as unknown as Queryable;
}

const MALFORMED = ["not-a-uuid", "", "123", "null", "undefined", "1' OR '1'='1", "  "];

describe("isKnowledgeId", () => {
  it("accepts a canonical UUID in either case", () => {
    expect(isKnowledgeId("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    expect(isKnowledgeId("3F2504E0-4F89-11D3-9A0C-0305E82C3301")).toBe(true);
  });

  it("rejects anything that cannot name a row", () => {
    for (const bad of [...MALFORMED, undefined, null]) expect(isKnowledgeId(bad)).toBe(false);
  });

  it("rejects a UUID carrying extra characters", () => {
    expect(isKnowledgeId(" 3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(false);
    expect(isKnowledgeId("3f2504e0-4f89-11d3-9a0c-0305e82c3301'")).toBe(false);
  });
});

describe("PgKnowledgeSpaceRepo short-circuits a malformed id", () => {
  const repo = new PgKnowledgeSpaceRepo(unreachableDb());

  it("getById reads as absent", async () => {
    for (const bad of MALFORMED) await expect(repo.getById(bad)).resolves.toBeNull();
  });

  it("update reads as absent", async () => {
    for (const bad of MALFORMED) {
      await expect(repo.update(bad, { name: "renamed" }, new Date())).resolves.toBeNull();
    }
  });

  it("delete reports nothing deleted", async () => {
    for (const bad of MALFORMED) await expect(repo.delete(bad)).resolves.toBe(false);
  });

  it("still issues the query for a well-formed id", async () => {
    // The control: without it, a guard that rejected every id would pass the three tests above.
    await expect(repo.getById("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).rejects.toThrow(
      "reached the database"
    );
  });
});
