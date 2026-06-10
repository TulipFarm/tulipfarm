import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { hashPassword } from "./passwords";

export type Role = "admin" | "member";

export interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
}

// Shape returned to clients — never includes the password hash.
export interface PublicUser {
  id: string;
  email: string;
  role: Role;
}

export function toPublicUser(user: UserDoc): PublicUser {
  return { id: user._id, email: user.email, role: user.role };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface UserRepo {
  findByEmail(email: string): Promise<UserDoc | null>;
  findById(id: string): Promise<UserDoc | null>;
  count(): Promise<number>;
  insert(user: UserDoc): Promise<void>;
  // Atomic "first admin wins": insert only if the users table is empty. Returns true
  // when this call created the row, false when another row already existed (race lost).
  // Optional so test fakes need not implement it; createFirstAdmin falls back to
  // count()+insert when absent (single-process tests don't race).
  insertIfFirst?(user: UserDoc): Promise<boolean>;
}

function rowToUser(row: Record<string, unknown>): UserDoc {
  return {
    _id: row.id as string,
    email: row.email as string,
    passwordHash: row.password_hash as string,
    role: row.role as Role,
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
    await this.q.query(
      "INSERT INTO users (id, email, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5)",
      [user._id, user.email, user.passwordHash, user.role, user.createdAt]
    );
  }

  async insertIfFirst(user: UserDoc): Promise<boolean> {
    // Conditional insert: the WHERE NOT EXISTS makes "no users yet" and the insert one
    // atomic statement, so two concurrent first-admin requests can't both succeed.
    // RETURNING + rows.length is portable across pg (rowCount) and PGlite (affectedRows).
    const { rows } = await this.q.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM users)
       RETURNING id`,
      [user._id, user.email, user.passwordHash, user.role, user.createdAt]
    );
    return rows.length > 0;
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
    createdAt: new Date(),
  };
  await repo.insert(user);
  return user;
}

// Atomically create the first admin: succeeds only when no users exist yet. Returns the
// created user, or null when another account already exists (lost the first-admin race or
// setup is already done). Used by the open setup-wizard endpoint to close the TOCTOU
// window between the "is setup open?" check and the insert.
export async function createFirstAdmin(
  repo: UserRepo,
  email: string,
  password: string
): Promise<UserDoc | null> {
  const user: UserDoc = {
    _id: randomUUID(),
    email: normalizeEmail(email),
    passwordHash: await hashPassword(password),
    role: "admin",
    createdAt: new Date(),
  };
  if (repo.insertIfFirst) {
    return (await repo.insertIfFirst(user)) ? user : null;
  }
  // Fallback for repos without the atomic path (test fakes; no real concurrency).
  if ((await repo.count()) > 0) return null;
  await repo.insert(user);
  return user;
}

// Seeds the first admin on boot when no users exist and ADMIN_EMAIL/ADMIN_PASSWORD
// are set. Idempotent — a no-op once any user exists or the env vars are absent.
export async function bootstrapAdmin(
  repo: UserRepo,
  log?: { info: (msg: string) => void }
): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  if ((await repo.count()) > 0) return;

  await createUser(repo, email, password, "admin");
  log?.info(`Bootstrapped admin user ${normalizeEmail(email)}`);
}
