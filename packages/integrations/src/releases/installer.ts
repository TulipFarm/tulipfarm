import { canonicalize, type OimManifest, type OimPackageContent } from "@tulipfarm/schema";
import type {
  OimAuthoredDraftReleaseSourceProvenance,
  OimReleaseSourceProvenance,
  PersistedInstalledOimReleaseProvenance,
} from "@tulipfarm/storage";
import {
  type OimReleaseCandidate,
  type OimReleaseSelection,
  selectOimReleaseCandidate,
} from "./candidates";
import {
  type OimReleasePackage,
  type VerifiedOimPackageFile,
  verifyOimReleasePackage,
} from "./package-verifier";
import type {
  AuthorizedCommunityOimRelease,
  AuthorizedOfficialOimRelease,
  AuthorizedOimAutoPatch,
} from "./trust-service";

export interface OimReleaseInstallSnapshotFile extends VerifiedOimPackageFile {
  readonly contentBase64: string;
}

export interface OimReleaseInstallSnapshot {
  readonly integrationId: string;
  readonly version: string;
  readonly majorVersion: number;
  readonly packageDigest: string;
  readonly manifestText: string;
  readonly files: readonly OimReleaseInstallSnapshotFile[];
}

export interface OimReleasePackageInstallReceipt {
  readonly revision: string;
  readonly rollbackToken: unknown;
}

export interface OimReleasePackageRollbackReceipt {
  readonly revision: string;
  readonly restored?: {
    readonly integrationId: string;
    readonly version: string;
    readonly majorVersion: number;
    readonly packageDigest: string;
  };
}

export interface OimReleasePackageWriter {
  prepare(input: {
    readonly businessId: string;
    readonly slug: string;
    readonly snapshot: OimReleaseInstallSnapshot;
  }): Promise<unknown>;
  apply(plan: unknown): Promise<OimReleasePackageInstallReceipt>;
  install(input: {
    readonly businessId: string;
    readonly slug: string;
    readonly snapshot: OimReleaseInstallSnapshot;
  }): Promise<OimReleasePackageInstallReceipt>;
  rollback(receipt: OimReleasePackageInstallReceipt): Promise<OimReleasePackageRollbackReceipt>;
}

export interface OimReleaseInstallOperationPort {
  beginAuthorized(input: {
    readonly kind: "install" | "patch" | "replace";
    readonly authorization:
      | AuthorizedOfficialOimRelease
      | AuthorizedCommunityOimRelease
      | AuthorizedOimAutoPatch;
    readonly businessId: string;
    readonly source: OimReleaseSourceProvenance;
    readonly slug: string;
    readonly originalRequirements: OimManifest;
    readonly autoPatchOptIn: boolean;
    readonly packageSnapshot: OimReleaseInstallSnapshot;
    readonly expected?: PersistedInstalledOimReleaseProvenance;
    readonly startedAt: string;
  }): Promise<OimReleaseOperation>;
  get(operationId: string): Promise<OimReleaseOperation | null>;
  recordPlan(operationId: string, plan: unknown, updatedAt: string): Promise<void>;
  recordSoulWrite(
    operationId: string,
    receipt: OimReleasePackageInstallReceipt,
    soulRevision: string,
    updatedAt: string
  ): Promise<void>;
  commitProvenance(
    operationId: string,
    committedAt: string
  ): Promise<
    | { readonly status: "updated"; readonly provenance: PersistedInstalledOimReleaseProvenance }
    | {
        readonly status: "skipped";
        readonly reason: "auto_patch_disabled" | "installed_release_changed";
      }
  >;
  markCompleted(operationId: string, completedAt: string): Promise<void>;
  markRolledBack(operationId: string, completedAt: string): Promise<void>;
  requireReconciliation(operationId: string, reason: string, updatedAt: string): Promise<void>;
  resumeReconciliation(operationId: string, updatedAt: string): Promise<OimReleaseOperation>;
  listPending(): Promise<readonly OimReleaseOperation[]>;
}

