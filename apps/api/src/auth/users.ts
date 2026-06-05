import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
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

export class MongoUserRepo implements UserRepo {
  private readonly collection: Collection<UserDoc>;

  constructor(db: Db) {
    this.collection = db.collection<UserDoc>("users");
  }

  findByEmail(email: string): Promise<UserDoc | null> {
    return this.collection.findOne({ email: normalizeEmail(email) });
  }

  findById(id: string): Promise<UserDoc | null> {
    return this.collection.findOne({ _id: id });
  }

  count(): Promise<number> {
    return this.collection.countDocuments();
  }

  async insert(user: UserDoc): Promise<void> {
    await this.collection.insertOne(user);
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
