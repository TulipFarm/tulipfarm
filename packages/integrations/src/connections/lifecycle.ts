import { randomUUID } from "node:crypto";
import type { OimAuth, OimConnection, OimManifest } from "@tulipfarm/schema";
import type {
  ConnectionAuthStep,
  ConnectionAuthStepFence,
  PersistedConnection,
  PublishConnectionAuthStep,
} from "@tulipfarm/storage";
import { oimManifestMajor } from "./catalog";

type OAuthStep = Extract<OimAuth["steps"][number], { type: "oauth2" }>;

export interface ConnectionCredentialVault {
  create(
    integrationId: string,
    credentialSlot: string,
    plaintext: string
  ): Promise<`secret://${string}`>;
  read(reference: string): Promise<string>;
  rotate(reference: string, plaintext: string): Promise<void>;
  revokeReferences(references: readonly string[]): Promise<void>;
  revokeConnection(
    connectionId: string,
    bindings: Readonly<Record<string, string>>,
    persistRevocation: () => Promise<void>
  ): Promise<void>;
}

interface AuthStepRepository {
  put(
    input: Omit<ConnectionAuthStep, "revision" | "createdAt" | "updatedAt">
  ): Promise<ConnectionAuthStep>;
  list(businessId: string, connectionId: string): Promise<readonly ConnectionAuthStep[]>;
}

interface ConnectionWriteRepository {
  put(businessId: string, connection: OimConnection): Promise<void>;
}

interface ConnectionLifecycleRepository {
  claimAuthStep(input: ConnectionAuthStepFence): Promise<boolean>;
  publishAuthStep(input: PublishConnectionAuthStep): Promise<boolean>;
  markActionRequired(
    businessId: string,
    connectionId: string,
    integration: OimConnection["integration"],
    owner: OimConnection["owner"],
    checkedAt: string
  ): Promise<boolean>;
  findById(businessId: string, connectionId: string): Promise<PersistedConnection | null>;
  fenceRevocation(businessId: string, connectionId: string): Promise<PersistedConnection | null>;
}

export interface VerifiedConnectionIdentityEvidence {
  readonly externalTenantId: string;
  readonly externalAccountId: string;
  readonly proofDigest: string;
  readonly verifiedAt: string;
  readonly verifiedBy: string;
}

export interface OimOAuthRefresh {
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly expiresAt: string | null;
  readonly verifiedIdentity: VerifiedConnectionIdentityEvidence;
}

export interface OimOAuthRefreshRequest {
  readonly manifest: OimManifest;
  readonly step: OAuthStep;
  readonly connection: PersistedConnection;
  readonly credentials: Readonly<Record<string, string>>;
}

export interface OimOAuthRefreshStepResult {
  readonly stepId: string;
  readonly status: "renewed" | "skipped" | "in_progress" | "action_required" | "conflict";
  readonly error?: "missing_step" | "missing_credential" | "refresh_failed" | "revision_conflict";
}

export interface OimOAuthRefreshResult {
  readonly connectionId: string;
  readonly health: OimConnection["health"]["status"];
  readonly steps: readonly OimOAuthRefreshStepResult[];
}

export interface RefreshOimConnectionDeps {
  readonly authSteps: AuthStepRepository;
  readonly connections: ConnectionLifecycleRepository;
  readonly credentials: ConnectionCredentialVault;
  readonly refreshOAuth: (request: OimOAuthRefreshRequest) => Promise<OimOAuthRefresh>;
  readonly now?: () => Date;
  readonly renewalWindowSeconds?: number;
  readonly claimLeaseSeconds?: number;
}

const DEFAULT_RENEWAL_WINDOW_SECONDS = 10 * 60;
const DEFAULT_CLAIM_LEASE_SECONDS = 2 * 60;

