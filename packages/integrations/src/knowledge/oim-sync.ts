/**
 * Executes an OIM Knowledge plan as a read-only sync.
 *
 * Three properties this file exists to hold:
 *
 * - **Nothing here writes to the provider.** Every operation it calls was checked read-only at
 *   compile time, and provider mutations stay ordinary approval-gated Tools.
 * - **A checkpoint advances only after the commit it describes.** Advancing first is how a crash
 *   skips content permanently; re-reading a page is merely wasteful.
 * - **One item's failure is one item's failure.** A page the provider refuses leaves the rest of
 *   the scope indexed and the checkpoint where it was, so the next Run retries exactly that page.
 */

import { canonicalHash } from "@tulipfarm/schema";
import { readPointer } from "../egress/oim-pagination";
import { type OimHookPhaseRunner, runOimHookPhase } from "../oim-hooks";
import { isOimKnowledgeRetryRequiredError } from "./oim-errors";
import {
  type KnowledgeItemFieldValue,
  mapAclEntries,
  mapContent,
  mapListItems,
  type ProviderAclEntry,
  type ResolveKnowledgePrincipalsDeps,
  resolveKnowledgePrincipals,
} from "./oim-mapping";
import type { KnowledgeProfilePlan } from "./oim-profile";
import {
  type KnowledgeEmissionSink,
  type KnowledgeSourceEmission,
  knowledgeSourceId,
} from "./source";

/** One operation call. The adapter behind this is the same governed egress ordinary Tools use. */
export interface OimKnowledgeApiPort {
  execute(input: {
    readonly operationId: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly pageToken?: string;
  }): Promise<{ readonly body: unknown; readonly nextPageToken?: string }>;
}

export interface OimKnowledgeCheckpoint {
  readonly integrationId: string;
  readonly scopeKey: string;
  readonly cursor?: string;
  /** Item ids seen by the last complete full walk, for providers that signal deletion by absence. */
  readonly seenItemIds?: readonly string[];
  readonly updatedAt: string;
}

/** Per-scope checkpoints stop one bad space from stalling or skipping every other one. */
export interface OimKnowledgeCheckpointStore {
  load(integrationId: string, scopeKey: string): Promise<OimKnowledgeCheckpoint | undefined>;
  save(checkpoint: OimKnowledgeCheckpoint): Promise<void>;
}

export interface OimKnowledgeSyncDeps {
  readonly api: OimKnowledgeApiPort;
  readonly checkpoints: OimKnowledgeCheckpointStore;
  readonly sink: KnowledgeEmissionSink;
  readonly identity: Omit<ResolveKnowledgePrincipalsDeps, "businessId" | "provider">;
  readonly hookRunner?: OimHookPhaseRunner;
  readonly now: () => Date;
}

export interface OimKnowledgeSyncOptions {
  readonly businessId: string;
  readonly integrationId: string;
  /** The exact Connection this Routine was bound to. Personal and organization data never mix. */
  readonly connectionId: string;
  readonly sourceKindId: string;
  readonly scopes: readonly string[];
  readonly classification?: readonly string[];
  readonly aclMaximumAgeSeconds?: number;
  readonly liveMaximumAgeSeconds?: number;
}

export type OimSyncFailureCode =
  | "retry_required"
  | "list_failed"
  | "mapping_failed"
  | "acl_failed"
  | "content_failed"
  | "content_absent"
  | "emit_failed"
  | "deletion_sweep_failed";

export interface OimSyncFailure {
  readonly code: OimSyncFailureCode;
  readonly scope: string;
  readonly itemId?: string;
}

export interface OimKnowledgeSyncResult {
  readonly scopesProcessed: number;
  readonly itemsProcessed: number;
  readonly emitted: number;
  readonly unverifiable: number;
  readonly indexed: number;
  readonly removed: number;
  readonly failures: readonly OimSyncFailure[];
}

const DEFAULTS = {
  classification: ["internal"] as readonly string[],
  aclMaximumAgeSeconds: 900,
  liveMaximumAgeSeconds: 60,
};

/**
 * The Knowledge source id one item is indexed under.
 *
 * Scoped by Connection, not merely by Integration. Two Connections of one provider — a personal
 * one and the organization's — can legitimately see the same item id, and indexing both under one
 * source id would let whichever synced last overwrite the other's ACL snapshot. That is exactly
 * the "personal and organization content never mix" rule, decided here because this is the only
 * place the id is minted.
 */
