import { generateKeyPairSync } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  createEd25519OimReleaseSigner,
  createOimReleaseInstallOperationHost,
  createOimReleaseTrustService,
  installReviewedCommunityOimRelease,
  signOimRevocationList,
  uninstallOimRelease,
} from "@tulipfarm/integrations";
import { type OimManifest, oimFileDigest, oimPackageDigest } from "@tulipfarm/schema";
import {
  ConnectionStore,
  createOimReleaseStorage,
  OIM_RELEASE_LIFECYCLE_STORAGE_STATEMENTS,
  OimReleaseLifecycleStore,
  type OimReleaseSession,
  type OimReleaseSessionSource,
  OimReleaseTrustStore,
  OimReleaseUninstallJournalStore,
  type QueryResult,
  transactionPort,
} from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMigratedPglite } from "../../test/pglite";
import { createOimReleaseConnectionTeardown } from "./connection-teardown";

const SCOPE = {
  businessId: "business-1",
  integrationId: "calendar",
  majorVersion: 2,
} as const;
const INSTALL_SCOPE = { ...SCOPE, slug: "calendar-v2" } as const;

function reviewedCommunityPackage() {
  const guide = "# Setup\n";
  const manifest: OimManifest = {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.2.3",
      description: "Read current weather.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    files: [
      {
        path: "setup-guide.md",
        role: "guide",
        sha256: oimFileDigest(guide),
      },
    ],
    operations: [
      {
        id: "current-weather",
        name: "current_weather",
        description: "Read current weather.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/v1/current",
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
  };
  return { manifest, files: new Map([["setup-guide.md", guide]]) };
}

function officialProvenance(version = "2.1.0", packageDigest = "a".repeat(64)) {
  return {
    ...SCOPE,
    version,
    packageDigest,
    source: {
      kind: "git" as const,
      repository: "https://catalog.example/calendar",
      ref: `commit-${version}`,
      path: "packages/calendar",
    },
    slug: "calendar-v2",
    soulRevision: `soul-${version}`,
    trustClass: "official" as const,
    signedRelease: {
      envelopeVersion: 1,
      release: {
        integrationId: "calendar",
        version,
        packageDigest,
      },
      signature: {
        algorithm: "Ed25519",
        keyId: "release-2026",
        value: "signature",
      },
    },
    originalRequirements: { metadata: { id: "calendar", version } },
    autoPatchOptIn: true,
  };
}

function uninstallTarget(installed: {
  installationId: string;
  slug: string;
  packageDigest: string;
  soulRevision: string;
}) {
  return {
    ...SCOPE,
    installationId: installed.installationId,
    slug: installed.slug,
    packageDigest: installed.packageDigest,
    soulRevision: installed.soulRevision,
  };
}

class DistinctSessionSource implements OimReleaseSessionSource {
  private lockTail = Promise.resolve();
  lockAttempts = 0;

  constructor(private readonly database: PGlite) {}

  async query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<Row>> {
    return (await this.database.query(
      text,
      params === undefined ? undefined : [...params]
    )) as QueryResult<Row>;
  }

  async connect(): Promise<OimReleaseSession> {
    let releaseLock: (() => void) | undefined;
    return {
      query: async <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
        if (text.includes("pg_advisory_lock")) {
          this.lockAttempts += 1;
          const predecessor = this.lockTail;
          this.lockTail = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
          await predecessor;
          return this.query<Row>(text, params);
        }
        if (text.includes("pg_advisory_unlock")) {
          const result = await this.query<Row>(text, params);
          releaseLock?.();
          releaseLock = undefined;
          return result;
        }
        return this.query<Row>(text, params);
      },
      release() {
        releaseLock?.();
      },
    };
  }
}