export interface CreateOimConnectionDeps {
  readonly connections: ConnectionWriteRepository;
  readonly authSteps: AuthStepRepository;
  readonly credentials: ConnectionCredentialVault;
  readonly newId?: () => string;
  readonly now?: () => Date;
}

export interface CreateOimConnectionInput {
  readonly businessId: string;
  readonly manifest: OimManifest;
  readonly label: string;
  readonly owner: OimConnection["owner"];
  readonly values: Readonly<Record<string, string>>;
  readonly isDefault?: boolean;
}

export async function createOimConnection(
  deps: CreateOimConnectionDeps,
  input: CreateOimConnectionInput
): Promise<{ readonly connectionId: string }> {
  const connectionId = (deps.newId ?? randomUUID)();
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const configuration: Record<string, string | number | boolean> = {};
  const secretBindings: Record<string, `secret://${string}`> = {};
  const browserSteps = (input.manifest.auth?.steps ?? []).filter((step) => step.type !== "fields");

  for (const step of input.manifest.auth?.steps ?? []) {
    if (step.type !== "fields") continue;
    for (const field of step.fields) {
      const value = input.values[field.id];
      if (value === undefined) continue;
      if (field.target.type === "credential") {
        secretBindings[field.target.slot] = await deps.credentials.create(
          input.manifest.metadata.id,
          field.target.slot,
          value
        );
      } else {
        configuration[field.target.field] = value;
      }
    }
  }

  await deps.connections.put(input.businessId, {
    id: connectionId,
    integration: {
      id: input.manifest.metadata.id,
      majorVersion: oimManifestMajor(input.manifest),
    },
    label: input.label,
    owner: input.owner,
    status: "active",
    isDefault: input.isDefault ?? false,
    configuration,
    agentVisibleConfiguration: (input.manifest.auth?.configurationFields ?? [])
      .filter((field) => field.agentVisible === true)
      .map((field) => field.id),
    secretBindings,
    health: {
      status: browserSteps.length === 0 ? "healthy" : "action_required",
      checkedAt: now,
    },
    expiresAt: null,
  });

  for (const step of browserSteps) {
    await deps.authSteps.put({
      businessId: input.businessId,
      connectionId,
      stepId: step.id,
      status: "pending",
      accessSlot: null,
      accessSecretRef: null,
      refreshSlot: null,
      refreshSecretRef: null,
      externalIdentity: null,
      expiresAt: null,
      healthCheckedAt: now,
    });
  }

  return { connectionId };
}

function oauthSteps(manifest: OimManifest): readonly OAuthStep[] {
  return (manifest.auth?.steps ?? []).filter((step): step is OAuthStep => step.type === "oauth2");
}

function expiringWithin(expiresAt: string | null, now: Date, seconds: number): boolean {
  if (expiresAt === null) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= now.getTime() + seconds * 1_000;
}

function activeClaim(row: ConnectionAuthStep, now: Date, claimLeaseSeconds: number): boolean {
  if (row.status !== "pending" || row.healthCheckedAt === null) return false;
  return Date.parse(row.healthCheckedAt) + claimLeaseSeconds * 1_000 > now.getTime();
}

async function credentialValues(
  vault: ConnectionCredentialVault,
  connection: PersistedConnection,
  slots: ReadonlySet<string>
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const [slot, reference] of Object.entries(connection.secretBindings)) {
    if (!slots.has(slot)) continue;
    values[slot] = await vault.read(reference);
  }
  return values;
}

