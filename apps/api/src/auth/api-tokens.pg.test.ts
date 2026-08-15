import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { decodeCursor } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgTokenRepo, type TokenDoc } from "./api-tokens";

const USER_ID = "11111111-1111-1111-1111-111111111111";

async function seedUser(db: PGlite, id = USER_ID): Promise<void> {
  await db.query(
    "INSERT INTO users (id, email, password_hash, role, created_at) VALUES ($1, $2, 'h', 'member', now())",
    [id, `${id}@example.com`]
  );
}

function makeToken(overrides: Partial<TokenDoc> = {}): TokenDoc {
  return {
    _id: randomUUID(),
    userId: USER_ID,
    name: "token",
    tokenHash: randomUUID(),
    prefix: "tulip_xxxx",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("PgTokenRepo", () => {
  let db: PGlite;
  let repo: PgTokenRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    await seedUser(db);
    repo = new PgTokenRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("creates and finds by hash / id", async () => {
    const token = makeToken({ tokenHash: "deadbeef" });
    await repo.create(token);
    expect((await repo.findByHash("deadbeef"))?._id).toBe(token._id);
    expect((await repo.findById(token._id))?.tokenHash).toBe("deadbeef");
  });

  it("lists by user and deletes by id", async () => {
    const a = makeToken();
    const b = makeToken();
    await repo.create(a);
    await repo.create(b);
    expect(await repo.findByUserId(USER_ID)).toHaveLength(2);
    await repo.deleteById(a._id);
    expect(await repo.findByUserId(USER_ID)).toHaveLength(1);
    expect(await repo.findAll()).toHaveLength(1);
  });

  it("enforces the user_id foreign key", async () => {
    await expect(repo.create(makeToken({ userId: randomUUID() }))).rejects.toThrow();
  });

  it("paginates with a stable keyset cursor", async () => {
    const base = Date.now();
    const tokens = [0, 1, 2].map((i) =>
      makeToken({ createdAt: new Date(base + i * 1000), name: `t${i}` })
    );
    for (const t of tokens) {
      await repo.create(t);
    }

    const page1 = await repo.findAllPaginated(2);
    expect(page1.items.map((t) => t.name)).toEqual(["t0", "t1"]);
    expect(page1.nextCursor).not.toBeNull();

    const after = decodeCursor(page1.nextCursor as string);
    expect(after).not.toBeNull();
    const page2 = await repo.findAllPaginated(2, after ?? undefined);
    expect(page2.items.map((t) => t.name)).toEqual(["t2"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("paginates scoped to a single user", async () => {
    const otherId = "22222222-2222-2222-2222-222222222222";
    await seedUser(db, otherId);
    await repo.create(makeToken({ name: "mine" }));
    await repo.create(makeToken({ userId: otherId, name: "theirs" }));

    const page = await repo.findByUserIdPaginated(USER_ID, 10);
    expect(page.items.map((t) => t.name)).toEqual(["mine"]);
  });
});
