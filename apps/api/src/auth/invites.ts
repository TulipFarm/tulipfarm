import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db";
import type { PasswordWriteRepo, UserDoc, UserRepo } from "./users";

/** Invite tokens are 32-byte secrets stored as SHA-256 hashes and spent atomically. */

export const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface UserInviteDoc {
  tokenHash: string;
  userId: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface UserInviteRepo {
  /** Issues the one live link for a user, superseding any link still outstanding. */
  create(invite: UserInviteDoc): Promise<void>;
  /** Unspent state of an invite, for previewing it without spending it. */
  find(tokenHash: string): Promise<UserInviteDoc | null>;
  /** Atomically spends the invite; null when unknown, expired, or already redeemed. */
  consume(tokenHash: string): Promise<UserInviteDoc | null>;
}

export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function rowToInvite(row: Record<string, unknown>): UserInviteDoc {
  return {
    tokenHash: row.token_hash as string,
    userId: row.user_id as string,
    createdBy: row.created_by as string,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    consumedAt: (row.consumed_at as Date | null) ?? null,
  };
}

export class PgUserInviteRepo implements UserInviteRepo {
  constructor(private readonly q: Queryable) {}

  async create(invite: UserInviteDoc): Promise<void> {
    // Revoking the outstanding link and inserting its replacement must be one statement. As two,
    // a concurrent issue for the same user lands in between and deletes the token already handed
    // to the admin, so a link they were shown seconds ago previews as dead on its first use.
    await this.q.query(
      `WITH revoked AS (DELETE FROM user_invites WHERE user_id = $2 AND consumed_at IS NULL)
       INSERT INTO user_invites (token_hash, user_id, created_by, created_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        invite.tokenHash,
        invite.userId,
        invite.createdBy,
        invite.createdAt,
        invite.expiresAt,
        invite.consumedAt,
      ]
    );
  }

  async find(tokenHash: string): Promise<UserInviteDoc | null> {
    const { rows } = await this.q.query(
      "SELECT * FROM user_invites WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()",
      [tokenHash]
    );
    return rows.length > 0 ? rowToInvite(rows[0]) : null;
  }

  async consume(tokenHash: string): Promise<UserInviteDoc | null> {
    const { rows } = await this.q.query(
      `UPDATE user_invites SET consumed_at = now()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING *`,
      [tokenHash]
    );
    return rows.length > 0 ? rowToInvite(rows[0]) : null;
  }
}

/** Why an invite was refused. Server-side only — the wire message stays coarse. */
export type InviteDenialReason = "no-invite" | "redeemed" | "no-user" | "disabled";

/** Coarse rejection reason; never reveal guessed vs expired vs redeemed. */
export class InviteDeniedError extends Error {
  readonly reason: InviteDenialReason;

  constructor(reason: InviteDenialReason, message = "this invite link is no longer valid") {
    super(message);
    this.name = "InviteDeniedError";
    this.reason = reason;
  }
}

export interface IssuedInvite {
  token: string;
  expiresAt: Date;
}

/** Issue the one live link for a user, superseding any link still outstanding. */
export async function issueInvite(
  repo: UserInviteRepo,
  input: { userId: string; createdBy: string; ttlSeconds?: number }
): Promise<IssuedInvite> {
  const raw = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS) * 1000
  );

  await repo.create({
    tokenHash: hashInviteToken(raw),
    userId: input.userId,
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt,
    consumedAt: null,
  });
  return { token: raw, expiresAt };
}

/** Invite operations require the invite, user, and password stores together. */
export interface InviteStores {
  invites: UserInviteRepo;
  users: UserRepo;
  passwords: PasswordWriteRepo;
}

export interface InviteOffer {
  email: string;
  expiresAt: Date;
}

/** Preview resolves the account without spending the token. */
export async function previewInvite(stores: InviteStores, raw: string): Promise<InviteOffer> {
  const invite = await stores.invites.find(hashInviteToken(raw));
  if (!invite) throw new InviteDeniedError("no-invite");
  const user = await stores.users.findById(invite.userId);
  // Disabled-account invites are dead even if the invite row remains.
  if (!user || user.status === "disabled")
    throw new InviteDeniedError(user ? "disabled" : "no-user");
  return { email: user.email, expiresAt: invite.expiresAt };
}

/** Spend the token before writing the password so concurrent redeems cannot set two passwords. */
export async function redeemInvite(
  stores: InviteStores,
  input: { raw: string; passwordHash: string }
): Promise<UserDoc> {
  const invite = await stores.invites.consume(hashInviteToken(input.raw));
  if (!invite) throw new InviteDeniedError("redeemed");
  const user = await stores.users.findById(invite.userId);
  if (!user || user.status === "disabled")
    throw new InviteDeniedError(user ? "disabled" : "no-user");

  await stores.passwords.setPassword(user._id, input.passwordHash);
  return { ...user, passwordHash: input.passwordHash, status: "active" };
}
