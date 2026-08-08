import { randomUUID } from "node:crypto";
import type { Queryable } from "../../db";
import { hashPassword } from "../passwords";

export type Role = "admin" | "member";

/**
 * Lifecycle state of a local identity. A user that is not `active` fails authentication at every
 * credential path — cookie session, API token, and identity link — so deactivation takes effect on
 * the next request instead of waiting for a session to lapse (SPEC §12).
 *
 * `invited` is an account that exists but has chosen no password yet: the admin created it and
 * shared an invite link, and it becomes `active` the moment that link is redeemed. It is a distinct
 * state rather than a disabled account so the Users list can show who has not accepted yet.
 */
export type UserStatus = "active" | "invited" | "disabled";

export interface UserDoc {
  _id: string;
  email: string;
  /** Null until the user chooses a password — an invited account has none, and should say so. */
  passwordHash: string | null;
  role: Role;
  status: UserStatus;
  createdAt: Date;
}

// Shape returned to clients — never includes the password hash.
export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
}

export function toPublicUser(user: UserDoc): PublicUser {
  return {
    id: user._id,
    email: user.email,
    role: user.role,
    status: user.status,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface UserRepo {
  findByEmail(email: string): Promise<UserDoc | null>;
  findById(id: string): Promise<UserDoc | null>;
  count(): Promise<number>;
  insert(user: UserDoc): Promise<void>;
}

/**
 * The narrow surface the admin Users page needs (list + enable/disable). Kept separate from
 * UserRepo so test fakes that don't exercise user administration don't have to implement it —
 * same rationale as {@link IngressUserLookup}. PgUserRepo satisfies it.
 */
export interface UserAdminRepo {
  listAll(): Promise<UserDoc[]>;
  setStatus(id: string, status: UserStatus): Promise<void>;
}

/**
 * The narrow surface the password-setting flows need — the Settings change-password form and
 * invite redemption, which also activates the account it belongs to. Kept separate from UserRepo
 * for the same reason as {@link UserAdminRepo}. PgUserRepo satisfies it.
 */
export interface PasswordWriteRepo {
  /** Sets the password and marks the account active — redemption is what ends `invited`. */
  setPassword(id: string, passwordHash: string): Promise<void>;
}

/** Thrown by `insert()` on a duplicate email — the caller maps this to `409`. */
export class EmailAlreadyExistsError extends Error {
  constructor() {
    super("a user with this email already exists");
    this.name = "EmailAlreadyExistsError";
  }
}

/**
 * Thrown by `insert()` when a second admin row would violate the single-admin database
 * invariant (`users_single_admin_idx`, greenfield baseline) — the concurrency-safe replacement
 * for the old check-then-insert `count() === 0` race in setup/routes.ts (#172).
 */
export class AdminAlreadyExistsError extends Error {
  constructor() {
    super("an admin user already exists");
    this.name = "AdminAlreadyExistsError";
  }
}

/**
 * The narrow lookup surface integration ingress needs to resolve an inbound sender to a
 * TulipFarm user (email match → admin fallback). Kept separate from UserRepo so test fakes
 * that don't care about ingress don't have to implement findFirstAdmin. PgUserRepo satisfies it.
 */
export interface IngressUserLookup {
  findByEmail(email: string): Promise<UserDoc | null>;
  findById(id: string): Promise<UserDoc | null>;
  /** Oldest admin user — the fallback identity for integration ingress turns. */
  findFirstAdmin(): Promise<UserDoc | null>;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

function rowToUser(row: Record<string, unknown>): UserDoc {
  return {
    _id: row.id as string,
    email: row.email as string,
    passwordHash: (row.password_hash as string | null) ?? null,
    role: row.role as Role,
    status: row.status as UserStatus,
    createdAt: row.created_at as Date,
  };
}

export class PgUserRepo implements UserRepo {
  constructor(private readonly q: Queryable) {}

  async findByEmail(email: string): Promise<UserDoc | null> {
    const { rows } = await this.q.query("SELECT * FROM users WHERE email = $1", [
      normalizeEmail(email),
    ]);
    return rows.length > 0 ? rowToUser(rows[0]) : null;
  }

  async findById(id: string): Promise<UserDoc | null> {
    const { rows } = await this.q.query("SELECT * FROM users WHERE id = $1", [id]);
    return rows.length > 0 ? rowToUser(rows[0]) : null;
  }

  async count(): Promise<number> {
    const { rows } = await this.q.query("SELECT COUNT(*)::int AS count FROM users");
    return Number((rows[0] as { count: number }).count);
  }

  async insert(user: UserDoc): Promise<void> {
    try {
      await this.q.query(
        `INSERT INTO users (id, email, password_hash, role, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user._id, user.email, user.passwordHash, user.role, user.status, user.createdAt]
      );
    } catch (err) {
      if (user.role === "admin" && isUniqueViolation(err, "users_single_admin_idx")) {
        throw new AdminAlreadyExistsError();
      }
      if (isUniqueViolation(err, "users_email_key")) {
        throw new EmailAlreadyExistsError();
      }
      throw err;
    }
  }

  async findFirstAdmin(): Promise<UserDoc | null> {
    const { rows } = await this.q.query(
      "SELECT * FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at, id LIMIT 1"
    );
    return rows.length > 0 ? rowToUser(rows[0]) : null;
  }

  async listAll(): Promise<UserDoc[]> {
    const { rows } = await this.q.query("SELECT * FROM users ORDER BY created_at, id");
    return rows.map(rowToUser);
  }

  async setStatus(id: string, status: UserStatus): Promise<void> {
    await this.q.query("UPDATE users SET status = $2 WHERE id = $1", [id, status]);
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.q.query("UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1", [
      id,
      passwordHash,
    ]);
  }
}

export async function createUser(
  repo: UserRepo,
  email: string,
  password: string,
  role: Role
): Promise<UserDoc> {
  const user: UserDoc = {
    _id: randomUUID(),
    email: normalizeEmail(email),
    passwordHash: await hashPassword(password),
    role,
    status: "active",
    createdAt: new Date(),
  };
  await repo.insert(user);
  return user;
}

/**
 * Creates a member account that has no password at all. It cannot authenticate until its invite
 * link is redeemed — which is the point: an admin provisioning a colleague never handles, sees, or
 * relays a credential for them.
 */
export async function inviteUser(repo: UserRepo, email: string): Promise<UserDoc> {
  const user: UserDoc = {
    _id: randomUUID(),
    email: normalizeEmail(email),
    passwordHash: null,
    role: "member",
    status: "invited",
    createdAt: new Date(),
  };
  await repo.insert(user);
  return user;
}

// Deterministic dev admin. In non-production, when ADMIN_EMAIL/ADMIN_PASSWORD are not set, the
// first admin defaults to these known dev credentials so `pnpm dev` is sign-in-ready with zero
// setup (and the login screen prefills them). Production has NO default — it requires the env vars,
// so a known-password admin is never auto-seeded in prod.
export const DEV_ADMIN_EMAIL = "admin@tulipfarm.dev";
export const DEV_ADMIN_PASSWORD = "password123";

// Seeds the first admin on boot when no users exist. Uses ADMIN_EMAIL/ADMIN_PASSWORD when set;
// otherwise falls back to the dev defaults in non-production. Idempotent — a no-op once any user
// exists, or when neither env vars nor (in prod) a default are available.
export async function bootstrapAdmin(
  repo: UserRepo,
  log?: { info: (msg: string) => void }
): Promise<void> {
  const isProd = process.env.NODE_ENV === "production";
  const email = process.env.ADMIN_EMAIL ?? (isProd ? undefined : DEV_ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD ?? (isProd ? undefined : DEV_ADMIN_PASSWORD);
  if (!email || !password) return;
  if ((await repo.count()) > 0) return;

  await createUser(repo, email, password, "admin");
  log?.info(`Bootstrapped admin user ${normalizeEmail(email)}`);
  if (!process.env.ADMIN_PASSWORD && !isProd) {
    log?.info("Using dev default admin password (password123) — set ADMIN_PASSWORD to override.");
  }
}
