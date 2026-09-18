import { canonicalHash } from "@tulipfarm/schema";
import type {
  OimKnowledgeCheckpoint,
  OimKnowledgeCheckpointKey,
  OimKnowledgeChunkPublication,
  OimKnowledgeSourcePublication,
  PersistedConnection,
  PublishOimKnowledgeRevision,
  VerifiedConnectionExternalIdentity,
} from "@tulipfarm/storage";
import { readPointer } from "../egress/oim-pagination";
import {
  type KnowledgeItemFieldValue,
  mapAclEntries,
  mapContent,
  mapListItems,
  type ProviderAclEntry,
} from "./oim-mapping";
import type { KnowledgeProfilePlan } from "./oim-profile";

export interface OimKnowledgeConnectionScope {
  readonly businessId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
}

export interface OimKnowledgeExecutionScope extends OimKnowledgeConnectionScope {
  readonly externalTenantId: string;
  readonly externalAccountId: string;
}

export interface OimKnowledgeApiPort {
  /** Immutable Connection proof the host bound to this provider client. */
  readonly connection: OimKnowledgeExecutionScope;
  execute(input: {
    readonly operationId: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly pageToken?: string;
  }): Promise<{ readonly body: unknown; readonly nextPageToken?: string }>;
}

export interface OimKnowledgeCheckpointPort {
  load(key: OimKnowledgeCheckpointKey): Promise<OimKnowledgeCheckpoint | null>;
  claim(
    key: OimKnowledgeCheckpointKey,
    scanId: string,
    leaseToken: string,
    leaseSeconds: number,
    now?: Date
  ): Promise<OimKnowledgeCheckpoint | null>;
  appendPage(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    continuation: string | null,
    seenItemIds: readonly string[],
    now?: Date,
    pendingCursorWatermark?: string
  ): Promise<OimKnowledgeCheckpoint | null>;
  stageCompletion(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    pendingDeletionItemIds: readonly string[],
    now?: Date
  ): Promise<OimKnowledgeCheckpoint | null>;
  acknowledgeDeletions(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    deletedItemIds: readonly string[],
    now?: Date
  ): Promise<OimKnowledgeCheckpoint | null>;
  complete(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    now?: Date,
    listingMode?: "full" | "incremental",
    rebuild?: boolean
  ): Promise<OimKnowledgeCheckpoint | null>;
  release(
    key: OimKnowledgeCheckpointKey,
    leaseToken: string,
    expectedRevision: number,
    now?: Date
  ): Promise<OimKnowledgeCheckpoint | null>;
}

export interface OimKnowledgePublicationPort {
  claimConnection(input: OimKnowledgeExecutionScope): Promise<
    | (OimKnowledgeExecutionScope & {
        readonly connectionGeneration: number;
      })
    | null
  >;
  find(
    businessId: string,
    sourceId: string
  ): Promise<
    | (Pick<
        OimKnowledgeSourcePublication,
        "businessId" | "sourceId" | "integrationId" | "revision"
      > & {
        readonly integrationMajorVersion: number | null;
        readonly connectionId: string | null;
        readonly sourceLocator: Readonly<Record<string, unknown>> | null;
      })
    | null
  >;
  publish(input: PublishOimKnowledgeRevision): Promise<boolean>;
  quarantineSource(input: {
    readonly claim: PublishOimKnowledgeRevision["claim"];
    readonly businessId: string;
    readonly sourceId: string;
    readonly expectedRevision: string;
    readonly quarantinedRevision: string;
    readonly quarantinedAt: string;
  }): Promise<boolean>;
  quarantineScope(
    input: OimKnowledgeConnectionScope & {
      readonly claim: PublishOimKnowledgeRevision["claim"];
      readonly sourceKindId: string;
      readonly scope: string;
      readonly quarantinedRevisionPrefix: string;
      readonly quarantinedAt: string;
    }
  ): Promise<readonly string[] | null>;
  quarantineInvalidConnection(
    input: OimKnowledgeConnectionScope & {
      readonly deletedRevisionPrefix: string;
      readonly deletedAt: string;
    }
  ): Promise<readonly string[] | null>;
  markDeleted(input: {
    readonly claim: PublishOimKnowledgeRevision["claim"];
    readonly businessId: string;
    readonly sourceId: string;
    readonly expectedRevision: string;
    readonly deletedRevision: string;
    readonly deletedAt: string;
  }): Promise<boolean>;
}

