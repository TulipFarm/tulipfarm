import { randomUUID } from "node:crypto";
import type { Queryable } from "../../db";
import { hashPassword } from "../passwords";

export type Role = "admin" | "member";

/** Non-active users fail every credential path, including sessions and invites. */
export type UserStatus = "active" | "invited" | "disabled";

export interface UserDoc {
  _id: string;
  email: string;
  /** Null until the user chooses a password — an invited account has none, and should say so. */
  passwordHash: string | null;
  /** Null until set; never guess a name from email. */
  name: string | null;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  /** True only for the first-admin setup/bootstrap path that must be concurrency-guarded. */
  setupBootstrap?: boolean;
}

// Shape returned to clients — never includes the password hash.
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
}

export function toPublicUser(user: UserDoc): PublicUser {
  return {
    id: user._id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
  };
}

/** The longest display name worth storing — past this it stops being a name. */
export const MAX_NAME_CHARS = 80;

/** Trims and collapses whitespace; returns null for an empty display name. */
export function normalizeName(name: string): string | null {
  const collapsed = name.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface UserRepo {
  findByEmail(email: string): Promise<UserDoc | null>;
  findById(id: string): Promise<UserDoc | null>;
  /**
   * Many users at once. Optional so a fake need not grow a method it has no caller for; a caller
   * that finds it absent must fall back to `findById` per id rather than assume the batch exists.
   */
  findByIds?(ids: readonly string[]): Promise<UserDoc[]>;
  count(): Promise<number>;
  insert(user: UserDoc): Promise<void>;
}

/** Minimal surface for the admin Users page. */
export interface UserAdminRepo {
  listAll(): Promise<UserDoc[]>;
  setStatus(id: string, status: UserStatus): Promise<void>;
}

/** Minimal surface for password setting and invite redemption. */
export interface PasswordWriteRepo {
  /** Sets the password and marks the account active — redemption is what ends `invited`. */
  setPassword(id: string, passwordHash: string): Promise<void>;
}

/** Minimal surface for self-service profile routes. */
export interface ProfileWriteRepo {
  /** Null clears the name, returning the account to being addressed by its email. */
  setName(id: string, name: string | null): Promise<void>;
}

/** Thrown by `insert()` on a duplicate email — the caller maps this to `409`. */
export class EmailAlreadyExistsError extends Error {
  constructor() {
    super("a user with this email already exists");
    this.name = "EmailAlreadyExistsError";
  }
}

/** Raised on a concurrent first-admin claim. */
export class AdminAlreadyExistsError extends Error {
  constructor() {
    super("a setup admin user already exists");
    this.name = "AdminAlreadyExistsError";
  }
}

/** Narrow lookup used by ingress sender resolution. */
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
    name: (row.name as string | null) ?? null,
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

  async findByIds(ids: readonly string[]): Promise<UserDoc[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.q.query("SELECT * FROM users WHERE id = ANY($1::uuid[])", [
      [...ids],
    ]);
    return rows.map(rowToUser);
  }

  async count(): Promise<number> {
    const { rows } = await this.q.query("SELECT COUNT(*)::int AS count FROM users");
    return Number((rows[0] as { count: number }).count);
  }

  async insert(user: UserDoc): Promise<void> {
    try {
      await this.q.query(
        `INSERT INTO users (
           id, email, password_hash, name, role, status, created_at, setup_bootstrap
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          user._id,
          user.email,
          user.passwordHash,
          user.name,
          user.role,
          user.status,
          user.createdAt,
          user.setupBootstrap === true,
        ]
      );
    } catch (err) {
      if (isUniqueViolation(err, "users_setup_bootstrap_admin_idx")) {
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

  async setName(id: string, name: string | null): Promise<void> {
    await this.q.query("UPDATE users SET name = $2 WHERE id = $1", [id, name]);
  }
}

export async function createUser(
  repo: UserRepo,
  email: string,
  password: string,
  role: Role,
  options: {
    readonly setupBootstrap?: boolean;
    readonly name?: string;
    readonly insert?: (user: UserDoc) => Promise<void>;
  } = {}
): Promise<UserDoc> {
  const user: UserDoc = {
    _id: randomUUID(),
    email: normalizeEmail(email),
    passwordHash: await hashPassword(password),
    name: options.name ?? null,
    role,
    status: "active",
    createdAt: new Date(),
    ...(options.setupBootstrap === true ? { setupBootstrap: true } : {}),
  };
  await (options.insert ?? repo.insert.bind(repo))(user);
  return user;
}

/** Creates a passwordless member account; invite redemption activates login. */
export async function inviteUser(repo: UserRepo, email: string): Promise<UserDoc> {
  const user: UserDoc = {
    _id: randomUUID(),
    email: normalizeEmail(email),
    passwordHash: null,
    name: null,
    role: "member",
    status: "invited",
    createdAt: new Date(),
  };
  await repo.insert(user);
  return user;
}
