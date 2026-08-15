import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { AdminAlreadyExistsError, PgUserRepo, type UserDoc } from "./users";

function makeUser(overrides: Partial<UserDoc> = {}): UserDoc {
  return {
    _id: randomUUID(),
    email: `u-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash: "hash",
    name: null,
    role: "member",
    status: "active" as const,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("PgUserRepo", () => {
  let db: PGlite;
  let repo: PgUserRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    repo = new PgUserRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("inserts and finds by id", async () => {
    const user = makeUser();
    await repo.insert(user);
    const found = await repo.findById(user._id);
    expect(found?.email).toBe(user.email);
    expect(found?.role).toBe("member");
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it("finds by email case-insensitively (citext + normalizeEmail)", async () => {
    const user = makeUser({ email: "mixed@example.com" });
    await repo.insert(user);
    expect((await repo.findByEmail("MIXED@example.com"))?._id).toBe(user._id);
  });

  it("returns null for unknown id/email", async () => {
    expect(await repo.findById(randomUUID())).toBeNull();
    expect(await repo.findByEmail("nobody@example.com")).toBeNull();
  });

  it("counts users", async () => {
    expect(await repo.count()).toBe(0);
    await repo.insert(makeUser());
    await repo.insert(makeUser());
    expect(await repo.count()).toBe(2);
  });

  it("rejects a duplicate email (unique constraint)", async () => {
    await repo.insert(makeUser({ email: "dup@example.com" }));
    await expect(repo.insert(makeUser({ email: "dup@example.com" }))).rejects.toThrow();
  });

  it("allows more than one admin after the single-admin index is retired", async () => {
    await repo.insert(makeUser({ role: "admin" }));
    await expect(repo.insert(makeUser({ role: "admin" }))).resolves.toBeUndefined();
    expect(await repo.count()).toBe(2);
  });

  it("rejects a second setup bootstrap admin without limiting later admins", async () => {
    await repo.insert(makeUser({ role: "admin", setupBootstrap: true }));
    await expect(repo.insert(makeUser({ role: "admin", setupBootstrap: true }))).rejects.toThrow(
      AdminAlreadyExistsError
    );
    await expect(repo.insert(makeUser({ role: "admin" }))).resolves.toBeUndefined();
    expect(await repo.count()).toBe(2);
  });

  it("still allows member inserts after an admin exists", async () => {
    await repo.insert(makeUser({ role: "admin" }));
    await expect(repo.insert(makeUser({ role: "member" }))).resolves.toBeUndefined();
    expect(await repo.count()).toBe(2);
  });

  it("persists an invited account with no password hash", async () => {
    const user = makeUser({ passwordHash: null, status: "invited" });
    await repo.insert(user);
    const found = await repo.findById(user._id);
    expect(found?.passwordHash).toBeNull();
    expect(found?.status).toBe("invited");
  });

  it("setPassword writes the hash and activates the account", async () => {
    const user = makeUser({ passwordHash: null, status: "invited" });
    await repo.insert(user);
    await repo.setPassword(user._id, "argon2-hash");
    const found = await repo.findById(user._id);
    expect(found?.passwordHash).toBe("argon2-hash");
    expect(found?.status).toBe("active");
  });
});
