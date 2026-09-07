import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { OimTriggerAuthorizationInput } from "./event-dispatch";
import { oimTriggerAuthorizer } from "./oim-trigger-authorization";

const BUSINESS_ID = "business-1";

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    businessId: BUSINESS_ID,
    id: "connection-1",
    integration: { id: "gitlab", majorVersion: 2 },
    label: "GitLab",
    owner: { scope: "personal", principalKind: "user", principalId: "owner-1" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: null },
    expiresAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function input(
  overrides: Partial<OimTriggerAuthorizationInput> = {}
): OimTriggerAuthorizationInput {
  return {
    businessId: BUSINESS_ID,
    integrationId: "gitlab",
    integrationMajorVersion: 2,
    connectionId: "connection-1",
    trigger: {
      triggerSlug: "on-push",
      authoredVersion: 1,
      lifecycle: "published",
      type: "integration_event",
      eventType: "push",
      eventVersion: 1,
      provider: "gitlab",
      protocol: "oim",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      routineRef: { name: "push-triage", version: "1" },
      backgroundIdentity: { principalKind: "user", principalId: "owner-1" },
    },
    ...overrides,
  };
}

describe("oimTriggerAuthorizer", () => {
  it("authorizes the pinned Routine owner, never the Trigger creator or provider payload", async () => {
    const persisted = connection();
    const canUse = vi.fn(async () => true);
    const authorize = oimTriggerAuthorizer({
      connections: { findById: async () => persisted },
      routineConnectionAccess: { canUse },
    });

    await expect(authorize(input())).resolves.toBe(true);
    expect(canUse).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      routineRef: { name: "push-triage", version: "1" },
      connection: persisted,
    });
  });

  it("denies when the live Routine owner or authority no longer permits the Connection", async () => {
    const authorize = oimTriggerAuthorizer({
      connections: { findById: async () => connection() },
      routineConnectionAccess: { canUse: async () => false },
    });

    await expect(authorize(input())).resolves.toBe(false);
  });

  it("fails closed when live Routine owner authorization cannot be read", async () => {
    const authorize = oimTriggerAuthorizer({
      connections: { findById: async () => connection() },
      routineConnectionAccess: {
        canUse: async () => {
          throw new Error("authority unavailable");
        },
      },
    });

    await expect(authorize(input())).resolves.toBe(false);
  });

  it("denies a missing, cross-business, revoked, wrong-Integration, or wrong-major Connection", async () => {
    const canUse = vi.fn(async () => true);
    let persisted: PersistedConnection | null = null;
    const authorize = oimTriggerAuthorizer({
      connections: { findById: async () => persisted },
      routineConnectionAccess: { canUse },
    });

    await expect(authorize(input())).resolves.toBe(false);
    persisted = connection({ businessId: "business-2" });
    await expect(authorize(input())).resolves.toBe(false);
    persisted = connection({ status: "revoked" });
    await expect(authorize(input())).resolves.toBe(false);
    persisted = connection({ integration: { id: "github", majorVersion: 2 } });
    await expect(authorize(input())).resolves.toBe(false);
    persisted = connection({ integration: { id: "gitlab", majorVersion: 3 } });
    await expect(authorize(input())).resolves.toBe(false);
    expect(canUse).not.toHaveBeenCalled();
  });
});