export interface OimReleaseOperation {
  readonly operationId: string;
  readonly businessId: string;
  readonly installationId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly slug: string;
  readonly kind: "install" | "patch" | "replace";
  readonly phase:
    | "prepared"
    | "plan_recorded"
    | "soul_written"
    | "provenance_committed"
    | "completed"
    | "rolled_back"
    | "reconciliation_required";
  readonly next: {
    readonly version: string;
    readonly packageDigest: string;
  };
  readonly packageSnapshot: unknown;
  readonly writePlan: unknown | null;
  readonly writeReceipt: unknown | null;
  readonly soulRevision: string | null;
}

export interface OimReleaseInstallTrustPort {
  authorizeSelectedOfficialRelease(input: {
    readonly selection: OimReleaseSelection;
    readonly candidates: readonly OimReleaseCandidate[];
  }): Promise<AuthorizedOfficialOimRelease>;
  authorizeCommunityRelease(input: {
    readonly package: OimReleasePackage;
    readonly approvedPackageDigest: string;
    readonly autoPatchOptIn?: boolean;
  }): Promise<AuthorizedCommunityOimRelease>;
}

export interface OimReleaseInstallProvenancePort {
  recordInstalledProvenance(input: {
    readonly authorization: AuthorizedOfficialOimRelease | AuthorizedCommunityOimRelease;
    readonly businessId: string;
    readonly source: OimReleaseSourceProvenance;
    readonly slug: string;
    readonly soulRevision: string;
    readonly originalRequirements: OimManifest;
    readonly autoPatchOptIn: boolean;
  }): Promise<void>;
  recordRestoredSoulRevision(input: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly majorVersion: number;
    readonly version: string;
    readonly packageDigest: string;
    readonly slug: string;
    readonly soulRevision: string;
  }): Promise<void>;
}

interface OimReleaseInstallBase {
  readonly businessId: string;
  readonly slug: string;
  readonly source: string;
  readonly sourceRef: string;
  readonly candidatePath: string;
  readonly originalRequirements?: OimManifest;
  readonly selection: OimReleaseSelection;
  readonly candidates: readonly OimReleaseCandidate[];
}

export interface InstallOfficialOimReleaseInput extends OimReleaseInstallBase {
  readonly trustClass: "official";
  readonly autoPatchOptIn: boolean;
}

export interface InstallCommunityOimReleaseInput extends OimReleaseInstallBase {
  readonly trustClass: "community";
  readonly approvedCommunityDigest: string;
}

export type InstallSelectedOimReleaseInput =
  | InstallOfficialOimReleaseInput
  | InstallCommunityOimReleaseInput;

export interface InstallSelectedOimReleaseDeps {
  readonly trust: OimReleaseInstallTrustPort;
  readonly packageWriter: OimReleasePackageWriter;
  readonly provenance: OimReleaseInstallProvenancePort;
  readonly operations: OimReleaseInstallOperationPort;
  readonly now?: () => Date;
}

export interface InstalledOimRelease {
  readonly installationId: string;
  readonly integrationId: string;
  readonly version: string;
  readonly majorVersion: number;
  readonly packageDigest: string;
  readonly trustClass: "official" | "community";
  readonly revision: string;
}

export class OimReleaseInstallError extends Error {
  constructor(
    readonly code:
      | "COMMUNITY_SIGNATURE_DOWNGRADE"
      | "INSTALL_ROLLBACK_FAILED"
      | "INVALID_AUTHORED_RELEASE_SOURCE"
      | "INVALID_RELEASE_VERSION"
      | "REVIEWED_COMMUNITY_DRAFT_UNAVAILABLE"
      | "REPLACE_PRECONDITION_MISMATCH",
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "OimReleaseInstallError";
  }
}

function gitSource(input: {
  readonly source: string;
  readonly sourceRef: string;
  readonly candidatePath: string;
}): OimReleaseSourceProvenance {
  return {
    kind: "git",
    repository: input.source,
    ref: input.sourceRef,
    path: input.candidatePath,
  };
}

function cloneContent(content: OimPackageContent): OimPackageContent {
  return typeof content === "string" ? content : new Uint8Array(content);
}