function publication(
  connection: PersistedConnection,
  row: ConnectionAuthStep,
  expectedRevision: number,
  now: Date,
  input: {
    readonly status: PublishConnectionAuthStep["status"];
    readonly expiresAt: string | null;
    readonly secretBindings?: Readonly<Record<string, `secret://${string}`>>;
    readonly verifiedIdentity?: VerifiedConnectionIdentityEvidence;
  }
): PublishConnectionAuthStep {
  const verifiedIdentity = input.verifiedIdentity;
  return {
    businessId: row.businessId,
    connectionId: row.connectionId,
    integration: connection.integration,
    owner: connection.owner,
    stepId: row.stepId,
    expectedRevision,
    status: input.status,
    accessSlot: row.accessSlot,
    accessSecretRef:
      row.accessSlot === null
        ? null
        : (input.secretBindings?.[row.accessSlot] ?? row.accessSecretRef),
    refreshSlot: row.refreshSlot,
    refreshSecretRef:
      row.refreshSlot === null
        ? null
        : (input.secretBindings?.[row.refreshSlot] ?? row.refreshSecretRef),
    externalIdentity:
      verifiedIdentity === undefined
        ? row.externalIdentity
        : {
            externalTenantId: verifiedIdentity.externalTenantId,
            externalAccountId: verifiedIdentity.externalAccountId,
            proofDigest: verifiedIdentity.proofDigest,
            verifiedAt: verifiedIdentity.verifiedAt,
            verifiedBy: verifiedIdentity.verifiedBy,
          },
    expiresAt: input.expiresAt,
    healthCheckedAt: now.toISOString(),
    configuration: {},
    secretBindings: input.secretBindings ?? {},
    ...(verifiedIdentity === undefined
      ? {}
      : {
          verifiedIdentity: {
            businessId: connection.businessId,
            connectionId: connection.id,
            integrationId: connection.integration.id,
            integrationMajorVersion: connection.integration.majorVersion,
            ...verifiedIdentity,
            proofKind: "health" as const,
          },
        }),
  };
}

async function markFailed(
  repository: ConnectionLifecycleRepository,
  connection: PersistedConnection,
  row: ConnectionAuthStep,
  expectedRevision: number,
  now: Date,
  error: OimOAuthRefreshStepResult["error"]
): Promise<OimOAuthRefreshStepResult> {
  const updated = await repository.publishAuthStep(
    publication(connection, row, expectedRevision, now, {
      status: "action_required",
      expiresAt: row.expiresAt,
    })
  );
  return !updated
    ? { stepId: row.stepId, status: "conflict", error: "revision_conflict" }
    : { stepId: row.stepId, status: "action_required", error };
}

