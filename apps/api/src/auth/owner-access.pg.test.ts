/**
 * The `Owner` access level, end to end through the composition production runs: migrated rows,
 * the boot role sync, and `LiveRouteAuthorizer` in enforcing mode.
 *
 * Granting `Owner` through the product left the grantee refused by People & access exactly as
 * before, because the durable `owner` Role was never in the catalog the boot sync owns and so
 * kept a seed whose resource types no route declares (#408).
 */

import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { PgPrincipalRepo, PgRoleRepo } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { LiveRouteAuthorizer } from "../authz/route-gate";
import { transactionPort } from "../db";
import { buildApiAuthorityLayerResolver } from "../identity/authority-layers";
import { syncDeploymentRoles } from "../identity/roles";
import { makeMigratedPglite } from "../test/pglite";
import type { TokenDoc, TokenRepo } from "./api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "./csrf";
import type { UserInviteDoc, UserInviteRepo } from "./invites";
import { MemorySessionStore } from "./session-store";
import {
  createUser,
  EmailAlreadyExistsError,
  type PasswordWriteRepo,
  type UserAdminRepo,
  type UserDoc,
  type UserRepo,
} from "./users";

const PASSWORD = "correct-horse-battery";

class FakeUserRepo implements UserRepo, UserAdminRepo, PasswordWriteRepo {
  private readonly users: UserDoc[] = [];
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(user: UserDoc): Promise<void> {
    if (this.users.some((u) => u.email === user.email)) throw new EmailAlreadyExistsError();
    this.users.push(user);
  }
  async listAll(): Promise<UserDoc[]> {
    return [...this.users];
  }
  async setStatus(id: string, status: UserDoc["status"]): Promise<void> {
    const user = this.users.find((u) => u._id === id);
    if (user) user.status = status;
  }
  async setPassword(id: string, passwordHash: string): Promise<void> {
    const user = this.users.find((u) => u._id === id);
    if (user) user.passwordHash = passwordHash;
  }
}

class FakeInviteRepo implements UserInviteRepo {
  private readonly invites: UserInviteDoc[] = [];
  async create(invite: UserInviteDoc): Promise<void> {
    this.invites.push(invite);
  }
  async deleteUnconsumedForUser(): Promise<void> {}
  async find(): Promise<UserInviteDoc | null> {
    return null;
  }
  async consume(): Promise<UserInviteDoc | null> {
    return null;
  }
}

class FakeTokenRepo implements TokenRepo {
  async create(): Promise<void> {}
  async findByHash(): Promise<TokenDoc | null> {
    return null;
  }
  async findByUserId(): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [];
  }
  async findById(): Promise<TokenDoc | null> {
    return null;
  }
  async deleteById(): Promise<void> {}
  async findAllPaginated() {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated() {
    return { items: [], nextCursor: null };
  }
}

describe("the Owner access level under the live route gate", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let repo: FakeUserRepo;
  let ownerId: string;
  let memberId: string;

  /** Registers a durable principal for a user the way the users-table trigger does. */
  async function registerPrincipal(id: string, roleId: "member" | "owner"): Promise<void> {
    const transactions = transactionPort(db);
    await new PgPrincipalRepo(transactions).put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      id,
      kind: "user",
      status: "active",
    });
    await new PgRoleRepo(transactions).assign({
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: id,
      roleId,
    });
  }

  async function login(email: string): Promise<{ sid: string; csrf: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const sid = res.cookies.find((c) => c.name === "tf_sid")?.value;
    const csrf = res.cookies.find((c) => c.name === CSRF_COOKIE)?.value;
    if (!sid || !csrf) throw new Error("login issued no session cookie");
    return { sid, csrf };
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    await syncDeploymentRoles(new PgRoleRepo(transactionPort(db)));

    repo = new FakeUserRepo();
    // Both accounts are invited members — the default "Everyday access". Only one is then given
    // the Owner level, which is the whole difference the report turns on.
    const owner = await createUser(repo, "owner@example.com", PASSWORD, "member");
    const member = await createUser(repo, "member@example.com", PASSWORD, "member");
    ownerId = owner._id;
    memberId = member._id;
    await registerPrincipal(ownerId, "member");
    await registerPrincipal(memberId, "member");
    await registerPrincipal(ownerId, "owner");

    app = await buildApp({
      sessionStore: new MemorySessionStore(),
      userRepo: repo,
      tokenRepo: new FakeTokenRepo(),
      userAdminRepo: repo,
      userInviteRepo: new FakeInviteRepo(),
      routeAuthorizer: new LiveRouteAuthorizer(buildApiAuthorityLayerResolver(db)),
      authorizationGate: { mode: "enforcing" },
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("lets a granted Owner read People & access", async () => {
    const { sid } = await login("owner@example.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      cookies: { tf_sid: sid },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
  });

  it("still refuses People & access to everyday access", async () => {
    const { sid } = await login("member@example.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      cookies: { tf_sid: sid },
    });

    expect(res.statusCode).toBe(403);
  });

  it("lets a granted Owner change access, not only read it", async () => {
    const { sid, csrf } = await login("owner@example.com");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${memberId}/status`,
      cookies: { tf_sid: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: { status: "disabled" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("still refuses everyday access the write half of People & access", async () => {
    const { sid, csrf } = await login("member@example.com");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${ownerId}/status`,
      cookies: { tf_sid: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: { status: "disabled" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("does not widen the Owner grant to every principal", async () => {
    expect(memberId).not.toBe(ownerId);
    const roles = new PgRoleRepo(transactionPort(db));

    const assignees = await roles.listAssignees(DEPLOYMENT_BUSINESS_ID, "owner", new Date());

    expect(assignees.map((a) => a.principalId)).toEqual([ownerId]);
  });
});