function capturePackage(packageInput: OimReleasePackage): {
  readonly package: OimReleasePackage;
  readonly snapshot: OimReleaseInstallSnapshot;
} {
  const manifest = structuredClone(packageInput.manifest);
  const files = new Map<string, OimPackageContent>();
  for (const [path, content] of packageInput.files) files.set(path, cloneContent(content));
  const package_ = { manifest, files };
  const verified = verifyOimReleasePackage(package_);
  const majorVersion = Number(verified.version.split(".")[0]);
  if (!Number.isSafeInteger(majorVersion) || majorVersion < 0) {
    throw new OimReleaseInstallError(
      "INVALID_RELEASE_VERSION",
      "OIM release version has no valid major"
    );
  }
  const snapshotFiles = verified.files.map((file) => {
    const content = files.get(file.path);
    if (content === undefined) throw new Error("verified_oim_companion_missing");
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    return Object.freeze({ ...file, contentBase64: bytes.toString("base64") });
  });
  return {
    package: package_,
    snapshot: Object.freeze({
      ...verified,
      majorVersion,
      manifestText: canonicalize(manifest),
      files: Object.freeze(snapshotFiles),
    }),
  };
}

function rollbackReceiptFrom(error: unknown): OimReleasePackageRollbackReceipt | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("rollbackReceipt" in error) ||
    typeof error.rollbackReceipt !== "object" ||
    error.rollbackReceipt === null ||
    !("revision" in error.rollbackReceipt) ||
    typeof error.rollbackReceipt.revision !== "string"
  ) {
    return undefined;
  }
  return error.rollbackReceipt as OimReleasePackageRollbackReceipt;
}

async function recordRestoredRevision(
  input: Pick<InstallSelectedOimReleaseInput, "businessId" | "slug">,
  provenance: OimReleaseInstallProvenancePort,
  rollback: OimReleasePackageRollbackReceipt
): Promise<void> {
  if (rollback.restored === undefined) return;
  await provenance.recordRestoredSoulRevision({
    businessId: input.businessId,
    ...rollback.restored,
    slug: input.slug,
    soulRevision: rollback.revision,
  });
}

function operationReceipt(operation: OimReleaseOperation): OimReleasePackageInstallReceipt {
  const receipt = operation.writeReceipt;
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    !("revision" in receipt) ||
    typeof receipt.revision !== "string" ||
    !("rollbackToken" in receipt)
  ) {
    throw new Error("oim_release_operation_receipt_missing");
  }
  return receipt as OimReleasePackageInstallReceipt;
}

function operationPlan(operation: OimReleaseOperation): unknown {
  if (operation.writePlan === null) throw new Error("oim_release_operation_plan_missing");
  return operation.writePlan;
}

function operationSnapshot(operation: OimReleaseOperation): OimReleaseInstallSnapshot {
  if (
    typeof operation.packageSnapshot !== "object" ||
    operation.packageSnapshot === null ||
    Array.isArray(operation.packageSnapshot)
  ) {
    throw new Error("oim_release_operation_snapshot_missing");
  }
  return operation.packageSnapshot as OimReleaseInstallSnapshot;
}

function installedResult(
  operation: OimReleaseOperation,
  trustClass: "official" | "community"
): InstalledOimRelease {
  if (operation.soulRevision === null) throw new Error("oim_release_operation_revision_missing");
  return Object.freeze({
    installationId: operation.installationId,
    integrationId: operation.integrationId,
    version: operation.next.version,
    majorVersion: operation.majorVersion,
    packageDigest: operation.next.packageDigest,
    trustClass,
    revision: operation.soulRevision,
  });
}