function sourceIdFor(
  plan: KnowledgeProfilePlan,
  options: OimKnowledgeSyncOptions,
  itemId: string
): string {
  return knowledgeSourceId(plan.integrationId, `${options.connectionId}/${itemId}`);
}

function checkpointIntegrationId(
  plan: KnowledgeProfilePlan,
  options: OimKnowledgeSyncOptions
): string {
  return `${options.integrationId}@${plan.majorVersion}:${options.connectionId}`;
}

export async function syncOimKnowledge(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions
): Promise<OimKnowledgeSyncResult> {
  const totals = { items: 0, emitted: 0, unverifiable: 0, indexed: 0, removed: 0 };
  const failures: OimSyncFailure[] = [];

  for (const scope of options.scopes) {
    const outcome = await syncScope(plan, deps, options, scope);
    totals.items += outcome.items;
    totals.emitted += outcome.emitted;
    totals.unverifiable += outcome.unverifiable;
    totals.indexed += outcome.indexed;
    totals.removed += outcome.removed;
    failures.push(...outcome.failures);
  }

  return {
    scopesProcessed: options.scopes.length,
    itemsProcessed: totals.items,
    emitted: totals.emitted,
    unverifiable: totals.unverifiable,
    indexed: totals.indexed,
    removed: totals.removed,
    failures,
  };
}

interface ScopeOutcome {
  items: number;
  emitted: number;
  unverifiable: number;
  indexed: number;
  removed: number;
  failures: OimSyncFailure[];
}

async function syncScope(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  scope: string
): Promise<ScopeOutcome> {
  const outcome: ScopeOutcome = {
    items: 0,
    emitted: 0,
    unverifiable: 0,
    indexed: 0,
    removed: 0,
    failures: [],
  };
  const scopeKey = `${options.sourceKindId}:${scope}`;
  const checkpointId = checkpointIntegrationId(plan, options);
  const stored = await deps.checkpoints.load(checkpointId, scopeKey);

  // Resolved once per scope when the provider expresses permissions at container level; asking
  // per item would be the same answer at N times the provider's rate limit.
  let scopeAcl: Awaited<ReturnType<typeof readAcl>> | undefined;
  if (plan.acl.mode === "scope") {
    scopeAcl = await readAcl(plan, deps, options, { scope });
    if (scopeAcl.kind === "failed") {
      outcome.failures.push({ code: scopeAcl.failure, scope });
      return outcome;
    }
  }

  const seenItemIds: string[] = [];
  let cursor = stored?.cursor;
  let pageToken: string | undefined =
    plan.list.cursor.kind === "operation_pagination" ? stored?.cursor : undefined;
  let complete = true;

  for (let page = 0; page < plan.list.maxPagesPerRun; page += 1) {
    const parameters: Record<string, unknown> = {};
    if (plan.list.scopeParameter !== undefined) parameters[plan.list.scopeParameter] = scope;
    if (
      plan.list.cursor.kind === "response_pointer" &&
      page === 0 &&
      stored?.cursor !== undefined
    ) {
      const parameter = plan.list.cursor.requestParameter;
      if (parameter !== undefined) parameters[parameter] = stored.cursor;
    }

    let response: Awaited<ReturnType<OimKnowledgeApiPort["execute"]>>;
    try {
      response = await deps.api.execute({
        operationId: plan.list.operation.id,
        parameters,
        pageToken,
      });
    } catch (error) {
      outcome.failures.push({
        code: isOimKnowledgeRetryRequiredError(error) ? "retry_required" : "list_failed",
        scope,
      });
      complete = false;
      break;
    }

    let items: ReturnType<typeof mapListItems>;
    try {
      items = mapListItems(plan, response.body, scope);
    } catch {
      outcome.failures.push({ code: "mapping_failed", scope });
      complete = false;
      break;
    }

    for (const item of items) {
      outcome.items += 1;
      seenItemIds.push(item.itemId);
      const itemOutcome = await syncItem(plan, deps, options, scope, item, scopeAcl);
      outcome.emitted += itemOutcome.emitted;
      outcome.unverifiable += itemOutcome.unverifiable;
      outcome.indexed += itemOutcome.indexed;
      outcome.removed += itemOutcome.removed;
      if (itemOutcome.failure !== undefined) {
        outcome.failures.push({ code: itemOutcome.failure, scope, itemId: item.itemId });
        complete = false;
      }
    }

    if (plan.list.cursor.kind === "response_pointer" && plan.list.cursor.pointer !== undefined) {
      const watermark = readPointer(response.body, plan.list.cursor.pointer);
      if (typeof watermark === "string" && watermark.length > 0) cursor = watermark;
    } else if (plan.list.cursor.kind === "operation_pagination") {
      cursor = response.nextPageToken;
    }

    pageToken = response.nextPageToken;
    if (pageToken === undefined) break;
  }

  const walkedWholeScope = complete && pageToken === undefined;
  if (walkedWholeScope && plan.deletion.kind === "absent_from_full_list") {
    outcome.removed += await removeAbsent(
      plan,
      deps,
      options,
      scope,
      stored?.seenItemIds,
      seenItemIds,
      outcome
    );
  }
  if (walkedWholeScope && plan.deletion.kind === "operation") {
    const swept = await sweepDeletions(plan, deps, options, scope);
    if (swept.failure !== undefined) {
      outcome.failures.push({ code: swept.failure, scope });
      complete = false;
    } else {
      outcome.removed += swept.removed;
    }
  }

  // A partial walk keeps the old checkpoint: re-reading a page costs a request, whereas skipping
  // one loses the content on it until somebody notices, which nobody does.
  if (complete) {
    await deps.checkpoints.save({
      integrationId: checkpointId,
      scopeKey,
      cursor: plan.list.cursor.kind === "none" ? undefined : cursor,
      seenItemIds:
        plan.deletion.kind === "absent_from_full_list" && walkedWholeScope
          ? seenItemIds
          : stored?.seenItemIds,
      updatedAt: deps.now().toISOString(),
    });
  }

  return outcome;
}