export interface OimKnowledgeIdentityPort {
  resolve(
    input: OimKnowledgeConnectionScope & {
      readonly externalTenantId: string;
      readonly externalAccountId: string;
      readonly entries: readonly ProviderAclEntry[];
    }
  ): Promise<{
    readonly principals: readonly Readonly<{ kind: string; id: string }>[];
    readonly incomplete: boolean;
  }>;
}

export interface OimKnowledgeSyncDeps {
  readonly api: OimKnowledgeApiPort;
  readonly checkpoints: OimKnowledgeCheckpointPort;
  readonly publications: OimKnowledgePublicationPort;
  readonly connections: {
    findById(businessId: string, connectionId: string): Promise<PersistedConnection | null>;
  };
  readonly connectionIdentities: {
    find(
      businessId: string,
      connectionId: string
    ): Promise<VerifiedConnectionExternalIdentity | null>;
  };
  readonly identity: OimKnowledgeIdentityPort;
  readonly now: () => Date;
  readonly newId: () => string;
}

export interface OimKnowledgeSyncOptions {
  readonly businessId: string;
  readonly integrationSlug: string;
  readonly connectionId: string;
  readonly sourceKindId: string;
  readonly scopes: readonly string[];
  readonly classification?: readonly string[];
  readonly aclMaximumAgeSeconds?: number;
  readonly liveMaximumAgeSeconds?: number;
  readonly leaseSeconds?: number;
}

export type OimSyncFailureCode =
  | "connection_identity_unverified"
  | "connection_conflict"
  | "checkpoint_conflict"
  | "list_failed"
  | "mapping_failed"
  | "acl_failed"
  | "content_failed"
  | "content_absent"
  | "publication_conflict"
  | "quarantine_failed"
  | "deletion_failed";

export interface OimSyncFailure {
  readonly code: OimSyncFailureCode;
  readonly scope: string;
  readonly itemId?: string;
}

export interface OimKnowledgeSyncResult {
  readonly scopesProcessed: number;
  readonly itemsProcessed: number;
  readonly published: number;
  readonly quarantined: number;
  readonly deleted: number;
  readonly failures: readonly OimSyncFailure[];
}

interface ScopeOutcome {
  items: number;
  published: number;
  quarantined: number;
  deleted: number;
  failures: OimSyncFailure[];
}

const DEFAULT_CLASSIFICATION = ["internal"] as const;
const DEFAULT_ACL_MAXIMUM_AGE_SECONDS = 900;
const DEFAULT_LIVE_MAXIMUM_AGE_SECONDS = 60;
const DEFAULT_LEASE_SECONDS = 300;

function sourceIdFor(plan: KnowledgeProfilePlan, connectionId: string, itemId: string): string {
  return `${plan.integrationId}:${connectionId}/${itemId}`;
}

function belongsToSelectedSource(
  source: Awaited<ReturnType<OimKnowledgePublicationPort["find"]>>,
  plan: KnowledgeProfilePlan,
  options: OimKnowledgeSyncOptions,
  identity: VerifiedConnectionExternalIdentity,
  scope: string,
  itemId: string
): boolean {
  if (source === null) return false;
  const locator = source.sourceLocator;
  return (
    source.integrationId === plan.integrationId &&
    source.integrationMajorVersion === plan.majorVersion &&
    source.connectionId === options.connectionId &&
    locator !== null &&
    locator.kind === "oim" &&
    locator.integrationSlug === options.integrationSlug &&
    locator.integrationId === plan.integrationId &&
    locator.integrationMajorVersion === plan.majorVersion &&
    locator.connectionId === options.connectionId &&
    locator.externalTenantId === identity.externalTenantId &&
    locator.externalAccountId === identity.externalAccountId &&
    locator.sourceKindId === options.sourceKindId &&
    locator.scope === scope &&
    locator.itemId === itemId
  );
}

function connectionScope(
  plan: KnowledgeProfilePlan,
  options: OimKnowledgeSyncOptions
): OimKnowledgeConnectionScope {
  return {
    businessId: options.businessId,
    integrationId: plan.integrationId,
    integrationMajorVersion: plan.majorVersion,
    connectionId: options.connectionId,
  };
}

function checkpointKey(
  plan: KnowledgeProfilePlan,
  options: OimKnowledgeSyncOptions,
  scope: string
): OimKnowledgeCheckpointKey {
  return {
    ...connectionScope(plan, options),
    sourceKind: options.sourceKindId,
    scope,
  };
}