async function rollbackOperation(
  input: Pick<InstallSelectedOimReleaseInput, "businessId" | "slug">,
  deps: InstallSelectedOimReleaseDeps,
  operation: OimReleaseOperation,
  cause: unknown
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  try {
    const rollback = await deps.packageWriter.rollback(operationReceipt(operation));
    await recordRestoredRevision(input, deps.provenance, rollback);
    await deps.operations.markRolledBack(operation.operationId, now().toISOString());
  } catch (rollbackError) {
    await deps.operations.requireReconciliation(
      operation.operationId,
      rollbackError instanceof Error ? rollbackError.message : "oim_release_rollback_failed",
      now().toISOString()
    );
    throw new OimReleaseInstallError(
      "INSTALL_ROLLBACK_FAILED",
      "OIM provenance failed and the Soul package could not be rolled back",
      { cause: new AggregateError([cause, rollbackError]) }
    );
  }
}

async function continueInstallOperation(
  input: Pick<InstallSelectedOimReleaseInput, "businessId" | "slug">,
  deps: InstallSelectedOimReleaseDeps,
  operationInput: OimReleaseOperation
): Promise<OimReleaseOperation> {
  const now = deps.now ?? (() => new Date());
  let operation = operationInput;
  if (operation.phase === "prepared") {
    const plan = await deps.packageWriter.prepare({
      businessId: input.businessId,
      slug: input.slug,
      snapshot: operationSnapshot(operation),
    });
    await deps.operations.recordPlan(operation.operationId, plan, now().toISOString());
    operation = (await deps.operations.get(operation.operationId)) ?? operation;
  }
  if (operation.phase === "plan_recorded") {
    let receipt: OimReleasePackageInstallReceipt;
    try {
      receipt = await deps.packageWriter.apply(operationPlan(operation));
    } catch (error) {
      const rollback = rollbackReceiptFrom(error);
      if (rollback !== undefined) {
        await recordRestoredRevision(input, deps.provenance, rollback);
      }
      if (rollback !== undefined) {
        await deps.operations.markRolledBack(operation.operationId, now().toISOString());
      }
      throw error;
    }
    try {
      await deps.operations.recordSoulWrite(
        operation.operationId,
        receipt,
        receipt.revision,
        now().toISOString()
      );
    } catch (error) {
      const durable = await deps.operations.get(operation.operationId);
      if (durable?.phase !== "soul_written") throw error;
    }
    operation = (await deps.operations.get(operation.operationId)) ?? operation;
  }
  if (operation.phase === "soul_written") {
    try {
      const committed = await deps.operations.commitProvenance(
        operation.operationId,
        now().toISOString()
      );
      if (committed.status === "skipped") {
        await rollbackOperation(input, deps, operation, new Error(committed.reason));
        throw new Error(committed.reason);
      }
    } catch (error) {
      const durable = await deps.operations.get(operation.operationId);
      if (durable?.phase !== "provenance_committed" && durable?.phase !== "completed") {
        await rollbackOperation(input, deps, operation, error);
        throw error;
      }
    }
    operation = (await deps.operations.get(operation.operationId)) ?? operation;
  }
  if (operation.phase === "provenance_committed") {
    await deps.operations.markCompleted(operation.operationId, now().toISOString());
    operation = (await deps.operations.get(operation.operationId)) ?? operation;
  }
  if (operation.phase !== "completed") {
    throw new Error(`oim_release_operation_unresolved:${operation.phase}`);
  }
  return operation;
}

export async function installSelectedOimRelease(
  input: InstallSelectedOimReleaseInput,
  deps: InstallSelectedOimReleaseDeps
): Promise<InstalledOimRelease> {
  const selected = selectOimReleaseCandidate(input.selection, input.candidates);
  const captured = capturePackage(selected.package);
  const candidates = input.candidates.map((candidate) =>
    candidate === selected ? { ...candidate, package: captured.package } : candidate
  );
  const authorization =
    input.trustClass === "official"
      ? await deps.trust.authorizeSelectedOfficialRelease({
          selection: input.selection,
          candidates,
        })
      : await (() => {
          if (selected.signedRelease !== undefined) {
            throw new OimReleaseInstallError(
              "COMMUNITY_SIGNATURE_DOWNGRADE",
              "A signed OIM candidate cannot be installed by bypassing official trust"
            );
          }
          return deps.trust.authorizeCommunityRelease({
            package: captured.package,
            approvedPackageDigest: input.approvedCommunityDigest,
          });
        })();

  const now = deps.now ?? (() => new Date());
  const operation = await deps.operations.beginAuthorized({
    kind: "install",
    authorization,
    businessId: input.businessId,
    source: gitSource(input),
    slug: input.slug,
    originalRequirements: structuredClone(input.originalRequirements ?? captured.package.manifest),
    autoPatchOptIn: input.trustClass === "official" && input.autoPatchOptIn,
    packageSnapshot: captured.snapshot,
    startedAt: now().toISOString(),
  });
  const completed = await continueInstallOperation(input, deps, operation);
  return installedResult(completed, authorization.trustClass);
}