describe("OIM release lifecycle PostgreSQL storage", () => {
  let database: PGlite;
  let trust: OimReleaseTrustStore;
  let sessions: DistinctSessionSource;
  let lifecycle: OimReleaseLifecycleStore;
  let journal: OimReleaseUninstallJournalStore;
  let dispatchLeases: ReturnType<typeof createOimReleaseStorage>["dispatchLeases"];

  beforeEach(async () => {
    database = await makeMigratedPglite();
    for (const statement of OIM_RELEASE_LIFECYCLE_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    sessions = new DistinctSessionSource(database);
    const stores = createOimReleaseStorage(sessions);
    trust = stores.trust;
    lifecycle = stores.lifecycle;
    journal = stores.uninstallJournal;
    dispatchLeases = stores.dispatchLeases;
  });

  afterEach(async () => {
    await database.close();
  });

  it("retries a reviewed draft after the first durable operation response is lost", async () => {
    const package_ = reviewedCommunityPackage();
    const packageDigest = oimPackageDigest(package_.manifest);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const revocationKey = {
      keyId: "revocations-2026",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    };
    const revocations = signOimRevocationList(
      {
        sequence: 1,
        issuedAt: "2026-09-13T00:00:00.000Z",
        expiresAt: "2026-09-15T00:00:00.000Z",
        revocations: [],
      },
      createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
    );
    const trustService = createOimReleaseTrustService({
      trustedReleaseKeys: [],
      trustedRevocationKeys: [
        { keyId: revocationKey.keyId, publicKeyPem: revocationKey.publicKeyPem },
      ],
      revocationStore: {
        async load() {
          return revocations;
        },
        async compareAndSwap() {
          return false;
        },
      },
      knownSignedReleaseStore: {
        async isKnownSignedRelease() {
          return false;
        },
        async recordKnownSignedRelease() {},
      },
      now: () => new Date("2026-09-14T00:00:00.000Z"),
    });
    const stores = createOimReleaseStorage(sessions);
    const operationHost = createOimReleaseInstallOperationHost(stores.operations);
    let loseFirstResponse = true;
    const claim = vi.fn(async () => ({
      slug: "weather-v1",
      package: package_,
      source: {
        kind: "authored_draft" as const,
        reviewId: "review-1",
        reviewedAt: "2026-09-13T08:00:00.000Z",
        reviewedBy: {
          businessId: "business-1",
          principal: { kind: "user", id: "user-1" },
        },
        runId: "run-1",
        toolCallId: "call-1",
      },
      replacementIssues: [],
    }));
    const acknowledge = vi.fn(async ({ operationId }: { readonly operationId: string }) => {
      await expect(stores.operations.get(operationId)).resolves.toMatchObject({
        packageSnapshot: {
          integrationId: "weather",
          packageDigest,
          files: [expect.objectContaining({ path: "setup-guide.md" })],
        },
      });
    });
    const packageWriter = {
      async prepare(input: unknown) {
        return input;
      },
      async apply() {
        return { revision: "soul-1", rollbackToken: "rollback-1" };
      },
      async install() {
        return { revision: "soul-1", rollbackToken: "rollback-1" };
      },
      async rollback() {
        return { revision: "rollback-1" };
      },
    };
    const provenance = {
      async recordInstalledProvenance() {},
      async recordRestoredSoulRevision() {},
    };
    const input = {
      businessId: "business-1",
      slug: "weather-v1",
      approvedPackageDigest: packageDigest,
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
      replace: false,
    };

    await expect(
      installReviewedCommunityOimRelease(input, {
        trust: trustService,
        packageWriter,
        provenance,
        reviewedDrafts: { claim, acknowledge },
        operations: {
          ...operationHost,
          async beginAuthorized(beginInput) {
            const operation = await operationHost.beginAuthorized(beginInput);
            if (loseFirstResponse) {
              loseFirstResponse = false;
              throw new Error("operation response lost");
            }
            return operation;
          },
        },
      })
    ).rejects.toThrow("operation response lost");
    await expect(stores.operations.listPending()).resolves.toHaveLength(1);
    expect(acknowledge).not.toHaveBeenCalled();

    const restarted = createOimReleaseStorage(sessions);
    await expect(
      installReviewedCommunityOimRelease(input, {
        trust: trustService,
        packageWriter,
        provenance,
        reviewedDrafts: { claim, acknowledge },
        operations: createOimReleaseInstallOperationHost(restarted.operations),
      })
    ).resolves.toMatchObject({
      integrationId: "weather",
      packageDigest,
      trustClass: "community",
    });
    expect(claim).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    await expect(restarted.operations.listPending()).resolves.toHaveLength(0);
  });

  it("persists partial uninstall progress across service restart without assuming cleanup", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const installed = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (installed === null) throw new Error("missing fixture provenance");
    const target = uninstallTarget(installed);

    await journal.begin(target, "2026-09-13T09:00:00.000Z");
    await journal.markStepCompleted(
      target,
      "traffic_fenced_and_drained",
      "2026-09-13T09:01:00.000Z",
      ["run-1"]
    );
    await journal.markRetryRequired(target, {
      step: "remote_unsubscribed",
      message: "provider unavailable",
      failedAt: "2026-09-13T09:02:00.000Z",
    });

    const restarted = new OimReleaseUninstallJournalStore(
      transactionPort(database),
      new OimReleaseLifecycleStore(sessions, transactionPort(database))
    );
    await expect(restarted.get(target)).resolves.toMatchObject({
      ...target,
      status: "pending",
      completedSteps: ["traffic_fenced_and_drained"],
      inFlightWorkIds: ["run-1"],
      retry: {
        step: "remote_unsubscribed",
        message: "provider unavailable",
      },
    });
    await expect(restarted.markCompleted(target, "2026-09-13T09:03:00.000Z")).rejects.toThrow(
      "oim_uninstall_cleanup_incomplete"
    );
  });

  it("resumes the real uninstall service after failure and keeps old Connections revoked on reinstall", async () => {
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    await connections.put(SCOPE.businessId, {
      id: "connection-old",
      integration: { id: SCOPE.integrationId, majorVersion: SCOPE.majorVersion },
      label: "Old calendar account",
      owner: { scope: "organization" },
      status: "active",
      isDefault: false,
      configuration: {},
      agentVisibleConfiguration: [],
      secretBindings: { access: "secret://connection-old-access" },
      health: { status: "unknown", checkedAt: null },
      expiresAt: null,
    });
    await trust.putInstalledProvenance(officialProvenance());
    const installed = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (installed === null) throw new Error("missing fixture provenance");
    const target = uninstallTarget(installed);
    const revokedSecrets: string[] = [];
    const connectionTeardown = createOimReleaseConnectionTeardown({
      connections,
      credentials: {
        async revokeConnection(_connectionId, bindings, persist) {
          await persist();
          revokedSecrets.push(...Object.values(bindings));
        },
      },
    });
    const hostBase = {
      fenceAndDrain: async () => ({
        toolDispatchFenced: true as const,
        ingressFenced: true as const,
        inFlightWorkDrained: true as const,
        inFlightWorkIds: ["run-1"],
      }),
      listConnections: connectionTeardown.listConnections,
      revokeConnection: connectionTeardown.revokeConnection,
      removePackageOwnedState: async () => {},
      removeReleaseProvenance: (scope: typeof target) =>
        trust.removeInstalledProvenance(scope).then(() => undefined),
      removeSoulPackage: async () => {},
    };

    await expect(
      uninstallOimRelease(
        {
          journal,
          host: {
            ...hostBase,
            unsubscribeRemote: async () => ({ remoteCleanupComplete: false }),
          },
          now: () => new Date("2026-09-13T09:00:00.000Z"),
        },
        target
      )
    ).rejects.toMatchObject({ step: "remote_unsubscribed" });
    await expect(connections.findById(SCOPE.businessId, "connection-old")).resolves.toMatchObject({
      status: "active",
    });

    const restartedJournal = new OimReleaseUninstallJournalStore(
      transactionPort(database),
      new OimReleaseLifecycleStore(sessions, transactionPort(database))
    );
    await expect(
      uninstallOimRelease(
        {
          journal: restartedJournal,
          host: {
            ...hostBase,
            unsubscribeRemote: async () => ({ remoteCleanupComplete: true }),
          },
          now: () => new Date("2026-09-13T10:00:00.000Z"),
        },
        target
      )
    ).resolves.toEqual({ scope: target, status: "complete" });
    await expect(connections.findById(SCOPE.businessId, "connection-old")).resolves.toMatchObject({
      status: "revoked",
      secretBindings: {},
    });
    expect(revokedSecrets).toEqual(["secret://connection-old-access"]);

    await trust.putInstalledProvenance({
      ...officialProvenance("2.2.0", "b".repeat(64)),
      slug: "calendar-reinstalled-v2",
      soulRevision: "soul-reinstalled",
    });
    const reinstalled = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    expect(reinstalled?.installationId).not.toBe(target.installationId);
    await expect(connections.findById(SCOPE.businessId, "connection-old")).resolves.toMatchObject({
      status: "revoked",
      secretBindings: {},
    });
  });

  it("serializes the same exact-major lifecycle across independent service instances", async () => {
    const first = new OimReleaseLifecycleStore(sessions, transactionPort(database));
    const second = new OimReleaseLifecycleStore(sessions, transactionPort(database));
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstOperation = first.runInstallExclusive(INSTALL_SCOPE, async () => {
      order.push("first-start");
      await firstPaused;
      order.push("first-end");
    });
    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    const secondOperation = second.runInstallExclusive(INSTALL_SCOPE, async () => {
      order.push("second");
    });
    await vi.waitFor(() => expect(sessions.lockAttempts).toBe(2));
    expect(order).toEqual(["first-start"]);

    releaseFirst?.();
    await Promise.all([firstOperation, secondOperation]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("keeps concurrent first-install retries on one installation generation", async () => {
    const first = new OimReleaseLifecycleStore(sessions, transactionPort(database));
    const second = new OimReleaseLifecycleStore(sessions, transactionPort(database));
    const replica = new OimReleaseTrustStore(transactionPort(database));
    const input = officialProvenance();

    await expect(
      Promise.all([
        first.runInstallExclusive(INSTALL_SCOPE, () => trust.putInstalledProvenance(input)),
        second.runInstallExclusive(INSTALL_SCOPE, () => replica.putInstalledProvenance(input)),
      ])
    ).resolves.toEqual([undefined, undefined]);
    const stored = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    expect(stored).toMatchObject({
      version: input.version,
      packageDigest: input.packageDigest,
      slug: input.slug,
      source: input.source,
      soulRevision: input.soulRevision,
      installationId: expect.any(String),
    });
    const rows = await database.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM oim_installed_release_provenance
        WHERE business_id = $1 AND integration_id = $2 AND major_version = $3`,
      [SCOPE.businessId, SCOPE.integrationId, SCOPE.majorVersion]
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("lets concurrent uninstall callers consume one durable operation", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const installed = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (installed === null) throw new Error("missing fixture provenance");
    const target = uninstallTarget(installed);
    const remoteCleanup = vi.fn(async () => ({ remoteCleanupComplete: true }));
    const host = {
      fenceAndDrain: vi.fn(async () => ({
        toolDispatchFenced: true as const,
        ingressFenced: true as const,
        inFlightWorkDrained: true as const,
        inFlightWorkIds: [],
      })),
      unsubscribeRemote: remoteCleanup,
      listConnections: async () => [],
      revokeConnection: async () => {},
      removePackageOwnedState: vi.fn(async () => {}),
      removeReleaseProvenance: (scope: typeof target) =>
        trust.removeInstalledProvenance(scope).then(() => undefined),
      removeSoulPackage: vi.fn(async () => {}),
    };
    const otherJournal = new OimReleaseUninstallJournalStore(
      transactionPort(database),
      new OimReleaseLifecycleStore(sessions, transactionPort(database))
    );

    await expect(
      Promise.all([
        uninstallOimRelease({ journal, host }, target),
        uninstallOimRelease({ journal: otherJournal, host }, target),
      ])
    ).resolves.toEqual([
      { scope: target, status: "complete" },
      { scope: target, status: "complete" },
    ]);
    expect(host.fenceAndDrain).toHaveBeenCalledOnce();
    expect(remoteCleanup).toHaveBeenCalledOnce();
    expect(host.removePackageOwnedState).toHaveBeenCalledOnce();
    expect(host.removeSoulPackage).toHaveBeenCalledOnce();
  });

  it("fences install and patch metadata while uninstall is pending", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const installed = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (installed === null) throw new Error("missing fixture provenance");
    const target = uninstallTarget(installed);
    await journal.begin(target, "2026-09-13T09:00:00.000Z");

    await expect(
      lifecycle.runInstallExclusive(INSTALL_SCOPE, async () => "installed")
    ).rejects.toThrow("oim_uninstall_pending");
    await expect(lifecycle.runPatchExclusive(INSTALL_SCOPE, async () => "patched")).rejects.toThrow(
      "oim_uninstall_pending"
    );
    await expect(
      trust.putInstalledProvenance(officialProvenance("2.1.1", "b".repeat(64)))
    ).rejects.toThrow("oim_uninstall_pending");
    await expect(
      trust.setInstalledAutoPatchPreference(
        SCOPE.businessId,
        SCOPE.integrationId,
        SCOPE.majorVersion,
        false
      )
    ).rejects.toThrow("oim_uninstall_pending");
  });

  it("deletes exact-generation provenance only after durable mandatory cleanup", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const installed = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (installed === null) throw new Error("missing fixture provenance");
    const target = uninstallTarget(installed);
    await journal.begin(target, "2026-09-13T09:00:00.000Z");

    await expect(trust.removeInstalledProvenance(target)).rejects.toThrow(
      "oim_uninstall_cleanup_incomplete"
    );
    for (const step of [
      "traffic_fenced_and_drained",
      "remote_unsubscribed",
      "connections_revoked",
      "owned_state_removed",
    ] as const) {
      await journal.markStepCompleted(target, step, "2026-09-13T09:01:00.000Z");
    }

    await expect(trust.removeInstalledProvenance(target)).resolves.toBe(true);
    await expect(trust.removeInstalledProvenance(target)).resolves.toBe(false);
    await expect(
      trust.findInstalledProvenance(SCOPE.businessId, SCOPE.integrationId, SCOPE.majorVersion)
    ).resolves.toBeNull();
    await expect(journal.get(target)).resolves.toMatchObject({
      completedSteps: expect.arrayContaining(["release_provenance_removed"]),
    });
  });

  it("creates a new generation after complete uninstall and rejects late old writers", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const first = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (first === null) throw new Error("missing fixture provenance");
    const firstTarget = uninstallTarget(first);
    await journal.begin(firstTarget, "2026-09-13T09:00:00.000Z");
    for (const step of [
      "traffic_fenced_and_drained",
      "remote_unsubscribed",
      "connections_revoked",
      "owned_state_removed",
    ] as const) {
      await journal.markStepCompleted(firstTarget, step, "2026-09-13T09:01:00.000Z");
    }
    await trust.removeInstalledProvenance(firstTarget);
    await journal.markStepCompleted(
      firstTarget,
      "release_provenance_removed",
      "2026-09-13T09:02:00.000Z"
    );
    await journal.markStepCompleted(
      firstTarget,
      "soul_package_removed",
      "2026-09-13T09:03:00.000Z"
    );
    await journal.markCompleted(firstTarget, "2026-09-13T09:04:00.000Z");

    await trust.putInstalledProvenance({
      ...officialProvenance("2.2.0", "b".repeat(64)),
      slug: "calendar-reinstalled-v2",
      soulRevision: "soul-reinstalled",
    });
    const second = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    expect(second?.installationId).not.toBe(first.installationId);
    expect(second?.slug).toBe("calendar-reinstalled-v2");
    await expect(journal.get(firstTarget)).resolves.toMatchObject({
      installationId: first.installationId,
      status: "complete",
    });
    await expect(
      journal.markRetryRequired(firstTarget, {
        step: "operation_completed",
        message: "late old process",
        failedAt: "2026-09-13T09:05:00.000Z",
      })
    ).rejects.toThrow("oim_uninstall_generation_mismatch");

    const secondTarget = {
      ...SCOPE,
      installationId: second?.installationId ?? "",
      slug: second?.slug ?? "",
      packageDigest: second?.packageDigest ?? "",
      soulRevision: second?.soulRevision ?? "",
    };
    await expect(journal.begin(secondTarget, "2026-09-13T10:00:00.000Z")).resolves.toMatchObject({
      ...secondTarget,
      status: "pending",
      completedSteps: [],
    });
  });

  it("retains the slug after Soul removal until uninstall completion is durable", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const installed = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (installed === null) throw new Error("missing fixture provenance");
    const target = uninstallTarget(installed);
    await journal.begin(target, "2026-09-13T09:00:00.000Z");
    for (const step of [
      "traffic_fenced_and_drained",
      "remote_unsubscribed",
      "connections_revoked",
      "owned_state_removed",
    ] as const) {
      await journal.markStepCompleted(target, step, "2026-09-13T09:01:00.000Z");
    }
    await trust.removeInstalledProvenance(target);
    await journal.markStepCompleted(target, "soul_package_removed", "2026-09-13T09:02:00.000Z");

    const replacement = {
      ...officialProvenance("3.0.0", "b".repeat(64)),
      integrationId: "calendar-next",
      majorVersion: 3,
      slug: target.slug,
    };
    await expect(trust.putInstalledProvenance(replacement)).rejects.toThrow(
      "oim_release_location_conflict"
    );

    await journal.markCompleted(target, "2026-09-13T09:03:00.000Z");
    await expect(trust.putInstalledProvenance(replacement)).resolves.toBeUndefined();
  });

  it("atomically preserves patch preference and rejects stale provenance writers", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const first = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (first === null) throw new Error("missing fixture provenance");

    await trust.setInstalledAutoPatchPreference(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion,
      false
    );
    await expect(
      trust.compareAndSwapInstalledProvenance({
        expected: first,
        next: officialProvenance("2.1.1", "b".repeat(64)),
      })
    ).resolves.toEqual({ status: "skipped", reason: "auto_patch_disabled" });

    await trust.setInstalledAutoPatchPreference(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion,
      true
    );
    await expect(
      trust.compareAndSwapInstalledProvenance({
        expected: first,
        next: officialProvenance("2.1.1", "b".repeat(64)),
      })
    ).resolves.toEqual({ status: "skipped", reason: "installed_release_changed" });
    const current = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (current === null) throw new Error("missing fixture provenance");
    const updated = await trust.compareAndSwapInstalledProvenance({
      expected: current,
      next: officialProvenance("2.1.1", "b".repeat(64)),
    });
    expect(updated).toMatchObject({
      status: "updated",
      provenance: {
        installationId: current.installationId,
        slug: current.slug,
        version: "2.1.1",
        packageDigest: "b".repeat(64),
        source: {
          kind: "git",
          repository: "https://catalog.example/calendar",
          ref: "commit-2.1.1",
          path: "packages/calendar",
        },
        soulRevision: "soul-2.1.1",
        autoPatchOptIn: true,
        originalRequirements: current.originalRequirements,
      },
    });
    await expect(
      trust.compareAndSwapInstalledProvenance({
        expected: current,
        next: officialProvenance("2.1.2", "c".repeat(64)),
      })
    ).resolves.toEqual({ status: "skipped", reason: "installed_release_changed" });
  });

  it("fails closed when uninstall begins without current installation evidence", async () => {
    await expect(
      journal.begin(
        {
          ...SCOPE,
          installationId: "00000000-0000-4000-8000-000000000001",
          slug: "calendar-v2",
          packageDigest: "a".repeat(64),
          soulRevision: "soul-2.1.0",
        },
        "2026-09-13T09:00:00.000Z"
      )
    ).rejects.toThrow("oim_release_installation_missing");
    await expect(
      journal.get({
        ...SCOPE,
        installationId: "00000000-0000-4000-8000-000000000001",
      })
    ).resolves.toBeNull();
  });

  it("rejects an uninstall generation that names the wrong physical slug", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const installed = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (installed === null) throw new Error("missing fixture provenance");

    await expect(
      journal.begin(
        { ...uninstallTarget(installed), slug: "calendar-copy-v2" },
        "2026-09-13T09:00:00.000Z"
      )
    ).rejects.toThrow("oim_uninstall_generation_mismatch");
  });

  it("rejects uninstall evidence from another package revision", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const installed = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (installed === null) throw new Error("missing fixture provenance");

    await expect(
      journal.begin(
        { ...uninstallTarget(installed), packageDigest: "b".repeat(64) },
        "2026-09-13T09:00:00.000Z"
      )
    ).rejects.toThrow("oim_release_installation_missing");
    await expect(
      journal.begin(
        { ...uninstallTarget(installed), soulRevision: "soul-other" },
        "2026-09-13T09:00:00.000Z"
      )
    ).rejects.toThrow("oim_release_installation_missing");
  });

  it("atomically binds one slug to one installed identity", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const operation = vi.fn(async () => {});

    await expect(
      lifecycle.runInstallExclusive({ ...SCOPE, slug: "calendar-copy-v2" }, operation)
    ).rejects.toThrow("oim_release_location_conflict");
    expect(operation).not.toHaveBeenCalled();

    await expect(
      trust.putInstalledProvenance({
        ...officialProvenance("1.0.0", "b".repeat(64)),
        integrationId: "weather",
        majorVersion: 1,
      })
    ).rejects.toThrow();

    await expect(
      trust.putInstalledProvenance({
        ...officialProvenance(),
        slug: "calendar-copy-v2",
      })
    ).rejects.toThrow("oim_release_already_installed");

    await expect(
      trust.putInstalledProvenance({
        ...officialProvenance("3.0.0", "c".repeat(64)),
        majorVersion: 3,
        slug: "calendar-v3",
      })
    ).resolves.toBeUndefined();
  });

  it("allows only one concurrent identity to claim an unused slug", async () => {
    const replica = new OimReleaseTrustStore(transactionPort(database));
    const calendar = { ...officialProvenance(), slug: "shared" };
    const weather = {
      ...officialProvenance("1.0.0", "b".repeat(64)),
      integrationId: "weather",
      majorVersion: 1,
      slug: "shared",
      source: {
        kind: "git" as const,
        repository: "https://catalog.example/calendar",
        ref: "commit-1.0.0",
        path: "packages/weather",
      },
      originalRequirements: { metadata: { id: "weather", version: "1.0.0" } },
    };

    const results = await Promise.allSettled([
      trust.putInstalledProvenance(calendar),
      replica.putInstalledProvenance(weather),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rows = await database.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM oim_installed_release_provenance WHERE slug = 'shared'"
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("requires reconciliation for expired dispatch leases and denies new leases after fencing", async () => {
    await trust.putInstalledProvenance(officialProvenance());
    const installed = await trust.findInstalledGeneration(
      SCOPE.businessId,
      SCOPE.integrationId,
      SCOPE.majorVersion
    );
    if (installed === null) throw new Error("missing fixture provenance");
    const lease = await dispatchLeases.acquire({
      ...SCOPE,
      packageDigest: installed.packageDigest,
      acquiredAt: "2026-09-13T09:00:00.000Z",
      leaseDurationMs: 1_000,
    });
    const restartedDispatchLeases = createOimReleaseStorage(sessions).dispatchLeases;

    const target = uninstallTarget(installed);
    await journal.begin(target, "2026-09-13T09:00:01.000Z");
    await expect(
      dispatchLeases.acquire({
        ...SCOPE,
        packageDigest: installed.packageDigest,
        acquiredAt: "2026-09-13T09:00:02.000Z",
      })
    ).rejects.toThrow("oim_uninstall_pending");
    await expect(
      restartedDispatchLeases.listUnresolved(SCOPE, "2026-09-13T09:00:02.000Z")
    ).resolves.toEqual([
      expect.objectContaining({
        leaseId: lease.leaseId,
        status: "reconciliation_required",
        reconciliationReason: "lease_expired_without_dispatch_outcome",
      }),
    ]);
    await expect(dispatchLeases.complete(lease.leaseId)).rejects.toThrow(
      "oim_release_dispatch_lease_not_active"
    );
    await restartedDispatchLeases.reconcile(lease.leaseId, "completed", "2026-09-13T09:00:03.000Z");
    await expect(dispatchLeases.listUnresolved(SCOPE, "2026-09-13T09:00:04.000Z")).resolves.toEqual(
      []
    );
  });
});