function matchesSelectedConnection(
  connection: PersistedConnection | null,
  identity: VerifiedConnectionExternalIdentity | null,
  scope: OimKnowledgeConnectionScope,
  now: Date
): identity is VerifiedConnectionExternalIdentity {
  return (
    connection !== null &&
    identity !== null &&
    connection.businessId === scope.businessId &&
    connection.id === scope.connectionId &&
    connection.integration.id === scope.integrationId &&
    connection.integration.majorVersion === scope.integrationMajorVersion &&
    connection.status === "active" &&
    connection.health.status !== "action_required" &&
    (connection.expiresAt === null || new Date(connection.expiresAt) > now) &&
    identity.businessId === scope.businessId &&
    identity.connectionId === scope.connectionId &&
    identity.integrationId === scope.integrationId &&
    identity.integrationMajorVersion === scope.integrationMajorVersion &&
    identity.externalTenantId.length > 0 &&
    identity.externalAccountId.length > 0
  );
}

function matchesApiConnection(
  api: OimKnowledgeApiPort,
  scope: OimKnowledgeConnectionScope,
  identity: VerifiedConnectionExternalIdentity
): boolean {
  const bound = api.connection;
  return (
    bound.businessId === scope.businessId &&
    bound.integrationId === scope.integrationId &&
    bound.integrationMajorVersion === scope.integrationMajorVersion &&
    bound.connectionId === scope.connectionId &&
    bound.externalTenantId === identity.externalTenantId &&
    bound.externalAccountId === identity.externalAccountId
  );
}

export async function syncOimKnowledge(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions
): Promise<OimKnowledgeSyncResult> {
  const scopeIdentity = connectionScope(plan, options);
  let connection: PersistedConnection | null = null;
  let identity: VerifiedConnectionExternalIdentity | null = null;
  try {
    [connection, identity] = await Promise.all([
      deps.connections.findById(options.businessId, options.connectionId),
      deps.connectionIdentities.find(options.businessId, options.connectionId),
    ]);
  } catch {
    // A proof-store outage is indistinguishable from an unverified Connection at this boundary.
  }
  if (
    !matchesSelectedConnection(connection, identity, scopeIdentity, deps.now()) ||
    (identity !== null && !matchesApiConnection(deps.api, scopeIdentity, identity))
  ) {
    const failures: OimSyncFailure[] = [];
    let quarantined = 0;
    try {
      const quarantinedSourceIds = await deps.publications.quarantineInvalidConnection({
        ...scopeIdentity,
        deletedRevisionPrefix: `quarantine:${deps.newId()}`,
        deletedAt: deps.now().toISOString(),
      });
      for (const scope of options.scopes) {
        failures.push({
          code:
            quarantinedSourceIds === null
              ? "connection_conflict"
              : "connection_identity_unverified",
          scope,
        });
      }
      quarantined = quarantinedSourceIds?.length ?? 0;
    } catch {
      for (const scope of options.scopes) {
        failures.push({ code: "quarantine_failed", scope });
      }
    }
    return {
      scopesProcessed: options.scopes.length,
      itemsProcessed: 0,
      published: 0,
      quarantined,
      deleted: 0,
      failures,
    };
  }

  const total = { items: 0, published: 0, quarantined: 0, deleted: 0 };
  const failures: OimSyncFailure[] = [];
  let connectionClaim: OimKnowledgeExecutionScope & {
    readonly connectionGeneration: number;
  };
  try {
    const claimed = await deps.publications.claimConnection({
      ...scopeIdentity,
      externalTenantId: identity.externalTenantId,
      externalAccountId: identity.externalAccountId,
    });
    if (claimed === null) throw new Error("oim_knowledge_connection_fenced");
    connectionClaim = claimed;
  } catch {
    for (const scope of options.scopes) {
      failures.push({ code: "connection_identity_unverified", scope });
    }
    return {
      scopesProcessed: options.scopes.length,
      itemsProcessed: 0,
      published: 0,
      quarantined: 0,
      deleted: 0,
      failures,
    };
  }
  for (const scope of options.scopes) {
    const outcome = await syncScope(plan, deps, options, identity, connectionClaim, scope);
    total.items += outcome.items;
    total.published += outcome.published;
    total.quarantined += outcome.quarantined;
    total.deleted += outcome.deleted;
    failures.push(...outcome.failures);
  }
  return {
    scopesProcessed: options.scopes.length,
    itemsProcessed: total.items,
    published: total.published,
    quarantined: total.quarantined,
    deleted: total.deleted,
    failures,
  };
}