export interface InstallReviewedCommunityOimReleaseInput {
  readonly businessId: string;
  readonly slug: string;
  readonly approvedPackageDigest: string;
  readonly principal: {
    readonly kind: string;
    readonly id: string;
  };
  readonly runId: string;
  readonly replace: boolean;
}

export interface OimReviewedCommunityDraft {
  readonly slug: string;
  readonly package: OimReleasePackage;
  readonly source: OimAuthoredDraftReleaseSourceProvenance;
  readonly replace?: PersistedInstalledOimReleaseProvenance;
}

/** Consumes exact reviewed bytes from a server-owned store scoped to the invoking principal. */
export interface OimReviewedCommunityDraftPort {
  consume(input: {
    readonly businessId: string;
    readonly approvedPackageDigest: string;
    readonly principal: {
      readonly kind: string;
      readonly id: string;
    };
    readonly runId: string;
  }): Promise<OimReviewedCommunityDraft | null>;
}

export interface InstallReviewedCommunityOimReleaseDeps extends InstallSelectedOimReleaseDeps {
  readonly reviewedDrafts: OimReviewedCommunityDraftPort;
}

function validAuthoredDraftSource(source: unknown, businessId: string): boolean {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return false;
  const value = source as Record<string, unknown>;
  if (
    typeof value.reviewedBy !== "object" ||
    value.reviewedBy === null ||
    Array.isArray(value.reviewedBy)
  ) {
    return false;
  }
  const reviewedBy = value.reviewedBy as Record<string, unknown>;
  if (
    typeof reviewedBy.principal !== "object" ||
    reviewedBy.principal === null ||
    Array.isArray(reviewedBy.principal)
  ) {
    return false;
  }
  const principal = reviewedBy.principal as Record<string, unknown>;
  return (
    Object.keys(value).every((key) =>
      ["kind", "reviewId", "reviewedAt", "reviewedBy", "runId", "toolCallId"].includes(key)
    ) &&
    Object.keys(reviewedBy).every((key) => ["businessId", "principal"].includes(key)) &&
    Object.keys(principal).every((key) => ["kind", "id"].includes(key)) &&
    value.kind === "authored_draft" &&
    typeof value.reviewId === "string" &&
    value.reviewId.length > 0 &&
    typeof value.reviewedAt === "string" &&
    !Number.isNaN(Date.parse(value.reviewedAt)) &&
    reviewedBy.businessId === businessId &&
    typeof principal.kind === "string" &&
    principal.kind.length > 0 &&
    typeof principal.id === "string" &&
    principal.id.length > 0 &&
    (value.runId === undefined || (typeof value.runId === "string" && value.runId.length > 0)) &&
    (value.toolCallId === undefined ||
      (typeof value.toolCallId === "string" && value.toolCallId.length > 0))
  );
}

