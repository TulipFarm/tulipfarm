import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_ORIGIN_STORAGE_STATEMENTS, PublicOriginStore } from "./public-origin-store";

describe("PublicOriginStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: PublicOriginStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of PUBLIC_ORIGIN_STORAGE_STATEMENTS) await database.exec(sql);
    store = new PublicOriginStore(database);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM deployment_public_origins");
  });

  it("stores one deployment address per business", async () => {
    await store.put("business-1", {
      webOrigin: "https://tulip.example.com",
      apiOrigin: null,
    });
    await store.put("business-2", {
      webOrigin: "https://other.example.com",
      apiOrigin: "https://api.other.example.com",
    });

    expect(await store.get("business-1")).toEqual({
      webOrigin: "https://tulip.example.com",
      apiOrigin: null,
    });
    expect(await store.get("business-2")).toEqual({
      webOrigin: "https://other.example.com",
      apiOrigin: "https://api.other.example.com",
    });
  });

  it("replaces and clears the saved address", async () => {
    await store.put("business-1", {
      webOrigin: "http://localhost:8080",
      apiOrigin: null,
    });
    await store.put("business-1", {
      webOrigin: "https://tulip.example.com",
      apiOrigin: "https://api.tulip.example.com",
    });
    expect(await store.get("business-1")).toEqual({
      webOrigin: "https://tulip.example.com",
      apiOrigin: "https://api.tulip.example.com",
    });

    await store.delete("business-1");
    expect(await store.get("business-1")).toBeNull();
  });
});
