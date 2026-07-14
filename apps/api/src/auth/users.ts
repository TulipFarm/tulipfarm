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

  async findFirstAdmin(): Promise<UserDoc | null> {
    const { rows } = await this.q.query(
      "SELECT * FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1"
    );
    return rows.length > 0 ? rowToUser(rows[0]) : null;
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