interface ItemOutcome {
  emitted: number;
  unverifiable: number;
  indexed: number;
  removed: number;
  failure?: OimSyncFailureCode;
}

type AclOutcome =
  | { kind: "failed"; failure: "acl_failed" | "retry_required" }
  | { kind: "unverifiable" }
  | {
      kind: "verified";
      principals: readonly { readonly kind: string; readonly id: string }[];
      domains: readonly string[];
      public: boolean;
    };

async function readAcl(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  target: {
    readonly scope?: string;
    readonly itemId?: string;
    readonly fields?: Readonly<Record<string, KnowledgeItemFieldValue>>;
  }
): Promise<AclOutcome> {
  const parameters =
    plan.acl.mode === "item"
      ? fieldParameters(plan.acl.parameters, target.fields)
      : ({} as Record<string, unknown>);
  if (parameters === undefined) return { kind: "failed", failure: "acl_failed" };
  if (plan.acl.parameter !== undefined) {
    parameters[plan.acl.parameter] = plan.acl.mode === "item" ? target.itemId : target.scope;
  }
  let body: unknown;
  try {
    ({ body } = await deps.api.execute({ operationId: plan.acl.operation.id, parameters }));
    const mapped = await runOimHookPhase({
      manifest: plan.hooks === undefined ? {} : { hooks: plan.hooks },
      kind: "acl_map",
      input: {
        operationId: plan.acl.operation.id,
        ...(target.itemId === undefined ? {} : { itemId: target.itemId }),
        ...(target.scope === undefined ? {} : { scopeId: target.scope }),
        payload: body,
      },
      ...(deps.hookRunner === undefined ? {} : { runner: deps.hookRunner }),
    });
    if (mapped.executed) body = mapped.value;
  } catch (error) {
    return {
      kind: "failed",
      failure: isOimKnowledgeRetryRequiredError(error) ? "retry_required" : "acl_failed",
    };
  }

  let resolved: Awaited<ReturnType<typeof resolveKnowledgePrincipals>>;
  try {
    const read = mapAclEntries(plan, body);
    if (read.status === "unverifiable") return { kind: "unverifiable" };
    resolved = await resolveKnowledgePrincipals(read.entries as readonly ProviderAclEntry[], {
      ...deps.identity,
      businessId: options.businessId,
      provider: plan.integrationId,
    });
  } catch (error) {
    return {
      kind: "failed",
      failure: isOimKnowledgeRetryRequiredError(error) ? "retry_required" : "acl_failed",
    };
  }
  // A grant nothing could expand is a grant nobody can account for, so the item is recorded
  // without content rather than indexed under readers we only half know.
  if (resolved.incomplete) return { kind: "unverifiable" };
  return {
    kind: "verified",
    principals: resolved.principals,
    domains: resolved.domains,
    public: resolved.public,
  };
}

