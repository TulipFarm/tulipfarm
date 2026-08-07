import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import {
  hashInviteToken,
  InviteDeniedError,
  type InviteStores,
  issueInvite,
  PgUserInviteRepo,
  previewInvite,
  redeemInvite,
} from "./invites";
import { createUser, inviteUser, PgUserRepo } from "./users";

describe("user invites (Postgres)", () => {
  let db: PGlite;
  let users: PgUserRepo;
  let invites: PgUserInviteRepo;
  let stores: InviteStores;
  let adminId: string;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    users = new PgUserRepo(db);
    invites = new PgUserInviteRepo(db);
    // One PgUserRepo satisfies both the account lookup and the password write.
    stores = { invites, users, passwords: users };
    adminId = (await createUser(users, "admin@example.com", "pass", "admin"))._id;
  });

  afterEach(async () => {
    await db.close();
  });

  async function invite(email = "invitee@example.com") {
    const user = await inviteUser(users, email);
    const issued = await issueInvite(invites, { userId: user._id, createdBy: adminId });
    return { user, token: issued.token };
  }

  it("stores only the token hash", async () => {
    const { token } = await invite();
    const { rows } = await db.query<{ token_hash: string }>("SELECT token_hash FROM user_invites");
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashInviteToken(token));
    expect(rows[0].token_hash).not.toBe(token);
  });

  it("previews without spending, then redeems once", async () => {
    const { user, token } = await invite();

    expect((await previewInvite(stores, token)).email).toBe("invitee@example.com");
    expect((await previewInvite(stores, token)).email).toBe("invitee@example.com");

    const redeemed = await redeemInvite(stores, {
      raw: token,
      passwordHash: "argon2-hash",
    });
    expect(redeemed.status).toBe("active");
    expect((await users.findById(user._id))?.passwordHash).toBe("argon2-hash");

    await expect(
      redeemInvite(stores, { raw: token, passwordHash: "attacker-hash" })
    ).rejects.toThrow(InviteDeniedError);
    expect((await users.findById(user._id))?.passwordHash).toBe("argon2-hash");
  });

  it("re-issuing revokes the outstanding link", async () => {
    const { user, token } = await invite();
    const replacement = await issueInvite(invites, { userId: user._id, createdBy: adminId });

    await expect(previewInvite(stores, token)).rejects.toThrow(InviteDeniedError);
    expect((await previewInvite(stores, replacement.token)).email).toBe("invitee@example.com");
  });

  it("refuses an expired link", async () => {
    const { user } = await invite();
    const issued = await issueInvite(invites, {
      userId: user._id,
      createdBy: adminId,
      ttlSeconds: -1,
    });
    await expect(previewInvite(stores, issued.token)).rejects.toThrow(InviteDeniedError);
  });

  it("refuses an unknown link", async () => {
    await expect(previewInvite(stores, randomUUID())).rejects.toThrow(InviteDeniedError);
  });

  it("refuses a disabled account's link", async () => {
    const { user, token } = await invite();
    await users.setStatus(user._id, "disabled");
    await expect(previewInvite(stores, token)).rejects.toThrow(InviteDeniedError);
  });

  it("keeps a redeemed link on the row so its use stays auditable", async () => {
    const { token } = await invite();
    await redeemInvite(stores, { raw: token, passwordHash: "argon2-hash" });

    const { rows } = await db.query<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM user_invites WHERE token_hash = $1",
      [hashInviteToken(token)]
    );
    expect(rows[0].consumed_at).not.toBeNull();
  });
});