async function refreshStep(
  deps: RefreshOimConnectionDeps,
  manifest: OimManifest,
  connection: PersistedConnection,
  step: OAuthStep,
  row: ConnectionAuthStep,
  now: Date,
  renewalWindowSeconds: number
): Promise<OimOAuthRefreshStepResult> {
  if (activeClaim(row, now, deps.claimLeaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS)) {
    return { stepId: step.id, status: "in_progress" };
  }
  if (!expiringWithin(row.expiresAt, now, renewalWindowSeconds)) {
    return { stepId: step.id, status: "skipped" };
  }
  const claimed = await deps.connections.claimAuthStep({
    businessId: row.businessId,
    connectionId: row.connectionId,
    integration: connection.integration,
    owner: connection.owner,
    stepId: row.stepId,
    expectedRevision: row.revision,
    healthCheckedAt: now.toISOString(),
  });
  if (!claimed) {
    return { stepId: step.id, status: "conflict", error: "revision_conflict" };
  }
  const claimRevision = row.revision + 1;
  if (row.refreshSlot === null || row.refreshSecretRef === null) {
    return markFailed(deps.connections, connection, row, claimRevision, now, "missing_credential");
  }

  const stepSlots = new Set([
    step.clientId.slot,
    ...(step.clientSecret === undefined ? [] : [step.clientSecret.slot]),
    ...step.bindings.flatMap((binding) =>
      binding.target.type === "credential" ? [binding.target.slot] : []
    ),
  ]);
  let current: Record<string, string>;
  let refreshed: OimOAuthRefresh;
  try {
    current = await credentialValues(deps.credentials, connection, stepSlots);
    refreshed = await deps.refreshOAuth({
      manifest,
      step,
      connection,
      credentials: current,
    });
  } catch {
    return markFailed(deps.connections, connection, row, claimRevision, now, "refresh_failed");
  }
  if (
    Object.keys(refreshed.credentialValues).some(
      (slot) => connection.secretBindings[slot] === undefined
    )
  ) {
    return markFailed(deps.connections, connection, row, claimRevision, now, "missing_credential");
  }

  const staged: `secret://${string}`[] = [];
  const bindingPatch: Record<string, `secret://${string}`> = {};
  const replaced: string[] = [];
  try {
    for (const [slot, plaintext] of Object.entries(refreshed.credentialValues)) {
      const reference = connection.secretBindings[slot];
      if (reference === undefined) continue;
      if (current[slot] === plaintext) continue;
      const stagedReference = await deps.credentials.create(
        connection.integration.id,
        slot,
        plaintext
      );
      staged.push(stagedReference);
      bindingPatch[slot] = stagedReference;
      replaced.push(reference);
    }
  } catch {
    await deps.credentials.revokeReferences(staged);
    return markFailed(deps.connections, connection, row, claimRevision, now, "refresh_failed");
  }
  let published: boolean;
  try {
    published = await deps.connections.publishAuthStep(
      publication(connection, row, claimRevision, now, {
        status: "active",
        expiresAt: refreshed.expiresAt,
        secretBindings: bindingPatch,
        verifiedIdentity: refreshed.verifiedIdentity,
      })
    );
  } catch (error) {
    await deps.credentials.revokeReferences(staged);
    throw error;
  }
  if (!published) {
    await deps.credentials.revokeReferences(staged);
    return { stepId: step.id, status: "conflict", error: "revision_conflict" };
  }
  await deps.credentials.revokeReferences(replaced);
  return { stepId: step.id, status: "renewed" };
}

/** Refreshes every independently expiring OAuth step without crossing a Connection boundary. */
export async function refreshOimConnection(
  deps: RefreshOimConnectionDeps,
  manifest: OimManifest,
  connection: PersistedConnection
): Promise<OimOAuthRefreshResult> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.authSteps.list(connection.businessId, connection.id);
  const byId = new Map(rows.map((row) => [row.stepId, row]));
  const steps = oauthSteps(manifest);

  const results: OimOAuthRefreshStepResult[] = [];
  for (const step of steps) {
    const row = byId.get(step.id);
    if (row === undefined) {
      results.push({ stepId: step.id, status: "action_required", error: "missing_step" });
      await deps.connections.markActionRequired(
        connection.businessId,
        connection.id,
        connection.integration,
        connection.owner,
        now.toISOString()
      );
      continue;
    }
    results.push(
      await refreshStep(
        deps,
        manifest,
        connection,
        step,
        row,
        now,
        deps.renewalWindowSeconds ?? DEFAULT_RENEWAL_WINDOW_SECONDS
      )
    );
  }
  const current = await deps.connections.findById(connection.businessId, connection.id);
  if (current === null) throw new Error("connection_not_found_after_refresh");
  return { connectionId: connection.id, health: current.health.status, steps: results };
}

export interface RevokeOimConnectionDeps {
  readonly connections: Pick<ConnectionLifecycleRepository, "fenceRevocation">;
  readonly credentials: Pick<ConnectionCredentialVault, "revokeConnection">;
}

/** Revokes by persisted Connection identity, so removal of its installed manifest cannot strand it. */
export async function revokeOimConnection(
  deps: RevokeOimConnectionDeps,
  connection: PersistedConnection
): Promise<{ readonly connectionId: string; readonly status: "revoked" }> {
  const fenced = await deps.connections.fenceRevocation(connection.businessId, connection.id);
  if (fenced === null) throw new Error("connection_revocation_not_persisted");
  await deps.credentials.revokeConnection(fenced.id, fenced.secretBindings, async () => {});
  return { connectionId: connection.id, status: "revoked" };
}