async function syncItem(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  scope: string,
  item: {
    readonly itemId: string;
    readonly fields?: Readonly<Record<string, KnowledgeItemFieldValue>>;
    readonly revision?: string;
    readonly sourceUrl?: string;
    readonly deleted: boolean;
  },
  scopeAcl: AclOutcome | undefined
): Promise<ItemOutcome> {
  const outcome: ItemOutcome = { emitted: 0, unverifiable: 0, indexed: 0, removed: 0 };
  const sourceId = sourceIdFor(plan, options, item.itemId);
  const capturedAt = deps.now().toISOString();
  const classification = options.classification ?? DEFAULTS.classification;
  const common = {
    sourceId,
    businessId: options.businessId,
    integrationId: options.integrationId,
    provider: plan.integrationId,
    externalId: item.itemId,
    externalTenantId: options.connectionId,
    ownerExternalId: scope,
    locator: {
      kind: "oim",
      integrationSlug: options.integrationId,
      integrationId: plan.integrationId,
      integrationMajorVersion: plan.majorVersion,
      connectionId: options.connectionId,
      sourceKindId: options.sourceKindId,
      scope,
      itemId: item.itemId,
      ...(item.fields === undefined ? {} : { fields: item.fields }),
      ...(item.sourceUrl === undefined ? {} : { sourceUrl: item.sourceUrl }),
    },
    classification,
    lastSyncedAt: capturedAt,
  } as const;
  const liveAccessControl = {
    mode: "live",
    maximumAgeSeconds: options.liveMaximumAgeSeconds ?? DEFAULTS.liveMaximumAgeSeconds,
  } as const;

  if (plan.deletion.kind === "list_flag" && item.deleted) {
    try {
      await deps.sink.emitSource({
        ...common,
        revision: item.revision ?? "0",
        status: "deleted",
        verification: "verified",
        accessControl: liveAccessControl,
        provenance: {
          capturedAt,
          contentHash: canonicalHash({ deleted: sourceId }),
          connectionId: options.connectionId,
        },
      });
      await deps.sink.removeSourceContent(options.businessId, sourceId);
    } catch {
      return { ...outcome, failure: "emit_failed" };
    }
    return { ...outcome, removed: 1 };
  }

  const acl =
    scopeAcl ??
    (await readAcl(plan, deps, options, {
      scope,
      itemId: item.itemId,
      fields: item.fields,
    }));
  if (acl.kind === "failed") return { ...outcome, failure: acl.failure };

  if (acl.kind === "unverifiable") {
    // The source stays recorded so it remains citable and invalidatable, but it holds no content
    // and denies on retrieval. Unreadable permissions are not absent permissions.
    try {
      await deps.sink.emitSource({
        ...common,
        revision: item.revision ?? "0",
        status: "active",
        verification: "unverifiable",
        accessControl: liveAccessControl,
        provenance: {
          capturedAt,
          contentHash: canonicalHash({ unverifiable: sourceId }),
          connectionId: options.connectionId,
        },
      });
      await deps.sink.removeSourceContent(options.businessId, sourceId);
    } catch {
      return { ...outcome, failure: "emit_failed" };
    }
    return { ...outcome, unverifiable: 1 };
  }

  let body: unknown;
  const contentParameters = fieldParameters(plan.content.parameters, item.fields);
  if (contentParameters === undefined) return { ...outcome, failure: "content_failed" };
  if (plan.content.itemParameter !== undefined) {
    contentParameters[plan.content.itemParameter] = item.itemId;
  }
  try {
    ({ body } = await deps.api.execute({
      operationId: plan.content.operation.id,
      parameters: contentParameters,
    }));
    const mapped = await runOimHookPhase({
      manifest: plan.hooks === undefined ? {} : { hooks: plan.hooks },
      kind: "content_map",
      input: {
        operationId: plan.content.operation.id,
        itemId: item.itemId,
        payload: body,
      },
      ...(deps.hookRunner === undefined ? {} : { runner: deps.hookRunner }),
    });
    if (mapped.executed) body = mapped.value;
  } catch (error) {
    return {
      ...outcome,
      failure: isOimKnowledgeRetryRequiredError(error) ? "retry_required" : "content_failed",
    };
  }
  const content = mapContent(plan, body);
  if (!content) return { ...outcome, failure: "content_absent" };

  const principals = acl.principals.map((principal) => ({
    kind: principal.kind,
    id: principal.id,
  }));
  const aclRevision = canonicalHash({
    itemId: item.itemId,
    principals,
    domains: acl.domains,
    public: acl.public,
  });
  // Sensitive content and providers that can be asked live are never served from a snapshot: an
  // old index entry must not outvote what the provider says about access right now.
  const live = plan.content.sensitive || plan.liveAuthorization !== undefined;
  const access = live
    ? { accessControl: liveAccessControl }
    : {
        accessControl: {
          mode: "snapshot" as const,
          aclRevision,
          maximumAgeSeconds: options.aclMaximumAgeSeconds ?? DEFAULTS.aclMaximumAgeSeconds,
        },
        acl: { aclRevision, capturedAt, principals },
      };

  const revision = content.revision ?? item.revision ?? aclRevision;
  const emission: KnowledgeSourceEmission = {
    ...common,
    locator: {
      ...common.locator,
      ...(content.sourceUrl === undefined ? {} : { sourceUrl: content.sourceUrl }),
    },
    ...access,
    revision,
    status: "active",
    verification: "verified",
    provenance: {
      capturedAt,
      contentHash: canonicalHash({ content: content.content }),
      checkpoint: revision,
      connectionId: options.connectionId,
    },
  };

  try {
    await deps.sink.emitSource(emission);
    await deps.sink.emitChunk({
      businessId: options.businessId,
      sourceId,
      chunkId: `${sourceId}#content`,
      revision,
      classification,
      digest: canonicalHash({ content: content.content }),
      text: content.content,
    });
  } catch {
    return { ...outcome, failure: "emit_failed" };
  }
  return { ...outcome, emitted: 1, indexed: 1 };
}