async function syncScope(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  identity: VerifiedConnectionExternalIdentity,
  connectionClaim: OimKnowledgeExecutionScope & { readonly connectionGeneration: number },
  scope: string
): Promise<ScopeOutcome> {
  const outcome: ScopeOutcome = {
    items: 0,
    published: 0,
    quarantined: 0,
    deleted: 0,
    failures: [],
  };

  const key = checkpointKey(plan, options, scope);
  const stored = await deps.checkpoints.load(key);
  const scanId = stored?.scanId ?? deps.newId();
  const leaseToken = deps.newId();
  let checkpoint = await deps.checkpoints.claim(
    key,
    scanId,
    leaseToken,
    options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    deps.now()
  );
  if (checkpoint === null) {
    outcome.failures.push({ code: "checkpoint_conflict", scope });
    return outcome;
  }

  let incrementalCursor:
    | { readonly pointer: string; readonly requestParameter: string }
    | undefined;
  if (plan.list.cursor.kind === "response_pointer") {
    const { pointer, requestParameter } = plan.list.cursor;
    if (pointer === undefined || requestParameter === undefined) {
      outcome.failures.push({ code: "mapping_failed", scope });
      await deps.checkpoints.release(key, leaseToken, checkpoint.revision, deps.now());
      return outcome;
    }
    incrementalCursor = { pointer, requestParameter };
  }

  if (checkpoint.pendingDeletionItemIds.length > 0) {
    const afterDeletions = await finishDeletions(
      plan,
      deps,
      options,
      identity,
      connectionClaim,
      scope,
      key,
      leaseToken,
      checkpoint,
      outcome
    );
    if (afterDeletions === null) return outcome;
    checkpoint = afterDeletions;
    if (!checkpoint.requiresFullRebuild) {
      if (
        (await deps.checkpoints.complete(
          key,
          leaseToken,
          checkpoint.revision,
          deps.now(),
          plan.list.cursor.kind === "response_pointer" ? "incremental" : "full"
        )) === null
      ) {
        outcome.failures.push({ code: "checkpoint_conflict", scope });
      }
      return outcome;
    }
  }

  let scopeAcl: AclOutcome | undefined;
  if (plan.acl.mode === "scope") {
    scopeAcl = await readAcl(plan, deps, options, identity, { scope });
    if (scopeAcl.kind !== "verified") {
      const publicationClaim = claimForCheckpoint(connectionClaim, options, scope, checkpoint);
      if (publicationClaim === null) {
        outcome.failures.push({ code: "checkpoint_conflict", scope });
      } else {
        await quarantineScope(
          plan,
          deps,
          options,
          scope,
          outcome,
          scopeAcl.failure,
          publicationClaim
        );
      }
      await deps.checkpoints.release(key, leaseToken, checkpoint.revision, deps.now());
      return outcome;
    }
  }

  let pageToken = checkpoint.continuation ?? undefined;
  for (let page = 0; page < plan.list.maxPagesPerRun; page += 1) {
    const parameters: Record<string, unknown> = {};
    if (plan.list.scopeParameter !== undefined) parameters[plan.list.scopeParameter] = scope;
    if (
      incrementalCursor !== undefined &&
      !checkpoint.requiresFullRebuild &&
      checkpoint.cursorWatermark !== null
    ) {
      parameters[incrementalCursor.requestParameter] = checkpoint.cursorWatermark;
    }
    let response: Awaited<ReturnType<OimKnowledgeApiPort["execute"]>>;
    try {
      response = await deps.api.execute({
        operationId: plan.list.operation.id,
        parameters,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
    } catch {
      outcome.failures.push({ code: "list_failed", scope });
      await deps.checkpoints.release(key, leaseToken, checkpoint.revision, deps.now());
      return outcome;
    }

    let items: ReturnType<typeof mapListItems>;
    let pendingCursorWatermark: string | undefined;
    try {
      items = mapListItems(plan, response.body, scope);
      pendingCursorWatermark =
        incrementalCursor === undefined
          ? undefined
          : mapResponseWatermark(response.body, incrementalCursor.pointer);
    } catch {
      outcome.failures.push({ code: "mapping_failed", scope });
      await deps.checkpoints.release(key, leaseToken, checkpoint.revision, deps.now());
      return outcome;
    }

    let checkpointBlocked = false;
    if (checkpoint.scanId === null || checkpoint.leaseToken === null) {
      outcome.failures.push({ code: "checkpoint_conflict", scope });
      return outcome;
    }
    const publicationClaim = claimForCheckpoint(connectionClaim, options, scope, checkpoint);
    if (publicationClaim === null) {
      outcome.failures.push({ code: "checkpoint_conflict", scope });
      return outcome;
    }
    for (const item of items) {
      outcome.items += 1;
      const result = await syncItem(
        plan,
        deps,
        options,
        identity,
        scope,
        item,
        scopeAcl,
        publicationClaim
      );
      outcome.published += result.published;
      outcome.quarantined += result.quarantined;
      outcome.deleted += result.deleted;
      if (result.failure !== undefined) {
        outcome.failures.push({ code: result.failure, scope, itemId: item.itemId });
        checkpointBlocked = true;
      }
    }
    if (checkpointBlocked) {
      await deps.checkpoints.release(key, leaseToken, checkpoint.revision, deps.now());
      return outcome;
    }

    checkpoint = await deps.checkpoints.appendPage(
      key,
      leaseToken,
      checkpoint.revision,
      response.nextPageToken ?? null,
      items.map((item) => item.itemId),
      deps.now(),
      pendingCursorWatermark
    );
    if (checkpoint === null) {
      outcome.failures.push({ code: "checkpoint_conflict", scope });
      return outcome;
    }
    pageToken = response.nextPageToken;
    if (pageToken === undefined) break;
  }

  if (pageToken !== undefined) {
    await deps.checkpoints.release(key, leaseToken, checkpoint.revision, deps.now());
    return outcome;
  }

  const pending = await deletionCandidates(plan, deps, scope, checkpoint);
  if (pending === undefined) {
    outcome.failures.push({ code: "mapping_failed", scope });
    await deps.checkpoints.release(key, leaseToken, checkpoint.revision, deps.now());
    return outcome;
  }
  checkpoint = await deps.checkpoints.stageCompletion(
    key,
    leaseToken,
    checkpoint.revision,
    pending,
    deps.now()
  );
  if (checkpoint === null) {
    outcome.failures.push({ code: "checkpoint_conflict", scope });
    return outcome;
  }
  const afterDeletions = await finishDeletions(
    plan,
    deps,
    options,
    identity,
    connectionClaim,
    scope,
    key,
    leaseToken,
    checkpoint,
    outcome
  );
  if (afterDeletions === null) return outcome;
  if (
    (await deps.checkpoints.complete(
      key,
      leaseToken,
      afterDeletions.revision,
      deps.now(),
      plan.list.cursor.kind === "response_pointer" ? "incremental" : "full",
      afterDeletions.requiresFullRebuild
    )) === null
  ) {
    outcome.failures.push({ code: "checkpoint_conflict", scope });
  }
  return outcome;
}

function claimForCheckpoint(
  connectionClaim: OimKnowledgeExecutionScope & { readonly connectionGeneration: number },
  options: OimKnowledgeSyncOptions,
  scope: string,
  checkpoint: OimKnowledgeCheckpoint
): PublishOimKnowledgeRevision["claim"] | null {
  if (checkpoint.scanId === null || checkpoint.leaseToken === null) return null;
  return {
    ...connectionClaim,
    sourceKindId: options.sourceKindId,
    scope,
    scanId: checkpoint.scanId,
    leaseToken: checkpoint.leaseToken,
    checkpointRevision: checkpoint.revision,
  };
}

type AclOutcome =
  | {
      readonly kind: "verified";
      readonly principals: readonly Readonly<{ kind: string; id: string }>[];
    }
  | { readonly kind: "failed"; readonly failure: "acl_failed" };

async function readCompletePages(
  deps: OimKnowledgeSyncDeps,
  operationId: string,
  parameters: Readonly<Record<string, unknown>>,
  maximumPages: number
): Promise<readonly unknown[]> {
  const bodies: unknown[] = [];
  const continuations = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < maximumPages; page += 1) {
    const result = await deps.api.execute({
      operationId,
      parameters,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    bodies.push(result.body);
    if (result.nextPageToken === undefined) return bodies;
    if (continuations.has(result.nextPageToken)) throw new Error("pagination_cycle");
    continuations.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
  throw new Error("pagination_bound_exceeded");
}

async function readAcl(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  identity: VerifiedConnectionExternalIdentity,
  target: {
    readonly scope: string;
    readonly itemId?: string;
    readonly fields?: Readonly<Record<string, KnowledgeItemFieldValue>>;
  }
): Promise<AclOutcome> {
  const parameters =
    plan.acl.mode === "item" ? fieldParameters(plan.acl.parameters, target.fields) : {};
  if (parameters === undefined) return { kind: "failed", failure: "acl_failed" };
  if (plan.acl.parameter !== undefined) {
    parameters[plan.acl.parameter] = plan.acl.mode === "item" ? target.itemId : target.scope;
  }
  try {
    const bodies = await readCompletePages(
      deps,
      plan.acl.operation.id,
      parameters,
      plan.list.maxPagesPerRun
    );
    const entries: ProviderAclEntry[] = [];
    for (const body of bodies) {
      const mapped = mapAclEntries(plan, body);
      if (mapped.status !== "verified") return { kind: "failed", failure: "acl_failed" };
      entries.push(...mapped.entries);
    }
    const resolved = await deps.identity.resolve({
      ...connectionScope(plan, options),
      externalTenantId: identity.externalTenantId,
      externalAccountId: identity.externalAccountId,
      entries,
    });
    if (resolved.incomplete) return { kind: "failed", failure: "acl_failed" };
    return { kind: "verified", principals: resolved.principals };
  } catch {
    return { kind: "failed", failure: "acl_failed" };
  }
}

interface ItemOutcome {
  readonly published: number;
  readonly quarantined: number;
  readonly deleted: number;
  readonly failure?: OimSyncFailureCode;
}

async function syncItem(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  identity: VerifiedConnectionExternalIdentity,
  scope: string,
  item: {
    readonly itemId: string;
    readonly fields?: Readonly<Record<string, KnowledgeItemFieldValue>>;
    readonly revision?: string;
    readonly sourceUrl?: string;
    readonly deleted: boolean;
  },
  scopeAcl: AclOutcome | undefined,
  publicationClaim: PublishOimKnowledgeRevision["claim"]
): Promise<ItemOutcome> {
  const sourceId = sourceIdFor(plan, options.connectionId, item.itemId);
  if (plan.deletion.kind === "list_flag" && item.deleted) {
    return deleteOne(plan, deps, options, identity, scope, item.itemId, publicationClaim);
  }

  const acl =
    scopeAcl ??
    (await readAcl(plan, deps, options, identity, {
      scope,
      itemId: item.itemId,
      ...(item.fields === undefined ? {} : { fields: item.fields }),
    }));
  if (acl.kind !== "verified") {
    return failClosedItem(
      plan,
      deps,
      options,
      identity,
      scope,
      sourceId,
      item.itemId,
      acl.failure,
      publicationClaim
    );
  }

  const parameters = fieldParameters(plan.content.parameters, item.fields);
  if (parameters === undefined) {
    return failClosedItem(
      plan,
      deps,
      options,
      identity,
      scope,
      sourceId,
      item.itemId,
      "content_failed",
      publicationClaim
    );
  }
  if (plan.content.itemParameter !== undefined)
    parameters[plan.content.itemParameter] = item.itemId;
  let content: ReturnType<typeof mapContent>;
  try {
    const response = await deps.api.execute({
      operationId: plan.content.operation.id,
      parameters,
    });
    content = mapContent(plan, response.body);
  } catch {
    return failClosedItem(
      plan,
      deps,
      options,
      identity,
      scope,
      sourceId,
      item.itemId,
      "content_failed",
      publicationClaim
    );
  }
  if (content === undefined) {
    return failClosedItem(
      plan,
      deps,
      options,
      identity,
      scope,
      sourceId,
      item.itemId,
      "content_absent",
      publicationClaim
    );
  }

  const now = deps.now().toISOString();
  const revision = content.revision ?? item.revision ?? canonicalHash({ content: content.content });
  const aclRevision = canonicalHash({ principals: acl.principals });
  const live = plan.content.sensitive || plan.liveAuthorization !== undefined;
  const current = await deps.publications.find(options.businessId, sourceId);
  if (
    current !== null &&
    !belongsToSelectedSource(current, plan, options, identity, scope, item.itemId)
  ) {
    return { published: 0, quarantined: 0, deleted: 0, failure: "publication_conflict" };
  }
  const source: OimKnowledgeSourcePublication = {
    businessId: options.businessId,
    sourceId,
    integrationId: plan.integrationId,
    integrationMajorVersion: plan.majorVersion,
    provider: plan.integrationId,
    externalId: item.itemId,
    externalTenantId: identity.externalTenantId,
    ownerExternalId: identity.externalAccountId,
    sourceLocator: {
      kind: "oim",
      integrationSlug: options.integrationSlug,
      integrationId: plan.integrationId,
      integrationMajorVersion: plan.majorVersion,
      connectionId: options.connectionId,
      externalTenantId: identity.externalTenantId,
      externalAccountId: identity.externalAccountId,
      sourceKindId: options.sourceKindId,
      scope,
      itemId: item.itemId,
      ...(item.fields === undefined ? {} : { fields: item.fields }),
      ...((content.sourceUrl ?? item.sourceUrl) === undefined
        ? {}
        : { sourceUrl: content.sourceUrl ?? item.sourceUrl }),
    },
    revision,
    classification: options.classification ?? DEFAULT_CLASSIFICATION,
    verification: "verified",
    accessControlMode: live ? "live" : "snapshot",
    accessControlMaximumAgeSeconds: live
      ? (options.liveMaximumAgeSeconds ?? DEFAULT_LIVE_MAXIMUM_AGE_SECONDS)
      : (options.aclMaximumAgeSeconds ?? DEFAULT_ACL_MAXIMUM_AGE_SECONDS),
    aclRevision: live ? null : aclRevision,
    aclCapturedAt: live ? null : now,
    aclPrincipals: live ? null : acl.principals,
    provenanceCapturedAt: now,
    provenanceContentHash: canonicalHash({ content: content.content }),
    provenanceCheckpoint: revision,
    provenanceConnectionId: options.connectionId,
    lastSyncedAt: now,
  };
  const chunk: OimKnowledgeChunkPublication = {
    chunkId: `${sourceId}#content`,
    revision,
    classification: source.classification,
    digest: source.provenanceContentHash,
    content: content.content,
  };
  const published = await deps.publications.publish({
    ...(current === null ? {} : { expectedRevision: current.revision }),
    claim: publicationClaim,
    source,
    chunks: [chunk],
  });
  return published
    ? { published: 1, quarantined: 0, deleted: 0 }
    : { published: 0, quarantined: 0, deleted: 0, failure: "publication_conflict" };
}

async function failClosedItem(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  identity: VerifiedConnectionExternalIdentity,
  scope: string,
  sourceId: string,
  itemId: string,
  failure: "acl_failed" | "content_failed" | "content_absent",
  publicationClaim: PublishOimKnowledgeRevision["claim"]
): Promise<ItemOutcome> {
  try {
    const source = await deps.publications.find(options.businessId, sourceId);
    if (source === null) {
      return { published: 0, quarantined: 0, deleted: 0, failure };
    }
    if (!belongsToSelectedSource(source, plan, options, identity, scope, itemId)) {
      return { published: 0, quarantined: 0, deleted: 0, failure: "quarantine_failed" };
    }
    const quarantined = await deps.publications.quarantineSource({
      claim: publicationClaim,
      businessId: options.businessId,
      sourceId,
      expectedRevision: source.revision,
      quarantinedRevision: canonicalHash({
        kind: "quarantine",
        sourceId,
        itemId,
        previousRevision: source.revision,
        nonce: deps.newId(),
      }),
      quarantinedAt: deps.now().toISOString(),
    });
    return quarantined
      ? { published: 0, quarantined: 1, deleted: 0, failure }
      : { published: 0, quarantined: 0, deleted: 0, failure: "quarantine_failed" };
  } catch {
    return { published: 0, quarantined: 0, deleted: 0, failure: "quarantine_failed" };
  }
}

async function quarantineScope(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  scope: string,
  outcome: ScopeOutcome,
  failure: "acl_failed",
  publicationClaim: PublishOimKnowledgeRevision["claim"]
): Promise<void> {
  try {
    const quarantined = await deps.publications.quarantineScope({
      claim: publicationClaim,
      ...connectionScope(plan, options),
      sourceKindId: options.sourceKindId,
      scope,
      quarantinedRevisionPrefix: `quarantine:${deps.newId()}`,
      quarantinedAt: deps.now().toISOString(),
    });
    if (quarantined === null) {
      outcome.failures.push({ code: "checkpoint_conflict", scope });
      return;
    }
    outcome.quarantined += quarantined.length;
    outcome.failures.push({ code: failure, scope });
  } catch {
    outcome.failures.push({ code: "quarantine_failed", scope });
  }
}

async function deletionCandidates(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  scope: string,
  checkpoint: OimKnowledgeCheckpoint
): Promise<readonly string[] | undefined> {
  if (plan.deletion.kind === "absent_from_full_list") {
    if (plan.list.cursor.kind === "response_pointer" && !checkpoint.requiresFullRebuild) return [];
    const seen = new Set(checkpoint.accumulatedSeenItemIds);
    return checkpoint.baselineItemIds.filter((itemId) => !seen.has(itemId));
  }
  if (plan.deletion.kind !== "operation") return [];
  const parameters = fieldParameters(plan.deletion.parameters, projectScopeFields(plan, scope));
  if (parameters === undefined) return undefined;
  if (plan.deletion.scopeParameter !== undefined) {
    parameters[plan.deletion.scopeParameter] = scope;
  }
  let bodies: readonly unknown[];
  try {
    bodies = await readCompletePages(
      deps,
      plan.deletion.operation.id,
      parameters,
      plan.list.maxPagesPerRun
    );
  } catch {
    return undefined;
  }
  const ids: string[] = [];
  for (const body of bodies) {
    const items = readPointer(body, plan.deletion.itemsPointer);
    if (!Array.isArray(items)) return undefined;
    for (const item of items) {
      const value = readPointer(item, plan.deletion.itemIdPointer);
      if (typeof value !== "string" && typeof value !== "number") return undefined;
      ids.push(String(value));
    }
  }
  return [...new Set(ids)];
}

async function finishDeletions(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  identity: VerifiedConnectionExternalIdentity,
  connectionClaim: OimKnowledgeExecutionScope & { readonly connectionGeneration: number },
  scope: string,
  key: OimKnowledgeCheckpointKey,
  leaseToken: string,
  initial: OimKnowledgeCheckpoint,
  outcome: ScopeOutcome
): Promise<OimKnowledgeCheckpoint | null> {
  let checkpoint = initial;
  const publicationClaim = claimForCheckpoint(connectionClaim, options, scope, checkpoint);
  if (publicationClaim === null) {
    outcome.failures.push({ code: "checkpoint_conflict", scope });
    return null;
  }
  const deleted: string[] = [];
  for (const itemId of checkpoint.pendingDeletionItemIds) {
    const result = await deleteOne(plan, deps, options, identity, scope, itemId, publicationClaim);
    if (result.failure !== undefined) {
      outcome.failures.push({ code: result.failure, scope, itemId });
      continue;
    }
    outcome.deleted += result.deleted;
    deleted.push(itemId);
  }
  if (deleted.length > 0) {
    const acknowledged = await deps.checkpoints.acknowledgeDeletions(
      key,
      leaseToken,
      checkpoint.revision,
      deleted,
      deps.now()
    );
    if (acknowledged === null) {
      outcome.failures.push({ code: "checkpoint_conflict", scope });
      return null;
    }
    checkpoint = acknowledged;
  }
  if (checkpoint.pendingDeletionItemIds.length > 0) {
    await deps.checkpoints.release(key, leaseToken, checkpoint.revision, deps.now());
    return null;
  }
  return checkpoint;
}

async function deleteOne(
  plan: KnowledgeProfilePlan,
  deps: OimKnowledgeSyncDeps,
  options: OimKnowledgeSyncOptions,
  identity: VerifiedConnectionExternalIdentity,
  scope: string,
  itemId: string,
  publicationClaim: PublishOimKnowledgeRevision["claim"]
): Promise<ItemOutcome> {
  try {
    const sourceId = sourceIdFor(plan, options.connectionId, itemId);
    const source = await deps.publications.find(options.businessId, sourceId);
    if (source === null) return { published: 0, quarantined: 0, deleted: 0 };
    if (!belongsToSelectedSource(source, plan, options, identity, scope, itemId)) {
      return { published: 0, quarantined: 0, deleted: 0, failure: "deletion_failed" };
    }
    const deleted = await deps.publications.markDeleted({
      claim: publicationClaim,
      businessId: options.businessId,
      sourceId,
      expectedRevision: source.revision,
      deletedRevision: canonicalHash({
        kind: "deleted",
        sourceId,
        previousRevision: source.revision,
        nonce: deps.newId(),
      }),
      deletedAt: deps.now().toISOString(),
    });
    return deleted
      ? { published: 0, quarantined: 0, deleted: 1 }
      : { published: 0, quarantined: 0, deleted: 0, failure: "deletion_failed" };
  } catch {
    return { published: 0, quarantined: 0, deleted: 0, failure: "deletion_failed" };
  }
}

function mapResponseWatermark(response: unknown, pointer: string): string {
  const value = readPointer(response, pointer);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error("invalid_oim_knowledge_cursor_watermark");
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
  return Object.fromEntries(
    Object.entries(plan.list.mapping.itemFields ?? {}).flatMap(([name, field]) =>
      field.source === "scope" ? [[name, scope]] : []
    )
  );
}
