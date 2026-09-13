export interface OimUninstallScope {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
}

export interface OimUninstallTarget extends OimUninstallScope {
  readonly installationId: string;
  readonly slug: string;
  readonly packageDigest: string;
  readonly soulRevision: string;
}

export interface OimUninstallGeneration extends OimUninstallScope {
  readonly installationId: string;
}

export type OimUninstallStep =
  | "traffic_fenced_and_drained"
  | "remote_unsubscribed"
  | "connections_revoked"
  | "owned_state_removed"
  | "release_provenance_removed"
  | "soul_package_removed";

export type OimUninstallStage = OimUninstallStep | "operation_completed";

export interface OimUninstallRetry {
  readonly step: OimUninstallStage;
  readonly message: string;
  readonly failedAt: string;
}

export interface OimUninstallJournal extends OimUninstallTarget {
  readonly status: "pending" | "complete";
  readonly completedSteps: readonly OimUninstallStep[];
  readonly revokedConnectionIds: readonly string[];
  readonly inFlightWorkIds: readonly string[];
  readonly retry: OimUninstallRetry | null;
  readonly startedAt: string;
  readonly updatedAt?: string;
  readonly completedAt: string | null;
}

/**
 * Durable exact-major journal. `begin` atomically creates pending work or returns its latest state.
 * Every mutation must be durable before its promise resolves.
 */
export interface OimUninstallJournalPort {
  /**
   * Serializes this exact-major operation across all API and Worker processes. Implementations
   * must use a database-backed advisory lock or renewable lease, never a process-local mutex.
   */
  runExclusive<T>(scope: OimUninstallScope, operation: () => Promise<T>): Promise<T>;
  /**
   * Creates a pending operation for this installation generation. A different generation may
   * replace only a completed journal after the install lifecycle registered it as current; stale
   * generations and every attempt to overtake pending teardown must fail closed.
   */
  begin(target: OimUninstallTarget, startedAt: string): Promise<OimUninstallJournal>;
  get(generation: OimUninstallGeneration): Promise<OimUninstallJournal | null>;
  markStepCompleted(
    target: OimUninstallTarget,
    step: OimUninstallStep,
    completedAt: string,
    inFlightWorkIds?: readonly string[]
  ): Promise<void>;
  markConnectionRevoked(
    target: OimUninstallTarget,
    connectionId: string,
    updatedAt: string
  ): Promise<void>;
  markRetryRequired(target: OimUninstallTarget, retry: OimUninstallRetry): Promise<void>;
  markCompleted(target: OimUninstallTarget, completedAt: string): Promise<void>;
}

export interface OimUninstallConnection extends OimUninstallTarget {
  readonly connectionId: string;
}

/**
 * Mandatory host teardown boundary. Every operation is exact-scope and retry-safe.
 * `removePackageOwnedState` includes all registrations, subscriptions, Routines, Knowledge, and
 * other state owned by the installed package.
 */
export interface OimUninstallHost {
  fenceAndDrain(target: OimUninstallTarget): Promise<{
    readonly toolDispatchFenced: true;
    readonly ingressFenced: true;
    readonly inFlightWorkDrained: true;
    readonly inFlightWorkIds: readonly string[];
  }>;
  unsubscribeRemote(
    target: OimUninstallTarget
  ): Promise<{ readonly remoteCleanupComplete: boolean }>;
  listConnections(target: OimUninstallTarget): Promise<readonly OimUninstallConnection[]>;
  revokeConnection(connection: OimUninstallConnection): Promise<void>;
  removePackageOwnedState(target: OimUninstallTarget): Promise<void>;
  removeReleaseProvenance(target: OimUninstallTarget): Promise<void>;
  removeSoulPackage(target: OimUninstallTarget): Promise<void>;
}

export interface UninstallOimReleaseDeps {
  readonly journal: OimUninstallJournalPort;
  readonly host: OimUninstallHost;
  readonly now?: () => Date;
}

export interface UninstallOimReleaseGenerationDeps extends UninstallOimReleaseDeps {
  readonly findTarget: (generation: OimUninstallGeneration) => Promise<OimUninstallTarget | null>;
}

export interface OimUninstallResult {
  readonly scope: OimUninstallTarget;
  readonly status: "complete";
}

export interface OimUninstallStatus {
  readonly scope: OimUninstallGeneration;
  readonly status: "not_started" | "pending" | "complete";
  readonly activationAllowed: boolean;
  readonly retryRequired: boolean;
}

export class OimUninstallError extends Error {
  readonly code = "OIM_UNINSTALL_STEP_FAILED";

