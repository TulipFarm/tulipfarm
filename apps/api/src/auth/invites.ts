import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db";
import type { PasswordWriteRepo, UserDoc, UserRepo } from "./users";

/**
 * Invite links: how an account gets its first password, and how it gets a new one after the old is
 * forgotten. An admin never mints, sees, or relays a credential — they create the account and hand
 * over a link, and the person on the other end chooses their own password when they open it.
 *
 * The token is a 32-byte random secret stored only as its SHA-256 hash and consumed atomically, so
 * a captured link redeems at most once and a stolen database yields no usable links. Unlike a
 * channel bind link (`identity/channel-link.ts`) it carries no claims, so there is nothing to sign:
 * the token *is* the secret and the row *is* the authority — which also means an outstanding invite
 * can be revoked, and re-issuing one does exactly that.
 *
 * Re-issuing for an account that is already `active` is the lockout recovery path. It deliberately
 * does not disturb the account: the existing password keeps working until the link is redeemed, so
 * a recovery link that is never opened locks nobody out.
 */

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
  create(invite: UserInviteDoc): Promise<void>;
  /** Revokes every outstanding link for a user, so at most one is ever live. */
  deleteUnconsumedForUser(userId: string): Promise<void>;
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
    await this.q.query(
      `INSERT INTO user_invites (token_hash, user_id, created_by, created_at, expires_at, consumed_at)
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

  async deleteUnconsumedForUser(userId: string): Promise<void> {
    await this.q.query("DELETE FROM user_invites WHERE user_id = $1 AND consumed_at IS NULL", [
      userId,
    ]);
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

/**
 * One coarse reason for every rejection. Whether a link was guessed, expired, or already redeemed
 * is not something the holder of a rejected link is entitled to learn.
 */
export class InviteDeniedError extends Error {
  constructor(message = "this invite link is no longer valid") {
    super(message);
    this.name = "InviteDeniedError";
  }
}

export interface IssuedInvite {
  token: string;
  expiresAt: Date;
}

/**
 * Issues the one live link for a user. Any outstanding link is revoked first, so the copy an admin
 * shared a moment ago stops working the instant they generate a replacement.
 */
export async function issueInvite(
  repo: UserInviteRepo,
  input: { userId: string; createdBy: string; ttlSeconds?: number }
): Promise<IssuedInvite> {
  const raw = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS) * 1000
  );

  await repo.deleteUnconsumedForUser(input.userId);
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

/**
 * The three stores a redemption spans: the link, the account it names, and the credential it sets.
 * They travel together because no invite operation is meaningful without all three — previewing
 * still has to resolve the account to name it, and spending a link still has to write a password.
 */
export interface InviteStores {
  invites: UserInviteRepo;
  users: UserRepo;
  passwords: PasswordWriteRepo;
}

export interface InviteOffer {
  email: string;
  expiresAt: Date;
}

/**
 * Resolves a token to the account it will set a password for, without spending it. The acceptance
 * page needs this: asking someone to choose a password for an account we cannot name, or setting
 * one on an account they were never shown, are both worse than one extra read.
 */
export async function previewInvite(stores: InviteStores, raw: string): Promise<InviteOffer> {
  const invite = await stores.invites.find(hashInviteToken(raw));
  if (!invite) throw new InviteDeniedError();
  const user = await stores.users.findById(invite.userId);
  // A disabled account keeps its invite row, but redeeming it would hand back an identity an admin
  // deliberately switched off — so the link is dead for the same reason a deleted user's is.
  if (!user || user.status === "disabled") throw new InviteDeniedError();
  return { email: user.email, expiresAt: invite.expiresAt };
}

/**
 * Redeems an invite: the token is spent atomically *before* the password is written, so two clicks
 * — or two tabs — set one password and refuse the other, never race to set two.
 */
export async function redeemInvite(
  stores: InviteStores,
  input: { raw: string; passwordHash: string }
): Promise<UserDoc> {
  const invite = await stores.invites.consume(hashInviteToken(input.raw));
  if (!invite) throw new InviteDeniedError();
  const user = await stores.users.findById(invite.userId);
  if (!user || user.status === "disabled") throw new InviteDeniedError();

  await stores.passwords.setPassword(user._id, input.passwordHash);
  return { ...user, passwordHash: input.passwordHash, status: "active" };
}
