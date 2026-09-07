import {
  type ConnectionSecretScope,
  inMemorySecretProvider,
  SecretBroker,
} from "@tulipfarm/secrets";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserInviteDoc, UserInviteRepo } from "../auth/invites";
import { registerAdminUserRoutes } from "../auth/routes/users";
import type { UserAdminRepo, UserDoc, UserRepo, UserStatus } from "../auth/users";
import { OimUserOffboarding } from "./oim-user-offboarding";
import { reconcileDisabledUsers } from "./oim-user-offboarding-schedule";

const BUSINESS_ID = "business-1";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000003";
const SECRET_REF = "secret://connections/personal/api_key" as const;

type ConnectionRow = {
  id: string;
  owner:
    | { scope: "personal"; principalId: string }
    | { scope: "organization" }
    | { scope: "team"; teamId: string };
  status: "active" | "revoked";
};

class FakeConnections {
  constructor(readonly rows: ConnectionRow[]) {}

  async listPersonalForPrincipal(
    _businessId: string,
    principalId: string
  ): Promise<ConnectionRow[]> {
    return this.rows.filter(
      (row) => row.owner.scope === "personal" && row.owner.principalId === principalId
    );
  }

  async markRevoked(_businessId: string, connectionId: string): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === connectionId);
    if (row === undefined || row.status === "revoked") return false;
    row.status = "revoked";
    return true;
  }
}

class FakeUsers implements UserRepo, UserAdminRepo {
  constructor(readonly users: UserDoc[]) {}

  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((user) => user.email === email) ?? null;
  }

  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((user) => user._id === id) ?? null;
  }

  async count(): Promise<number> {
    return this.users.length;
  }

  async insert(user: UserDoc): Promise<void> {
    this.users.push(user);
  }

  async listAll(): Promise<UserDoc[]> {
    return [...this.users];
  }

  async setStatus(id: string, status: UserStatus): Promise<void> {
    const user = this.users.find((candidate) => candidate._id === id);
    if (user !== undefined) user.status = status;
  }
}

class FakeInvites implements UserInviteRepo {
  async create(_invite: UserInviteDoc): Promise<void> {}
  async find(_tokenHash: string): Promise<UserInviteDoc | null> {
    return null;
  }
  async consume(_tokenHash: string): Promise<UserInviteDoc | null> {
    return null;
  }
}

function user(id: string, role: UserDoc["role"], status: UserStatus = "active"): UserDoc {
  return {
    _id: id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    name: null,
    role,
    status,
    createdAt: new Date("2026-08-16T12:00:00.000Z"),
  };
}

function registerDisableRoute(
  app: FastifyInstance,
  users: FakeUsers,
  onUserDisabled: (userId: string) => Promise<void>
): void {
  registerAdminUserRoutes(
    app,
    users,
    users,
    new FakeInvites(),
    async (req) => {
      req.user = users.users[0];
    },
    () => async () => {},
    undefined,
    undefined,
    onUserDisabled
  );
}

