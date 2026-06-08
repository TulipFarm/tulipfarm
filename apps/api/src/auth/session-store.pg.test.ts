import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgSessionStore } from "./session-store";

describe("PgSessionStore", () => {
  let db: PGlite;
  let store: PgSessionStore;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    store = new PgSessionStore(db, 3600);
  });

  afterEach(async () => {
    await db.close();
  });

  it("create then get returns the userId", async () => {
    const userId = randomUUID();
    const sid = await store.create(userId);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.get(sid)).toBe(userId);
  });

  it("get returns null for an expired session", async () => {
    await db.query(
      "INSERT INTO sessions (sid, user_id, expires_at) VALUES ('expired', gen_random_uuid(), now() - interval '1 second')"
    );
    expect(await store.get("expired")).toBeNull();
  });

  it("get returns null for an unknown sid", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("destroy removes the session", async () => {
    const sid = await store.create(randomUUID());
    await store.destroy(sid);
    expect(await store.get(sid)).toBeNull();
  });

  it("issues unique session ids", async () => {
    const uid = randomUUID();
    expect(await store.create(uid)).not.toBe(await store.create(uid));
  });
});