export async function installReviewedCommunityOimRelease(
  input: InstallReviewedCommunityOimReleaseInput,
  deps: InstallReviewedCommunityOimReleaseDeps
): Promise<InstalledOimRelease> {
  const draft = await deps.reviewedDrafts.consume({
    businessId: input.businessId,
    approvedPackageDigest: input.approvedPackageDigest,
    principal: input.principal,
    runId: input.runId,
  });
  if (draft === null) {
    throw new OimReleaseInstallError(
      "REVIEWED_COMMUNITY_DRAFT_UNAVAILABLE",
      "The reviewed Community OIM draft is unavailable"
    );
  }
  if (
    draft.slug !== input.slug ||
    !validAuthoredDraftSource(draft.source, input.businessId) ||
    draft.source.reviewedBy.principal.kind !== input.principal.kind ||
    draft.source.reviewedBy.principal.id !== input.principal.id ||
    draft.source.runId !== input.runId
  ) {
    throw new OimReleaseInstallError(
      "INVALID_AUTHORED_RELEASE_SOURCE",
      "Reviewed Community OIM releases require matching draft review provenance"
    );
  }
  if (input.replace !== (draft.replace !== undefined)) {
    throw new OimReleaseInstallError(
      "REPLACE_PRECONDITION_MISMATCH",
      "Reviewed Community OIM replacement intent does not match the reviewed generation"
    );
  }
  const captured = capturePackage(draft.package);
  if (
    draft.replace !== undefined &&
    (draft.replace.businessId !== input.businessId ||
      draft.replace.integrationId !== captured.snapshot.integrationId ||
      draft.replace.majorVersion !== captured.snapshot.majorVersion ||
      draft.replace.slug !== input.slug)
  ) {
    throw new OimReleaseInstallError(
      "REPLACE_PRECONDITION_MISMATCH",
      "Reviewed Community OIM replacement does not match the approved installed generation"
    );
  }
  const authorization = await deps.trust.authorizeCommunityRelease({
    package: captured.package,
    approvedPackageDigest: input.approvedPackageDigest,
  });
  const now = deps.now ?? (() => new Date());
  const operation = await deps.operations.beginAuthorized({
    kind: draft.replace === undefined ? "install" : "replace",
    authorization,
    businessId: input.businessId,
    source: structuredClone(draft.source),
    slug: input.slug,
    originalRequirements: structuredClone(captured.package.manifest),
    autoPatchOptIn: false,
    packageSnapshot: captured.snapshot,
    ...(draft.replace === undefined ? {} : { expected: draft.replace }),
    startedAt: now().toISOString(),
  });
  const completed = await continueInstallOperation(input, deps, operation);
  return installedResult(completed, "community");
}

export interface ApplyAuthorizedOimReleasePatchInput {
  readonly provenance: PersistedInstalledOimReleaseProvenance;
  readonly source: string;
  readonly sourceRef: string;
  readonly candidatePath: string;
  readonly selection: OimReleaseSelection;
  readonly candidates: readonly OimReleaseCandidate[];
  readonly authorization: AuthorizedOimAutoPatch;
}

export type ApplyAuthorizedOimReleasePatchResult =
  | { readonly status: "updated"; readonly release: InstalledOimRelease }
  | {
      readonly status: "skipped";
      readonly reason: "auto_patch_disabled" | "installed_release_changed";
    };

export async function applyAuthorizedOimReleasePatch(
  input: ApplyAuthorizedOimReleasePatchInput,
  deps: InstallSelectedOimReleaseDeps
): Promise<ApplyAuthorizedOimReleasePatchResult> {
  const captured = capturePackage(input.authorization.package);
  if (
    captured.snapshot.integrationId !== input.selection.integrationId ||
    captured.snapshot.version !== input.selection.version ||
    captured.snapshot.packageDigest !== input.selection.packageDigest ||
    captured.snapshot.majorVersion !== input.provenance.majorVersion
  ) {
    throw new Error("oim_release_patch_authorization_mismatch");
  }
  const lifecycleInput: InstallOfficialOimReleaseInput = {
    businessId: input.provenance.businessId,
    slug: input.provenance.slug,
    source: input.source,
    sourceRef: input.sourceRef,
    candidatePath: input.candidatePath,
    originalRequirements: input.provenance.originalRequirements as OimManifest,
    selection: input.selection,
    candidates: input.candidates,
    trustClass: "official",
    autoPatchOptIn: input.provenance.autoPatchOptIn,
  };
  const now = deps.now ?? (() => new Date());
  const operation = await deps.operations.beginAuthorized({
    kind: "patch",
    authorization: input.authorization,
    businessId: input.provenance.businessId,
    source: gitSource(input),
    slug: input.provenance.slug,
    originalRequirements: input.provenance.originalRequirements as OimManifest,
    autoPatchOptIn: input.provenance.autoPatchOptIn,
    packageSnapshot: captured.snapshot,
    expected: input.provenance,
    startedAt: now().toISOString(),
  });
  try {
    const completed = await continueInstallOperation(lifecycleInput, deps, operation);
    return { status: "updated", release: installedResult(completed, "official") };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "auto_patch_disabled" || error.message === "installed_release_changed")
    ) {
      return { status: "skipped", reason: error.message };
    }
    throw error;
  }
}