describe("OIM user offboarding", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("offboards personal Connections and leases through the disable-user route", async () => {
    const users = new FakeUsers([user(ADMIN_ID, "admin"), user(USER_ID, "member")]);
    const connections = new FakeConnections([
      { id: "personal", owner: { scope: "personal", principalId: USER_ID }, status: "active" },
      {
        id: "other-personal",
        owner: { scope: "personal", principalId: OTHER_USER_ID },
        status: "active",
      },
      { id: "organization", owner: { scope: "organization" }, status: "active" },
      { id: "team", owner: { scope: "team", teamId: "team-1" }, status: "active" },
    ]);
    const provider = inMemorySecretProvider({ [SECRET_REF]: "personal-secret" });
    const broker = new SecretBroker({
      provider,
      authorizer: { authorize: () => ({ allowed: true }) },
    });
    const scope: ConnectionSecretScope = {
      secretRef: SECRET_REF,
      connectionId: "personal",
      credentialSlot: "api_key",
      integrationId: "example",
      toolId: "example.request",
      runId: "run-1",
      purpose: "integration.request",
      principalKind: "user",
      principalId: USER_ID,
    };
    const lease = await broker.leaseConnection({ scope, maxUses: 1 });
    const pausePersonalRoutines = vi.fn(async () => {});
    const offboarding = new OimUserOffboarding({
      businessId: BUSINESS_ID,
      connections,
      revokeConnectionLeases: async ({ businessId, connectionId }) => {
        expect(businessId).toBe(BUSINESS_ID);
        expect(users.users[1]?.status).toBe("disabled");
        broker.revokeConnection(connectionId);
      },
      pausePersonalRoutines,
    });

    app = Fastify();
    registerDisableRoute(app, users, (userId) => offboarding.disableUser(userId));

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${USER_ID}/status`,
      payload: { status: "disabled" },
    });

    expect(response.statusCode).toBe(200);
    expect(connections.rows).toEqual([
      { id: "personal", owner: { scope: "personal", principalId: USER_ID }, status: "revoked" },
      {
        id: "other-personal",
        owner: { scope: "personal", principalId: OTHER_USER_ID },
        status: "active",
      },
      { id: "organization", owner: { scope: "organization" }, status: "active" },
      { id: "team", owner: { scope: "team", teamId: "team-1" }, status: "active" },
    ]);
    await expect(lease.use(() => "used", scope)).rejects.toMatchObject({
      name: "SecretLeaseDeniedError",
      reason: "revoked",
    });
    await expect(provider.resolveCurrent(SECRET_REF)).resolves.toMatchObject({
      value: "personal-secret",
    });
    expect(pausePersonalRoutines).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      userId: USER_ID,
    });
  });

  it("automatically reconciles incomplete offboarding from durable disabled-user state", async () => {
    const users = new FakeUsers([user(ADMIN_ID, "admin"), user(USER_ID, "member")]);
    const connections = new FakeConnections([
      { id: "personal", owner: { scope: "personal", principalId: USER_ID }, status: "active" },
    ]);
    let leaseAttempts = 0;
    const pausePersonalRoutines = vi.fn(async () => {});
    const offboarding = new OimUserOffboarding({
      businessId: BUSINESS_ID,
      connections,
      revokeConnectionLeases: async () => {
        leaseAttempts += 1;
        if (leaseAttempts === 1) throw new Error("lease registry unavailable");
      },
      pausePersonalRoutines,
    });

    app = Fastify();
    registerDisableRoute(app, users, (userId) => offboarding.disableUser(userId));

    const first = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${USER_ID}/status`,
      payload: { status: "disabled" },
    });
    expect(first.statusCode).toBe(500);
    expect(users.users[1]?.status).toBe("disabled");
    expect(connections.rows[0]?.status).toBe("revoked");
    expect(pausePersonalRoutines).toHaveBeenCalledTimes(1);

    await reconcileDisabledUsers({
      users,
      offboarding,
    });
    expect(leaseAttempts).toBe(2);
    expect(pausePersonalRoutines).toHaveBeenCalledTimes(2);
  });

  it("preserves every cleanup failure after attempting all personal offboarding", async () => {
    const connectionError = new Error("Connection update failed");
    const leaseError = new Error("lease revocation failed");
    const routineError = new Error("Routine pause failed");
    const offboarding = new OimUserOffboarding({
      businessId: BUSINESS_ID,
      connections: {
        listPersonalForPrincipal: async () => [{ id: "personal" }],
        markRevoked: async () => {
          throw connectionError;
        },
      },
      revokeConnectionLeases: async () => {
        throw leaseError;
      },
      pausePersonalRoutines: async () => {
        throw routineError;
      },
    });

    const error = await offboarding.disableUser(USER_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([connectionError, leaseError, routineError]);
  });

  it("does not run offboarding when a disabled user is re-enabled", async () => {
    const users = new FakeUsers([user(ADMIN_ID, "admin"), user(USER_ID, "member", "disabled")]);
    const onUserDisabled = vi.fn(async () => {});
    app = Fastify();
    registerDisableRoute(app, users, onUserDisabled);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${USER_ID}/status`,
      payload: { status: "active" },
    });

    expect(response.statusCode).toBe(200);
    expect(users.users[1]?.status).toBe("active");
    expect(onUserDisabled).not.toHaveBeenCalled();
  });
});