  constructor(
    readonly scope: OimUninstallScope,
    readonly step: OimUninstallStage,
    readonly cause: unknown
  ) {
    super(`OIM uninstall failed during ${step}`);
    this.name = "OimUninstallError";
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown uninstall failure";
}

function isSameScope(left: OimUninstallScope, right: OimUninstallScope): boolean {
  return (
    left.businessId === right.businessId &&
    left.integrationId === right.integrationId &&
    left.majorVersion === right.majorVersion
  );
}

function isSameTarget(left: OimUninstallTarget, right: OimUninstallTarget): boolean {
  return (
    isSameScope(left, right) &&
    left.installationId === right.installationId &&
    left.slug === right.slug &&
    left.packageDigest === right.packageDigest &&
    left.soulRevision === right.soulRevision
  );
}

export async function getOimUninstallStatus(
  journal: Pick<OimUninstallJournalPort, "get">,
  scope: OimUninstallGeneration
): Promise<OimUninstallStatus> {
  const record = await journal.get(scope);
  if (record === null) {
    return {
      scope,
      status: "not_started",
      activationAllowed: true,
      retryRequired: false,
    };
  }
  if (!isSameScope(record, scope)) throw new Error("uninstall_journal_scope_mismatch");
  return {
    scope,
    status: record.status,
    activationAllowed: record.status === "complete",
    retryRequired: record.retry !== null,
  };
}

async function runStage(
  deps: UninstallOimReleaseDeps,
  scope: OimUninstallTarget,
  stage: OimUninstallStage,
  operation: () => Promise<void>
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const failedAt = (deps.now ?? (() => new Date()))().toISOString();
    await deps.journal.markRetryRequired(scope, {
      step: stage,
      message: failureMessage(error),
      failedAt,
    });
    throw new OimUninstallError(scope, stage, error);
  }
}

async function runUninstall(
  deps: UninstallOimReleaseDeps,
  scope: OimUninstallTarget
): Promise<OimUninstallResult> {
  const now = deps.now ?? (() => new Date());
  const journal = await deps.journal.begin(scope, now().toISOString());
  if (!isSameTarget(journal, scope)) throw new Error("uninstall_journal_target_mismatch");
  if (journal.status === "complete") return { scope, status: "complete" };
  const completed = new Set(journal.completedSteps);
  const revokedConnectionIds = new Set(journal.revokedConnectionIds);

  if (!completed.has("traffic_fenced_and_drained")) {
    await runStage(deps, scope, "traffic_fenced_and_drained", async () => {
      const fence = await deps.host.fenceAndDrain(scope);
      if (
        fence.toolDispatchFenced !== true ||
        fence.ingressFenced !== true ||
        fence.inFlightWorkDrained !== true
      ) {
        throw new Error("uninstall_traffic_fence_incomplete");
      }
      await deps.journal.markStepCompleted(
        scope,
        "traffic_fenced_and_drained",
        now().toISOString(),
        fence.inFlightWorkIds
      );
    });
    completed.add("traffic_fenced_and_drained");
  }

  if (!completed.has("remote_unsubscribed")) {
    await runStage(deps, scope, "remote_unsubscribed", async () => {
      const remote = await deps.host.unsubscribeRemote(scope);
      if (!remote.remoteCleanupComplete) throw new Error("remote_cleanup_incomplete");
      await deps.journal.markStepCompleted(scope, "remote_unsubscribed", now().toISOString());
    });
    completed.add("remote_unsubscribed");
  }

  if (!completed.has("connections_revoked")) {
    await runStage(deps, scope, "connections_revoked", async () => {
      const connections = await deps.host.listConnections(scope);
      if (connections.some((connection) => !isSameScope(connection, scope))) {
        throw new Error("connection_outside_uninstall_scope");
      }
      for (const connection of connections) {
        if (revokedConnectionIds.has(connection.connectionId)) continue;
        await deps.host.revokeConnection(connection);
        await deps.journal.markConnectionRevoked(
          scope,
          connection.connectionId,
          now().toISOString()
        );
        revokedConnectionIds.add(connection.connectionId);
      }
      await deps.journal.markStepCompleted(scope, "connections_revoked", now().toISOString());
    });
    completed.add("connections_revoked");
  }

  if (!completed.has("owned_state_removed")) {
    await runStage(deps, scope, "owned_state_removed", async () => {
      await deps.host.removePackageOwnedState(scope);
      await deps.journal.markStepCompleted(scope, "owned_state_removed", now().toISOString());
    });
    completed.add("owned_state_removed");
  }

  if (!completed.has("release_provenance_removed")) {
    await runStage(deps, scope, "release_provenance_removed", async () => {
      await deps.host.removeReleaseProvenance(scope);
      await deps.journal.markStepCompleted(
        scope,
        "release_provenance_removed",
        now().toISOString()
      );
    });
    completed.add("release_provenance_removed");
  }

  if (!completed.has("soul_package_removed")) {
    await runStage(deps, scope, "soul_package_removed", async () => {
      await deps.host.removeSoulPackage(scope);
      await deps.journal.markStepCompleted(scope, "soul_package_removed", now().toISOString());
    });
  }

  await runStage(deps, scope, "operation_completed", async () => {
    await deps.journal.markCompleted(scope, now().toISOString());
  });
  return { scope, status: "complete" };
}

export async function uninstallOimRelease(
  deps: UninstallOimReleaseDeps,
  scope: OimUninstallTarget
): Promise<OimUninstallResult> {
  const now = deps.now ?? (() => new Date());
  await deps.journal.begin(scope, now().toISOString());
  return deps.journal.runExclusive(scope, () => runUninstall(deps, scope));
}

export async function uninstallOimReleaseGeneration(
  deps: UninstallOimReleaseGenerationDeps,
  generation: OimUninstallGeneration
): Promise<OimUninstallResult> {
  const existing = await deps.journal.get(generation);
  if (existing?.status === "complete") {
    return { scope: existing, status: "complete" };
  }
  const target = existing ?? (await deps.findTarget(generation));
  if (target === null) throw new Error("oim_release_installation_missing");
  if (target.installationId !== generation.installationId || !isSameScope(target, generation)) {
    throw new Error("oim_uninstall_generation_mismatch");
  }
  return uninstallOimRelease(deps, target);
}