/**
 * Removes items the last complete walk saw and this one did not.
 *
 * Only ever run after a walk that reached the end of the scope. Half a walk means half the ids,
 * and deleting the difference then would empty the index of everything the provider paginated
 * past.
 */
async function removeAbsent(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  scope: string,
  previous: readonly string[] | undefined,
  seen: readonly string[],
  outcome: ScopeOutcome
): Promise<number> {
  if (previous === undefined) return 0;
  const present = new Set(seen);
  let removed = 0;
  for (const itemId of previous) {
    if (present.has(itemId)) continue;
    try {
      await deps.sink.removeSourceContent(options.businessId, sourceIdFor(plan, options, itemId));
      removed += 1;
    } catch {
      outcome.failures.push({ code: "emit_failed", scope, itemId });
    }
  }
  return removed;
}

/** Runs the declared deletion sweep. */
async function sweepDeletions(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  scope: string
): Promise<{ readonly removed: number; readonly failure?: OimSyncFailureCode }> {
  if (plan.deletion.kind !== "operation") return { removed: 0 };
  const parameters: Record<string, unknown> = {};
  if (plan.deletion.scopeParameter !== undefined) parameters[plan.deletion.scopeParameter] = scope;
  const declaredParameters = fieldParameters(
    plan.deletion.parameters,
    projectScopeFields(plan, scope)
  );
  if (declaredParameters === undefined) {
    return { removed: 0, failure: "deletion_sweep_failed" };
  }
  Object.assign(parameters, declaredParameters);

  let body: unknown;
  try {
    ({ body } = await deps.api.execute({ operationId: plan.deletion.operation.id, parameters }));
  } catch (error) {
    return {
      removed: 0,
      failure: isOimKnowledgeRetryRequiredError(error) ? "retry_required" : "deletion_sweep_failed",
    };
  }

  const raw = readPointer(body, plan.deletion.itemsPointer);
  if (!Array.isArray(raw)) return { removed: 0, failure: "deletion_sweep_failed" };

  let removed = 0;
  for (const candidate of raw) {
    const itemId = readPointer(candidate, plan.deletion.itemIdPointer);
    if (typeof itemId !== "string" && typeof itemId !== "number") continue;
    await deps.sink.removeSourceContent(
      options.businessId,
      sourceIdFor(plan, options, String(itemId))
    );
    removed += 1;
  }
  return { removed };
}

function fieldParameters(
  bindings: Readonly<Record<string, string>> | undefined,
  fields: Readonly<Record<string, KnowledgeItemFieldValue>> | undefined
): Record<string, unknown> | undefined {
  const parameters: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(bindings ?? {})) {
    if (fields === undefined || !Object.hasOwn(fields, field)) return undefined;
    const value = fields[field];
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      return undefined;
    }
    parameters[name] = value;
  }
  return parameters;
}

function projectScopeFields(
  plan: KnowledgeProfilePlan,
  scope: string
): Readonly<Record<string, KnowledgeItemFieldValue>> {
  const fields: Record<string, KnowledgeItemFieldValue> = {};
  for (const [name, field] of Object.entries(plan.list.mapping.itemFields ?? {})) {
    if (field.source === "scope") fields[name] = scope;
  }
  return fields;
}
