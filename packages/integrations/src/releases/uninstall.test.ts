import { describe, expect, it, vi } from "vitest";
import {
  getOimUninstallStatus,
  type OimUninstallConnection,
  OimUninstallError,
  type OimUninstallJournal,
  type OimUninstallJournalPort,
  type OimUninstallScope,
  type OimUninstallStep,
  type OimUninstallTarget,
  uninstallOimRelease,
  uninstallOimReleaseGeneration,
} from "./uninstall";

const SCOPE = {
  businessId: "business-1",
  integrationId: "acme",
  majorVersion: 2,
} as const;
const TARGET = {
  ...SCOPE,
  installationId: "installed-2026-09-13T09:00:00.000Z",
  slug: "weather-v1",
  packageDigest: "a".repeat(64),
  soulRevision: "soul-a1b2c3",
} as const;
const NOW = new Date("2026-09-13T10:30:00.000Z");

class MemoryJournal implements OimUninstallJournalPort {
  record: OimUninstallJournal | null = null;
  private exclusiveTail = Promise.resolve();

  async runExclusive<T>(_scope: OimUninstallScope, operation: () => Promise<T>): Promise<T> {
    const preceding = this.exclusiveTail;
    let release = () => {};
    this.exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async begin(target: OimUninstallTarget, startedAt: string): Promise<OimUninstallJournal> {
    if (
      this.record === null ||
      (this.record.status === "complete" && this.record.installationId !== target.installationId)
    ) {
      this.record = {
        ...target,
        status: "pending",
        completedSteps: [],
        revokedConnectionIds: [],
        inFlightWorkIds: [],
        retry: null,
        startedAt,
        completedAt: null,
      };
    }
    return structuredClone(this.record);
  }

  async get(): Promise<OimUninstallJournal | null> {
    return this.record === null ? null : structuredClone(this.record);
  }

  async markStepCompleted(
    _scope: OimUninstallScope,
    step: OimUninstallStep,
    completedAt: string,
    inFlightWorkIds: readonly string[] = []
  ): Promise<void> {
    if (this.record === null) throw new Error("journal_not_started");
    this.record = {
      ...this.record,
      completedSteps: [...this.record.completedSteps, step],
      inFlightWorkIds:
        step === "traffic_fenced_and_drained" ? [...inFlightWorkIds] : this.record.inFlightWorkIds,
      retry: null,
      updatedAt: completedAt,
    };
  }

  async markConnectionRevoked(
    _scope: OimUninstallScope,
    connectionId: string,
    updatedAt: string
  ): Promise<void> {
    if (this.record === null) throw new Error("journal_not_started");
    this.record = {
      ...this.record,
      revokedConnectionIds: [...this.record.revokedConnectionIds, connectionId],
      retry: null,
      updatedAt,
    };
  }

  async markRetryRequired(
    _scope: OimUninstallScope,
    retry: NonNullable<OimUninstallJournal["retry"]>
  ): Promise<void> {
    if (this.record === null) throw new Error("journal_not_started");
    this.record = { ...this.record, retry };
  }

  async markCompleted(_scope: OimUninstallScope, completedAt: string): Promise<void> {
    if (this.record === null) throw new Error("journal_not_started");
    this.record = {
      ...this.record,
      status: "complete",
      retry: null,
      completedAt,
      updatedAt: completedAt,
    };
  }
}

function connection(connectionId: string): OimUninstallConnection {
  return { ...TARGET, connectionId };
}

describe("uninstallOimRelease", () => {
  it("runs the exact-major teardown in credential-safe order and marks complete last", async () => {
    const order: string[] = [];
    const journal = new MemoryJournal();
    const credentialConnections = new Set(["connection-1", "connection-2"]);
    const host = {
      fenceAndDrain: vi.fn(async () => {
        order.push("fence");
        return {
          toolDispatchFenced: true as const,
          ingressFenced: true as const,
          inFlightWorkDrained: true as const,
          inFlightWorkIds: ["run-1"],
        };
      }),
      unsubscribeRemote: vi.fn(async () => {
        expect([...credentialConnections]).toEqual(["connection-1", "connection-2"]);
        order.push("unsubscribe");
        return { remoteCleanupComplete: true };
      }),
      listConnections: vi.fn(async () => [connection("connection-1"), connection("connection-2")]),
      revokeConnection: vi.fn(async (value: OimUninstallConnection) => {
        expect(credentialConnections.has(value.connectionId)).toBe(true);
        credentialConnections.delete(value.connectionId);
        order.push(`revoke:${value.connectionId}`);
      }),
      removePackageOwnedState: vi.fn(async () => {
        order.push("owned-state");
      }),
      removeReleaseProvenance: vi.fn(async () => {
        order.push("provenance");
      }),
      removeSoulPackage: vi.fn(async () => {
        order.push("soul-package");
      }),
    };

    await expect(uninstallOimRelease({ journal, host, now: () => NOW }, TARGET)).resolves.toEqual({
      scope: TARGET,
      status: "complete",
    });

    expect(order).toEqual([
      "fence",
      "unsubscribe",
      "revoke:connection-1",
      "revoke:connection-2",
      "owned-state",
      "provenance",
      "soul-package",
    ]);
    expect(journal.record).toMatchObject({
      status: "complete",
      completedSteps: [
        "traffic_fenced_and_drained",
        "remote_unsubscribed",
        "connections_revoked",
        "owned_state_removed",
        "release_provenance_removed",
        "soul_package_removed",
      ],
      revokedConnectionIds: ["connection-1", "connection-2"],
      inFlightWorkIds: ["run-1"],
      completedAt: NOW.toISOString(),
    });
  });

  it("records a retry obligation and leaves the Soul package when teardown fails", async () => {
    const journal = new MemoryJournal();
    const failure = new Error("owned state unavailable");
    const removeSoulPackage = vi.fn(async () => {});

    const uninstall = uninstallOimRelease(
      {
        journal,
        now: () => NOW,
        host: {
          fenceAndDrain: async () => ({
            toolDispatchFenced: true,
            ingressFenced: true,
            inFlightWorkDrained: true,
            inFlightWorkIds: [],
          }),
          unsubscribeRemote: async () => ({ remoteCleanupComplete: true }),
          listConnections: async () => [],
          revokeConnection: async () => {},
          removePackageOwnedState: async () => Promise.reject(failure),
          removeReleaseProvenance: async () => {},
          removeSoulPackage,
        },
      },
      TARGET
    );
    await expect(uninstall).rejects.toBeInstanceOf(OimUninstallError);
    await expect(uninstall).rejects.toEqual(
      expect.objectContaining({
        code: "OIM_UNINSTALL_STEP_FAILED",
        step: "owned_state_removed",
        cause: failure,
      })
    );

    expect(removeSoulPackage).not.toHaveBeenCalled();
    expect(journal.record).toMatchObject({
      status: "pending",
      completedSteps: ["traffic_fenced_and_drained", "remote_unsubscribed", "connections_revoked"],
      retry: {
        step: "owned_state_removed",
        message: "owned state unavailable",
        failedAt: NOW.toISOString(),
      },
      completedAt: null,
    });
  });

  it("retains credentials and package bytes until remote ingress cleanup completes", async () => {
    const journal = new MemoryJournal();
    const revokeConnection = vi.fn(async () => {});
    const removeSoulPackage = vi.fn(async () => {});

    await expect(
      uninstallOimRelease(
        {
          journal,
          now: () => NOW,
          host: {
            fenceAndDrain: async () => ({
              toolDispatchFenced: true,
              ingressFenced: true,
              inFlightWorkDrained: true,
              inFlightWorkIds: [],
            }),
            unsubscribeRemote: async () => ({ remoteCleanupComplete: false }),
            listConnections: async () => [connection("connection-1")],
            revokeConnection,
            removePackageOwnedState: async () => {},
            removeReleaseProvenance: async () => {},
            removeSoulPackage,
          },
        },
        TARGET
      )
    ).rejects.toMatchObject({
      code: "OIM_UNINSTALL_STEP_FAILED",
      step: "remote_unsubscribed",
    });

    expect(revokeConnection).not.toHaveBeenCalled();
    expect(removeSoulPackage).not.toHaveBeenCalled();
    expect(journal.record?.retry?.message).toBe("remote_cleanup_incomplete");
  });

  it("resumes from the durable journal without repeating completed irreversible work", async () => {
    const journal = new MemoryJournal();
    const calls: string[] = [];
    let failSecondConnection = true;
    const host = {
      fenceAndDrain: async () => {
        calls.push("fence");
        return {
          toolDispatchFenced: true as const,
          ingressFenced: true as const,
          inFlightWorkDrained: true as const,
          inFlightWorkIds: [],
        };
      },
      unsubscribeRemote: async () => {
        calls.push("unsubscribe");
        return { remoteCleanupComplete: true };
      },
      listConnections: async () => [connection("connection-1"), connection("connection-2")],
      revokeConnection: async (value: OimUninstallConnection) => {
        calls.push(`revoke:${value.connectionId}`);
        if (value.connectionId === "connection-2" && failSecondConnection) {
          throw new Error("temporary revoke failure");
        }
      },
      removePackageOwnedState: async () => {
        calls.push("owned-state");
      },
      removeReleaseProvenance: async () => {
        calls.push("provenance");
      },
      removeSoulPackage: async () => {
        calls.push("soul-package");
      },
    };

    await expect(uninstallOimRelease({ journal, host, now: () => NOW }, TARGET)).rejects.toThrow(
      "connections_revoked"
    );
    failSecondConnection = false;
    await expect(uninstallOimRelease({ journal, host, now: () => NOW }, TARGET)).resolves.toEqual({
      scope: TARGET,
      status: "complete",
    });

    expect(calls).toEqual([
      "fence",
      "unsubscribe",
      "revoke:connection-1",
      "revoke:connection-2",
      "revoke:connection-2",
      "owned-state",
      "provenance",
      "soul-package",
    ]);
  });

  it("fails closed before touching a Connection from another Integration major", async () => {
    const journal = new MemoryJournal();
    const revokeConnection = vi.fn(async () => {});
    const removeSoulPackage = vi.fn(async () => {});

    await expect(
      uninstallOimRelease(
        {
          journal,
          now: () => NOW,
          host: {
            fenceAndDrain: async () => ({
              toolDispatchFenced: true,
              ingressFenced: true,
              inFlightWorkDrained: true,
              inFlightWorkIds: [],
            }),
            unsubscribeRemote: async () => ({ remoteCleanupComplete: true }),
            listConnections: async () => [
              connection("connection-target"),
              { ...connection("connection-other"), majorVersion: 3 },
            ],
            revokeConnection,
            removePackageOwnedState: async () => {},
            removeReleaseProvenance: async () => {},
            removeSoulPackage,
          },
        },
        TARGET
      )
    ).rejects.toEqual(
      expect.objectContaining({
        code: "OIM_UNINSTALL_STEP_FAILED",
        step: "connections_revoked",
      })
    );

    expect(revokeConnection).not.toHaveBeenCalled();
    expect(removeSoulPackage).not.toHaveBeenCalled();
    expect(journal.record?.retry?.message).toBe("connection_outside_uninstall_scope");
  });

  it("denies release activation while exact-major teardown is pending", async () => {
    const journal = new MemoryJournal();
    await journal.begin(TARGET, NOW.toISOString());

    await expect(getOimUninstallStatus(journal, TARGET)).resolves.toEqual({
      scope: TARGET,
      status: "pending",
      activationAllowed: false,
      retryRequired: false,
    });
  });

  it("serializes concurrent retries for the same exact-major teardown", async () => {
    const journal = new MemoryJournal();
    const fenceAndDrain = vi.fn(async () => ({
      toolDispatchFenced: true as const,
      ingressFenced: true as const,
      inFlightWorkDrained: true as const,
      inFlightWorkIds: [],
    }));
    const host = {
      fenceAndDrain,
      unsubscribeRemote: vi.fn(async () => ({ remoteCleanupComplete: true })),
      listConnections: vi.fn(async () => []),
      revokeConnection: vi.fn(async () => {}),
      removePackageOwnedState: vi.fn(async () => {}),
      removeReleaseProvenance: vi.fn(async () => {}),
      removeSoulPackage: vi.fn(async () => {}),
    };

    await Promise.all([
      uninstallOimRelease({ journal, host, now: () => NOW }, TARGET),
      uninstallOimRelease({ journal, host, now: () => NOW }, TARGET),
    ]);

    expect(fenceAndDrain).toHaveBeenCalledOnce();
    expect(host.unsubscribeRemote).toHaveBeenCalledOnce();
    expect(host.removeSoulPackage).toHaveBeenCalledOnce();
  });

  it("starts fresh teardown after the same major is reinstalled", async () => {
    const journal = new MemoryJournal();
    const fenceAndDrain = vi.fn(async () => ({
      toolDispatchFenced: true as const,
      ingressFenced: true as const,
      inFlightWorkDrained: true as const,
      inFlightWorkIds: [],
    }));
    const host = {
      fenceAndDrain,
      unsubscribeRemote: vi.fn(async () => ({ remoteCleanupComplete: true })),
      listConnections: vi.fn(async () => []),
      revokeConnection: vi.fn(async () => {}),
      removePackageOwnedState: vi.fn(async () => {}),
      removeReleaseProvenance: vi.fn(async () => {}),
      removeSoulPackage: vi.fn(async () => {}),
    };

    await uninstallOimRelease({ journal, host, now: () => NOW }, TARGET);
    await uninstallOimRelease(
      { journal, host, now: () => NOW },
      { ...TARGET, installationId: "installed-2026-09-13T11:00:00.000Z" }
    );

    expect(fenceAndDrain).toHaveBeenCalledTimes(2);
    expect(host.removeSoulPackage).toHaveBeenCalledTimes(2);
  });

  it("replays completed generation A after generation B is installed", async () => {
    const journal = new MemoryJournal();
    await journal.begin(TARGET, NOW.toISOString());
    if (journal.record === null) throw new Error("missing uninstall fixture");
    journal.record = {
      ...journal.record,
      status: "complete",
      completedAt: NOW.toISOString(),
    };
    const findTarget = vi.fn(async () => ({
      ...TARGET,
      installationId: "installed-2026-09-13T11:00:00.000Z",
      packageDigest: "b".repeat(64),
      soulRevision: "soul-new",
    }));

    await expect(
      uninstallOimReleaseGeneration(
        {
          journal,
          findTarget,
          host: {
            fenceAndDrain: vi.fn(),
            unsubscribeRemote: vi.fn(),
            listConnections: vi.fn(),
            revokeConnection: vi.fn(),
            removePackageOwnedState: vi.fn(),
            removeReleaseProvenance: vi.fn(),
            removeSoulPackage: vi.fn(),
          },
        },
        {
          ...SCOPE,
          installationId: TARGET.installationId,
        }
      )
    ).resolves.toEqual({ scope: journal.record, status: "complete" });
    expect(findTarget).not.toHaveBeenCalled();
  });
});