async function recordRestoredRevisionFromOperation(
  operation: OimReleaseOperation,
  provenance: OimReleaseInstallProvenancePort,
  rollback: OimReleasePackageRollbackReceipt
): Promise<void> {
  if (rollback.restored === undefined) return;
  await provenance.recordRestoredSoulRevision({
    businessId: operation.businessId,
    ...rollback.restored,
    slug: operation.slug,
    soulRevision: rollback.revision,
  });
}

export async function reconcileOimReleaseOperations(
  deps: Pick<InstallSelectedOimReleaseDeps, "now" | "operations" | "packageWriter" | "provenance">
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  for (const pending of await deps.operations.listPending()) {
    let operation = pending;
    if (operation.phase === "reconciliation_required") {
      operation = await deps.operations.resumeReconciliation(
        operation.operationId,
        now().toISOString()
      );
    }
    if (operation.phase === "prepared") {
      let plan: unknown;
      try {
        plan = await deps.packageWriter.prepare({
          businessId: operation.businessId,
          slug: operation.slug,
          snapshot: operationSnapshot(operation),
        });
      } catch (error) {
        await deps.operations.requireReconciliation(
          operation.operationId,
          error instanceof Error ? error.message : "oim_release_plan_preparation_failed",
          now().toISOString()
        );
        continue;
      }
      try {
        await deps.operations.recordPlan(operation.operationId, plan, now().toISOString());
      } catch {
        const durable = await deps.operations.get(operation.operationId);
        if (durable?.phase !== "plan_recorded") throw new Error("oim_release_plan_not_recorded");
      }
      operation = (await deps.operations.get(operation.operationId)) ?? operation;
    }
    if (operation.phase === "plan_recorded") {
      try {
        const receipt = await deps.packageWriter.apply(operationPlan(operation));
        await deps.operations.recordSoulWrite(
          operation.operationId,
          receipt,
          receipt.revision,
          now().toISOString()
        );
      } catch (error) {
        const rollback = rollbackReceiptFrom(error);
        if (rollback !== undefined) {
          await recordRestoredRevisionFromOperation(operation, deps.provenance, rollback);
          await deps.operations.markRolledBack(operation.operationId, now().toISOString());
          continue;
        }
        await deps.operations.requireReconciliation(
          operation.operationId,
          error instanceof Error ? error.message : "oim_release_write_reconciliation_failed",
          now().toISOString()
        );
        continue;
      }
      operation = (await deps.operations.get(operation.operationId)) ?? operation;
    }
    if (operation.phase === "soul_written") {
      try {
        const committed = await deps.operations.commitProvenance(
          operation.operationId,
          now().toISOString()
        );
        if (committed.status === "skipped") {
          const rollback = await deps.packageWriter.rollback(operationReceipt(operation));
          await recordRestoredRevisionFromOperation(operation, deps.provenance, rollback);
          await deps.operations.markRolledBack(operation.operationId, now().toISOString());
          continue;
        }
      } catch (error) {
        const durable = await deps.operations.get(operation.operationId);
        if (durable?.phase !== "provenance_committed" && durable?.phase !== "completed") {
          await deps.operations.requireReconciliation(
            operation.operationId,
            error instanceof Error ? error.message : "oim_release_commit_reconciliation_failed",
            now().toISOString()
          );
          continue;
        }
      }
      operation = (await deps.operations.get(operation.operationId)) ?? operation;
    }
    if (operation.phase === "provenance_committed") {
      await deps.operations.markCompleted(operation.operationId, now().toISOString());
    }
  }
}
