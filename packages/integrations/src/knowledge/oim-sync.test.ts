import type {
  OimKnowledgeCheckpoint,
  OimKnowledgeCheckpointKey,
  OimKnowledgeSourcePublication,
  PublishOimKnowledgeRevision,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import type { KnowledgeProfilePlan } from "./oim-profile";
import {
  type OimKnowledgeExecutionScope,
  type OimKnowledgeSyncDeps,
  type OimKnowledgeSyncOptions,
  syncOimKnowledge,
} from "./oim-sync";

const NOW = new Date("2026-09-13T10:00:00.000Z");

function operation(id: string): KnowledgeProfilePlan["list"]["operation"] {
  return {
    id,
    name: id.replaceAll("-", "_"),
    description: id,
    effect: "read",
    identityMode: "shared_only",
    source: {
      type: "http",
      method: "GET",
      baseUrl: "https://wiki.example",
      path: `/${id}`,
      parameters: [],
    },
    response: { schema: { type: "object" }, maxBytes: 1_048_576 },
  };
}

function plan(
  overrides: Partial<Pick<KnowledgeProfilePlan, "acl" | "deletion">> = {}
): KnowledgeProfilePlan {
  return {
    integrationId: "wiki",
    integrationVersion: "2.1.0",
    majorVersion: 2,
    sourceKinds: [{ id: "page", label: "Page" }],
    list: {
      operation: operation("list"),
      scopeParameter: "space",
      itemsPointer: "/items",
      mapping: { itemId: "/id", revision: "/revision" },
      cursor: { kind: "operation_pagination" },
      maxPagesPerRun: 1,
    },
    content: {
      operation: operation("content"),
      itemParameter: "id",
      mapping: { content: "/content", revision: "/revision" },
      sensitive: false,
    },
    acl: overrides.acl ?? {
      mode: "item",
      operation: operation("acl"),
      parameter: "id",
      entriesPointer: "/readers",
      entry: { defaultKind: "user", providerUserId: "/id" },
    },
    deletion: overrides.deletion ?? { kind: "absent_from_full_list" },
  };
}

function options(): OimKnowledgeSyncOptions {
  return {
    businessId: "business-1",
    integrationSlug: "wiki-install",
    connectionId: "connection-1",
    sourceKindId: "page",
    scopes: ["space-1"],
  };
}

function checkpoint(overrides: Partial<OimKnowledgeCheckpoint> = {}): OimKnowledgeCheckpoint {
  return {
    businessId: "business-1",
    integrationId: "wiki",
    integrationMajorVersion: 2,
    connectionId: "connection-1",
    sourceKind: "page",
    scope: "space-1",
    baselineItemIds: [],
    scanId: null,
    continuation: null,
    accumulatedSeenItemIds: [],
    pendingDeletionItemIds: [],
    cursorWatermark: null,
    pendingCursorWatermark: null,
    requiresFullRebuild: false,
    revision: 1,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

class MemoryCheckpoints {
  value: OimKnowledgeCheckpoint | null;

  constructor(value: OimKnowledgeCheckpoint | null = null) {
    this.value = value;
  }

  async load(): Promise<OimKnowledgeCheckpoint | null> {
    return this.value;
  }

  async claim(
    key: OimKnowledgeCheckpointKey,
    scanId: string,
    leaseToken: string
  ): Promise<OimKnowledgeCheckpoint> {
    this.value = {
      ...(this.value ?? checkpoint(key)),
      ...key,
      scanId,
      leaseToken,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      revision: (this.value?.revision ?? 0) + 1,
    };
    return this.value;
  }

  async appendPage(
    _key: OimKnowledgeCheckpointKey,
    _leaseToken: string,
    _revision: number,
    continuation: string | null,
    seenItemIds: readonly string[],
    _now?: Date,
    pendingCursorWatermark?: string
  ): Promise<OimKnowledgeCheckpoint> {
    this.value = {
      ...(this.value ?? checkpoint()),
      continuation,
      accumulatedSeenItemIds: [
        ...new Set([...(this.value?.accumulatedSeenItemIds ?? []), ...seenItemIds]),
      ],
      ...(pendingCursorWatermark === undefined ? {} : { pendingCursorWatermark }),
      revision: (this.value?.revision ?? 0) + 1,
    };
    return this.value;
  }

  async stageCompletion(
    _key: OimKnowledgeCheckpointKey,
    _leaseToken: string,
    _revision: number,
    pendingDeletionItemIds: readonly string[]
  ): Promise<OimKnowledgeCheckpoint> {
    this.value = {
      ...(this.value ?? checkpoint()),
      continuation: null,
      pendingDeletionItemIds: [...pendingDeletionItemIds],
      revision: (this.value?.revision ?? 0) + 1,
    };
    return this.value;
  }

  async acknowledgeDeletions(
    _key: OimKnowledgeCheckpointKey,
    _leaseToken: string,
    _revision: number,
    deletedItemIds: readonly string[]
  ): Promise<OimKnowledgeCheckpoint> {
    const deleted = new Set(deletedItemIds);
    this.value = {
      ...(this.value ?? checkpoint()),
      pendingDeletionItemIds: (this.value?.pendingDeletionItemIds ?? []).filter(
        (id) => !deleted.has(id)
      ),
      revision: (this.value?.revision ?? 0) + 1,
    };
    return this.value;
  }

  async complete(
    _key?: OimKnowledgeCheckpointKey,
    _leaseToken?: string,
    _revision?: number,
    _now?: Date,
    listingMode: "full" | "incremental" = "full",
    rebuild = false
  ): Promise<OimKnowledgeCheckpoint | null> {
    if ((this.value?.pendingDeletionItemIds.length ?? 0) > 0) return null;
    this.value = {
      ...(this.value ?? checkpoint()),
      baselineItemIds:
        listingMode === "full" || rebuild
          ? [...(this.value?.accumulatedSeenItemIds ?? [])]
          : [...(this.value?.baselineItemIds ?? [])],
      cursorWatermark:
        listingMode === "incremental"
          ? (this.value?.pendingCursorWatermark ?? null)
          : (this.value?.cursorWatermark ?? null),
      pendingCursorWatermark: null,
      requiresFullRebuild: false,
      scanId: null,
      continuation: null,
      accumulatedSeenItemIds: [],
      pendingDeletionItemIds: [],
      leaseToken: null,
      leaseExpiresAt: null,
      revision: (this.value?.revision ?? 0) + 1,
    };
    return this.value;
  }

  async release(): Promise<OimKnowledgeCheckpoint> {
    this.value = {
      ...(this.value ?? checkpoint()),
      leaseToken: null,
      leaseExpiresAt: null,
      revision: (this.value?.revision ?? 0) + 1,
    };
    return this.value;
  }
}

class MemoryPublications {
  readonly sources = new Map<string, OimKnowledgeSourcePublication>();
  readonly quarantinedScopes: string[] = [];
  readonly quarantinedSources: string[] = [];
  readonly tombstonedConnections: string[] = [];
  readonly publicationClaims: PublishOimKnowledgeRevision["claim"][] = [];
  denyConnectionClaim = false;
  failDeletionOnce = false;
  failPublicationOnce = false;
  failScopeQuarantineOnce = false;
  invalidConnectionConflict = false;

  async claimConnection(input: OimKnowledgeExecutionScope) {
    return this.denyConnectionClaim ? null : { ...input, connectionGeneration: 1 };
  }

  async find(businessId: string, sourceId: string) {
    const source = this.sources.get(sourceId);
    return source?.businessId === businessId
      ? { ...source, connectionId: source.provenanceConnectionId }
      : null;
  }

  async publish(input: PublishOimKnowledgeRevision): Promise<boolean> {
    this.publicationClaims.push(input.claim);
    if (this.failPublicationOnce) {
      this.failPublicationOnce = false;
      return false;
    }
    const current = this.sources.get(input.source.sourceId);
    if (current !== undefined && current.revision !== input.expectedRevision) return false;
    this.sources.set(input.source.sourceId, input.source);
    return true;
  }

  async quarantineSource(input: {
    readonly sourceId: string;
    readonly quarantinedRevision: string;
  }): Promise<boolean> {
    this.quarantinedSources.push(input.sourceId);
    const current = this.sources.get(input.sourceId);
    if (current === undefined) return true;
    this.sources.set(input.sourceId, {
      ...current,
      revision: input.quarantinedRevision,
      verification: "unverifiable" as never,
    });
    return true;
  }

  async quarantineScope(input: {
    readonly claim: PublishOimKnowledgeRevision["claim"];
    readonly scope: string;
    readonly quarantinedRevisionPrefix: string;
  }): Promise<readonly string[] | null> {
    if (this.failScopeQuarantineOnce) {
      this.failScopeQuarantineOnce = false;
      return null;
    }
    this.quarantinedScopes.push(input.scope);
    for (const [sourceId, source] of this.sources) {
      this.sources.set(sourceId, {
        ...source,
        revision: `${input.quarantinedRevisionPrefix}:${sourceId}`,
        verification: "unverifiable" as never,
      });
    }
    return [...this.sources.keys()];
  }

  async quarantineInvalidConnection(input: {
    readonly connectionId: string;
    readonly deletedRevisionPrefix: string;
  }): Promise<readonly string[] | null> {
    if (this.invalidConnectionConflict) return null;
    this.tombstonedConnections.push(input.connectionId);
    for (const [sourceId, source] of this.sources) {
      this.sources.set(sourceId, {
        ...source,
        revision: `${input.deletedRevisionPrefix}:${sourceId}`,
        verification: "unverifiable" as never,
      });
    }
    return [...this.sources.keys()];
  }

  async markDeleted(input: {
    readonly sourceId: string;
    readonly deletedRevision: string;
  }): Promise<boolean> {
    if (this.failDeletionOnce) {
      this.failDeletionOnce = false;
      return false;
    }
    const source = this.sources.get(input.sourceId);
    if (source !== undefined) {
      this.sources.set(input.sourceId, {
        ...source,
        revision: input.deletedRevision,
      });
    }
    return true;
  }
}

function deps(
  checkpoints: MemoryCheckpoints,
  publications: MemoryPublications,
  execute: OimKnowledgeSyncDeps["api"]["execute"]
): OimKnowledgeSyncDeps {
  return {
    api: {
      connection: {
        businessId: "business-1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
      },
      execute,
    },
    checkpoints,
    publications,
    connections: {
      async findById() {
        return {
          businessId: "business-1",
          id: "connection-1",
          integration: { id: "wiki", majorVersion: 2 },
          owner: { scope: "organization" },
          status: "active",
          isDefault: true,
          label: "Wiki",
          configuration: {},
          agentVisibleConfiguration: [],
          secretBindings: {},
          health: { status: "healthy", checkedAt: NOW.toISOString() },
          expiresAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
      },
    },
    connectionIdentities: {
      async find() {
        return {
          businessId: "business-1",
          connectionId: "connection-1",
          integrationId: "wiki",
          integrationMajorVersion: 2,
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
          proofKind: "auth",
          proofDigest: "a".repeat(64),
          verifiedAt: NOW.toISOString(),
          verifiedBy: "auth-step",
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        };
      },
    },
    identity: {
      async resolve() {
        return { principals: [{ kind: "user", id: "user-1" }], incomplete: false };
      },
    },
    now: () => NOW,
    newId: () => "id-1",
  };
}

describe("syncOimKnowledge", () => {
  it("fails closed before provider access when the durable Connection fence is blocked", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    publications.denyConnectionClaim = true;
    let providerCalls = 0;

    const result = await syncOimKnowledge(
      plan(),
      deps(checkpoints, publications, async () => {
        providerCalls += 1;
        throw new Error("provider must not run");
      }),
      options()
    );

    expect(providerCalls).toBe(0);
    expect(result.failures).toEqual([{ code: "connection_identity_unverified", scope: "space-1" }]);
    expect(checkpoints.value).toBeNull();
  });

  it("quarantines the whole existing scope when its ACL cannot be refreshed", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    const result = await syncOimKnowledge(
      plan({
        acl: {
          mode: "scope",
          operation: operation("acl"),
          parameter: "space",
          entriesPointer: "/readers",
          entry: { defaultKind: "user", providerUserId: "/id" },
        },
      }),
      deps(checkpoints, publications, async ({ operationId }) => {
        if (operationId === "acl") throw new Error("provider unavailable");
        throw new Error("list must not run");
      }),
      options()
    );

    expect(result.failures).toEqual([{ code: "acl_failed", scope: "space-1" }]);
    expect(publications.quarantinedScopes).toEqual(["space-1"]);
    expect(checkpoints.value).toMatchObject({
      baselineItemIds: [],
      accumulatedSeenItemIds: [],
      scanId: "id-1",
    });
  });

  it("reports a checkpoint conflict when stale scope quarantine is rejected", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    publications.failScopeQuarantineOnce = true;
    const result = await syncOimKnowledge(
      plan({
        acl: {
          mode: "scope",
          operation: operation("acl"),
          parameter: "space",
          entriesPointer: "/readers",
          entry: { defaultKind: "user", providerUserId: "/id" },
        },
      }),
      deps(checkpoints, publications, async ({ operationId }) => {
        if (operationId === "acl") throw new Error("stale provider failure");
        throw new Error("list must not run");
      }),
      options()
    );

    expect(result.failures).toEqual([{ code: "checkpoint_conflict", scope: "space-1" }]);
    expect(publications.quarantinedScopes).toEqual([]);
  });

  it("quarantines an existing item when its item ACL refresh fails", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    const sourceId = "wiki:connection-1/page-1";
    publications.sources.set(sourceId, {
      businessId: "business-1",
      sourceId,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      provider: "wiki",
      externalId: "page-1",
      externalTenantId: "tenant-1",
      ownerExternalId: "account-1",
      sourceLocator: {
        kind: "oim",
        integrationSlug: "wiki-install",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        sourceKindId: "page",
        scope: "space-1",
        itemId: "page-1",
      },
      revision: "old",
      classification: ["internal"],
      verification: "verified",
      accessControlMode: "snapshot",
      accessControlMaximumAgeSeconds: 900,
      aclRevision: "acl-old",
      aclCapturedAt: NOW.toISOString(),
      aclPrincipals: [{ kind: "user", id: "user-1" }],
      provenanceCapturedAt: NOW.toISOString(),
      provenanceContentHash: "old",
      provenanceCheckpoint: "old",
      provenanceConnectionId: "connection-1",
      lastSyncedAt: NOW.toISOString(),
    });

    const result = await syncOimKnowledge(
      plan(),
      deps(checkpoints, publications, async ({ operationId }) => {
        if (operationId === "list") {
          return {
            body: { items: [{ id: "page-1", revision: "2" }] },
            nextPageToken: "page-2",
          };
        }
        if (operationId === "acl") throw new Error("permission refresh failed");
        throw new Error("content must not run");
      }),
      options()
    );

    expect(result.failures).toEqual([{ code: "acl_failed", scope: "space-1", itemId: "page-1" }]);
    expect(publications.sources.get(sourceId)).toMatchObject({
      verification: "unverifiable",
    });
    expect(checkpoints.value?.accumulatedSeenItemIds).toEqual([]);
  });

  it("quarantines old content when refreshed ACLs cannot be published with replacement content", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    const sourceId = "wiki:connection-1/page-1";
    publications.sources.set(sourceId, {
      businessId: "business-1",
      sourceId,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      provider: "wiki",
      externalId: "page-1",
      externalTenantId: "tenant-1",
      ownerExternalId: "account-1",
      sourceLocator: {
        kind: "oim",
        integrationSlug: "wiki-install",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        sourceKindId: "page",
        scope: "space-1",
        itemId: "page-1",
      },
      revision: "old",
      classification: ["internal"],
      verification: "verified",
      accessControlMode: "snapshot",
      accessControlMaximumAgeSeconds: 900,
      aclRevision: "acl-old",
      aclCapturedAt: NOW.toISOString(),
      aclPrincipals: [{ kind: "user", id: "user-1" }],
      provenanceCapturedAt: NOW.toISOString(),
      provenanceContentHash: "old",
      provenanceCheckpoint: "old",
      provenanceConnectionId: "connection-1",
      lastSyncedAt: NOW.toISOString(),
    });

    const result = await syncOimKnowledge(
      plan(),
      deps(checkpoints, publications, async ({ operationId }) => {
        if (operationId === "list") {
          return { body: { items: [{ id: "page-1", revision: "2" }] } };
        }
        if (operationId === "acl") return { body: { readers: [{ id: "new-reader" }] } };
        throw new Error("replacement content unavailable");
      }),
      options()
    );

    expect(result.failures).toEqual([
      { code: "content_failed", scope: "space-1", itemId: "page-1" },
    ]);
    expect(publications.sources.get(sourceId)).toMatchObject({
      verification: "unverifiable",
    });
    expect(checkpoints.value?.accumulatedSeenItemIds).toEqual([]);
  });

  it("does not quarantine a newer source after a stale publication claim is rejected", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    let revision = "1";
    const execute: OimKnowledgeSyncDeps["api"]["execute"] = async ({ operationId }) => {
      if (operationId === "list") {
        return { body: { items: [{ id: "page-1", revision }] } };
      }
      if (operationId === "acl") return { body: { readers: [{ id: "provider-user-1" }] } };
      return { body: { content: `content-${revision}`, revision } };
    };

    await expect(
      syncOimKnowledge(plan(), deps(checkpoints, publications, execute), options())
    ).resolves.toMatchObject({ failures: [] });
    revision = "2";
    publications.failPublicationOnce = true;
    const result = await syncOimKnowledge(
      plan(),
      deps(checkpoints, publications, execute),
      options()
    );

    expect(result.failures).toEqual([
      { code: "publication_conflict", scope: "space-1", itemId: "page-1" },
    ]);
    expect(publications.quarantinedSources).toEqual([]);
    expect(publications.sources.get("wiki:connection-1/page-1")).toMatchObject({
      revision: "1",
      verification: "verified",
    });
  });

  it("stages and resumes response watermarks without treating an incremental page as a full list", async () => {
    const checkpoints = new MemoryCheckpoints(
      checkpoint({
        baselineItemIds: ["unchanged-page"],
        cursorWatermark: "watermark-0",
      })
    );
    const publications = new MemoryPublications();
    const incremental = plan();
    const incrementalPlan: KnowledgeProfilePlan = {
      ...incremental,
      list: {
        ...incremental.list,
        cursor: {
          kind: "response_pointer",
          pointer: "/watermark",
          requestParameter: "since",
        },
      },
    };
    const requests: { readonly since?: unknown; readonly pageToken?: string }[] = [];
    let page = 0;
    const execute: OimKnowledgeSyncDeps["api"]["execute"] = async ({
      operationId,
      parameters,
      pageToken,
    }) => {
      if (operationId === "list") {
        requests.push({ since: parameters.since, pageToken });
        page += 1;
        return page === 1
          ? {
              body: { items: [{ id: "changed-a", revision: "1" }], watermark: "watermark-1" },
              nextPageToken: "page-2",
            }
          : { body: { items: [{ id: "changed-b", revision: "1" }], watermark: "watermark-2" } };
      }
      if (operationId === "acl") return { body: { readers: [{ id: "provider-user-1" }] } };
      return { body: { content: "changed", revision: "1" } };
    };

    const first = await syncOimKnowledge(
      incrementalPlan,
      deps(checkpoints, publications, execute),
      options()
    );
    expect(first.failures).toEqual([]);
    expect(checkpoints.value).toMatchObject({
      baselineItemIds: ["unchanged-page"],
      cursorWatermark: "watermark-0",
      pendingCursorWatermark: "watermark-1",
      continuation: "page-2",
      accumulatedSeenItemIds: ["changed-a"],
    });
    expect(publications.publicationClaims[0]).toMatchObject({
      businessId: "business-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      connectionGeneration: 1,
      sourceKindId: "page",
      scope: "space-1",
      scanId: "id-1",
      leaseToken: "id-1",
    });

    const second = await syncOimKnowledge(
      incrementalPlan,
      deps(checkpoints, publications, execute),
      options()
    );
    expect(second.failures).toEqual([]);
    expect(requests).toEqual([
      { since: "watermark-0", pageToken: undefined },
      { since: "watermark-0", pageToken: "page-2" },
    ]);
    expect(checkpoints.value).toMatchObject({
      baselineItemIds: ["unchanged-page"],
      cursorWatermark: "watermark-2",
      pendingCursorWatermark: null,
      scanId: null,
      continuation: null,
      accumulatedSeenItemIds: [],
    });
  });

  it("finishes preserved deletions and resumes a full rebuild before committing incremental progress", async () => {
    const checkpoints = new MemoryCheckpoints(
      checkpoint({
        baselineItemIds: ["removed", "unchanged"],
        scanId: "rebuild:4",
        pendingDeletionItemIds: ["removed"],
        cursorWatermark: null,
        pendingCursorWatermark: null,
        requiresFullRebuild: true,
      })
    );
    const publications = new MemoryPublications();
    const incremental = plan();
    const incrementalPlan: KnowledgeProfilePlan = {
      ...incremental,
      list: {
        ...incremental.list,
        cursor: {
          kind: "response_pointer",
          pointer: "/watermark",
          requestParameter: "since",
        },
      },
    };
    const requests: { readonly since?: unknown; readonly pageToken?: string }[] = [];
    let page = 0;
    const execute: OimKnowledgeSyncDeps["api"]["execute"] = async ({
      operationId,
      parameters,
      pageToken,
    }) => {
      if (operationId === "list") {
        requests.push({ since: parameters.since, pageToken });
        page += 1;
        return page === 1
          ? {
              body: { items: [{ id: "unchanged", revision: "1" }], watermark: "watermark-1" },
              nextPageToken: "page-2",
            }
          : { body: { items: [{ id: "changed", revision: "1" }], watermark: "watermark-2" } };
      }
      if (operationId === "acl") return { body: { readers: [{ id: "provider-user-1" }] } };
      return { body: { content: "rebuilt", revision: "1" } };
    };

    const first = await syncOimKnowledge(
      incrementalPlan,
      deps(checkpoints, publications, execute),
      options()
    );
    expect(first.failures).toEqual([]);
    expect(checkpoints.value).toMatchObject({
      pendingDeletionItemIds: [],
      continuation: "page-2",
      accumulatedSeenItemIds: ["unchanged"],
      cursorWatermark: null,
      pendingCursorWatermark: "watermark-1",
      requiresFullRebuild: true,
    });

    const second = await syncOimKnowledge(
      incrementalPlan,
      deps(checkpoints, publications, execute),
      options()
    );
    expect(second.failures).toEqual([]);
    expect(requests).toEqual([
      { since: undefined, pageToken: undefined },
      { since: undefined, pageToken: "page-2" },
    ]);
    expect(checkpoints.value).toMatchObject({
      baselineItemIds: ["unchanged", "changed"],
      cursorWatermark: "watermark-2",
      pendingCursorWatermark: null,
      requiresFullRebuild: false,
      scanId: null,
      continuation: null,
    });
  });

  it("preserves committed and pending watermarks when a resumed response pointer is malformed", async () => {
    const checkpoints = new MemoryCheckpoints(
      checkpoint({
        scanId: "scan-1",
        continuation: "page-2",
        accumulatedSeenItemIds: ["changed-a"],
        cursorWatermark: "watermark-0",
        pendingCursorWatermark: "watermark-1",
      })
    );
    const publications = new MemoryPublications();
    const incremental = plan();
    const result = await syncOimKnowledge(
      {
        ...incremental,
        list: {
          ...incremental.list,
          cursor: {
            kind: "response_pointer",
            pointer: "/watermark",
            requestParameter: "since",
          },
        },
      },
      deps(checkpoints, publications, async ({ operationId, parameters, pageToken }) => {
        expect(operationId).toBe("list");
        expect(parameters).toMatchObject({ space: "space-1", since: "watermark-0" });
        expect(pageToken).toBe("page-2");
        return { body: { items: [] } };
      }),
      options()
    );

    expect(result.failures).toEqual([{ code: "mapping_failed", scope: "space-1" }]);
    expect(checkpoints.value).toMatchObject({
      cursorWatermark: "watermark-0",
      pendingCursorWatermark: "watermark-1",
      continuation: "page-2",
      accumulatedSeenItemIds: ["changed-a"],
    });
  });

  it("does not stage a response watermark when an item publication obligation fails", async () => {
    const checkpoints = new MemoryCheckpoints(
      checkpoint({
        cursorWatermark: "watermark-0",
      })
    );
    const publications = new MemoryPublications();
    const incremental = plan();
    const result = await syncOimKnowledge(
      {
        ...incremental,
        list: {
          ...incremental.list,
          cursor: {
            kind: "response_pointer",
            pointer: "/watermark",
            requestParameter: "since",
          },
        },
      },
      deps(checkpoints, publications, async ({ operationId }) => {
        if (operationId === "list") {
          return {
            body: { items: [{ id: "changed-a", revision: "1" }], watermark: "watermark-1" },
          };
        }
        if (operationId === "acl") return { body: { readers: [{ id: "provider-user-1" }] } };
        throw new Error("replacement content unavailable");
      }),
      options()
    );

    expect(result.failures).toEqual([
      { code: "content_failed", scope: "space-1", itemId: "changed-a" },
    ]);
    expect(checkpoints.value).toMatchObject({
      cursorWatermark: "watermark-0",
      pendingCursorWatermark: null,
      continuation: null,
      accumulatedSeenItemIds: [],
    });
  });

  it("promotes an incremental watermark only after failed deletions retry successfully", async () => {
    const checkpoints = new MemoryCheckpoints(
      checkpoint({
        cursorWatermark: "watermark-0",
      })
    );
    const publications = new MemoryPublications();
    const sourceId = "wiki:connection-1/page-deleted";
    publications.sources.set(sourceId, {
      businessId: "business-1",
      sourceId,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      provider: "wiki",
      externalId: "page-deleted",
      externalTenantId: "tenant-1",
      ownerExternalId: "account-1",
      sourceLocator: {
        kind: "oim",
        integrationSlug: "wiki-install",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        sourceKindId: "page",
        scope: "space-1",
        itemId: "page-deleted",
      },
      revision: "old",
      classification: ["internal"],
      verification: "verified",
      accessControlMode: "snapshot",
      accessControlMaximumAgeSeconds: 900,
      aclRevision: "acl-old",
      aclCapturedAt: NOW.toISOString(),
      aclPrincipals: [{ kind: "user", id: "user-1" }],
      provenanceCapturedAt: NOW.toISOString(),
      provenanceContentHash: "old",
      provenanceCheckpoint: "old",
      provenanceConnectionId: "connection-1",
      lastSyncedAt: NOW.toISOString(),
    });
    publications.failDeletionOnce = true;
    const incremental = plan({
      deletion: {
        kind: "operation",
        operation: operation("deleted"),
        itemsPointer: "/items",
        itemIdPointer: "/id",
      },
    });
    const incrementalPlan: KnowledgeProfilePlan = {
      ...incremental,
      list: {
        ...incremental.list,
        cursor: {
          kind: "response_pointer",
          pointer: "/watermark",
          requestParameter: "since",
        },
      },
    };

    const first = await syncOimKnowledge(
      incrementalPlan,
      deps(checkpoints, publications, async ({ operationId, parameters }) => {
        if (operationId === "list") {
          expect(parameters.since).toBe("watermark-0");
          return { body: { items: [], watermark: "watermark-1" } };
        }
        if (operationId === "deleted") return { body: { items: [{ id: "page-deleted" }] } };
        throw new Error("content and ACL operations must not run");
      }),
      options()
    );
    expect(first.failures).toEqual([
      { code: "deletion_failed", scope: "space-1", itemId: "page-deleted" },
    ]);
    expect(checkpoints.value).toMatchObject({
      cursorWatermark: "watermark-0",
      pendingCursorWatermark: "watermark-1",
      pendingDeletionItemIds: ["page-deleted"],
    });

    const second = await syncOimKnowledge(
      incrementalPlan,
      deps(checkpoints, publications, async () => {
        throw new Error("provider must not run before pending deletion retry");
      }),
      options()
    );
    expect(second.failures).toEqual([]);
    expect(checkpoints.value).toMatchObject({
      cursorWatermark: "watermark-1",
      pendingCursorWatermark: null,
      pendingDeletionItemIds: [],
      scanId: null,
    });
  });

  it("accumulates seen ids across bounded resumed walks and keeps failed deletions pending", async () => {
    const checkpoints = new MemoryCheckpoints(
      checkpoint({
        baselineItemIds: ["page-1", "page-deleted"],
        scanId: "scan-1",
        continuation: "page-2",
        accumulatedSeenItemIds: ["page-1"],
        revision: 4,
      })
    );
    const publications = new MemoryPublications();
    publications.sources.set("wiki:connection-1/page-deleted", {
      businessId: "business-1",
      sourceId: "wiki:connection-1/page-deleted",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      provider: "wiki",
      externalId: "page-deleted",
      externalTenantId: "tenant-1",
      ownerExternalId: "account-1",
      sourceLocator: {
        kind: "oim",
        integrationSlug: "wiki-install",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        sourceKindId: "page",
        scope: "space-1",
        itemId: "page-deleted",
      },
      revision: "old",
      classification: ["internal"],
      verification: "verified",
      accessControlMode: "snapshot",
      accessControlMaximumAgeSeconds: 900,
      aclRevision: "acl-old",
      aclCapturedAt: NOW.toISOString(),
      aclPrincipals: [{ kind: "user", id: "user-1" }],
      provenanceCapturedAt: NOW.toISOString(),
      provenanceContentHash: "old",
      provenanceCheckpoint: "old",
      provenanceConnectionId: "connection-1",
      lastSyncedAt: NOW.toISOString(),
    });
    publications.failDeletionOnce = true;
    let listCalls = 0;
    const execute: OimKnowledgeSyncDeps["api"]["execute"] = async ({ operationId, pageToken }) => {
      if (operationId === "list") {
        listCalls += 1;
        expect(pageToken).toBe("page-2");
        return { body: { items: [{ id: "page-2", revision: "2" }] } };
      }
      if (operationId === "acl") return { body: { readers: [{ id: "provider-user-1" }] } };
      return { body: { content: "new content", revision: "2" } };
    };

    const first = await syncOimKnowledge(
      plan(),
      deps(checkpoints, publications, execute),
      options()
    );
    expect(first.failures).toEqual([
      { code: "deletion_failed", scope: "space-1", itemId: "page-deleted" },
    ]);
    expect(checkpoints.value).toMatchObject({
      baselineItemIds: ["page-1", "page-deleted"],
      accumulatedSeenItemIds: ["page-1", "page-2"],
      pendingDeletionItemIds: ["page-deleted"],
    });

    const second = await syncOimKnowledge(
      plan(),
      deps(checkpoints, publications, async () => {
        throw new Error("pending deletion must retry before another provider read");
      }),
      options()
    );
    expect(second.failures).toEqual([]);
    expect(checkpoints.value).toMatchObject({
      baselineItemIds: ["page-1", "page-2"],
      scanId: null,
      accumulatedSeenItemIds: [],
      pendingDeletionItemIds: [],
    });
    expect(listCalls).toBe(1);
  });

  it("does not advance a checkpoint when the list pointer is missing", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    const result = await syncOimKnowledge(
      plan(),
      deps(checkpoints, publications, async () => ({ body: {} })),
      options()
    );

    expect(result.failures).toEqual([{ code: "mapping_failed", scope: "space-1" }]);
    expect(checkpoints.value?.accumulatedSeenItemIds).toEqual([]);
    expect(checkpoints.value?.scanId).toBe("id-1");
  });

  it("does not delete a non-Knowledge OIM source that shares its generated id", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    const sourceId = "wiki:connection-1/page-1";
    publications.sources.set(sourceId, {
      businessId: "business-1",
      sourceId,
      integrationId: "wiki",
      integrationMajorVersion: 2,
      provider: "wiki",
      externalId: "page-1",
      externalTenantId: "tenant-1",
      ownerExternalId: "account-1",
      sourceLocator: { kind: "events", scope: "space-1" },
      revision: "legacy",
      classification: ["internal"],
      verification: "verified",
      accessControlMode: "snapshot",
      accessControlMaximumAgeSeconds: 900,
      aclRevision: "acl-old",
      aclCapturedAt: NOW.toISOString(),
      aclPrincipals: [{ kind: "user", id: "user-1" }],
      provenanceCapturedAt: NOW.toISOString(),
      provenanceContentHash: "old",
      provenanceCheckpoint: "old",
      provenanceConnectionId: "connection-1",
      lastSyncedAt: NOW.toISOString(),
    });

    const basePlan = plan({ deletion: { kind: "list_flag", pointer: "/deleted" } });
    const result = await syncOimKnowledge(
      {
        ...basePlan,
        list: {
          ...basePlan.list,
          mapping: { ...basePlan.list.mapping, deleted: "/deleted" },
        },
      },
      deps(checkpoints, publications, async ({ operationId }) => {
        if (operationId === "list") {
          return { body: { items: [{ id: "page-1", deleted: true }] } };
        }
        throw new Error("deleted items must not read content or ACLs");
      }),
      options()
    );

    expect(result.failures).toEqual([
      { code: "deletion_failed", scope: "space-1", itemId: "page-1" },
    ]);
    expect(publications.sources.get(sourceId)?.revision).toBe("legacy");
  });

  it("rejects a Connection identity proof from another tenant before provider access", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    publications.invalidConnectionConflict = true;
    const base = deps(checkpoints, publications, async () => {
      throw new Error("provider must not run");
    });
    const result = await syncOimKnowledge(
      plan(),
      {
        ...base,
        connectionIdentities: {
          async find() {
            const proof = await base.connectionIdentities.find("business-1", "connection-1");
            if (proof === null) throw new Error("expected fixture identity");
            return {
              ...proof,
              businessId: "other-business",
              externalTenantId: "tenant-2",
            };
          },
        },
      },
      options()
    );

    expect(result.failures).toEqual([{ code: "connection_conflict", scope: "space-1" }]);
    expect(publications.tombstonedConnections).toEqual([]);
  });

  it("rejects a provider client bound to another tenant before provider access", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    publications.invalidConnectionConflict = true;
    const base = deps(checkpoints, publications, async () => {
      throw new Error("provider must not run");
    });
    const result = await syncOimKnowledge(
      plan(),
      {
        ...base,
        api: {
          ...base.api,
          connection: { ...base.api.connection, externalTenantId: "tenant-2" },
        },
      },
      options()
    );

    expect(result.failures).toEqual([{ code: "connection_conflict", scope: "space-1" }]);
    expect(publications.tombstonedConnections).toEqual([]);
  });

  it("does not tombstone when the invalid Connection observation is stale", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    const sourceId = "wiki:connection-1/page-1";
    const base = deps(checkpoints, publications, async ({ operationId }) => {
      if (operationId === "list") {
        return { body: { items: [{ id: "page-1", revision: "fresh" }] } };
      }
      if (operationId === "acl") return { body: { readers: [{ id: "provider-user-1" }] } };
      return { body: { content: "fresh content", revision: "fresh" } };
    });
    let resumeIdentity = () => {};
    let markIdentityRead = () => {};
    const identityResume = new Promise<void>((resolve) => {
      resumeIdentity = resolve;
    });
    const identityRead = new Promise<void>((resolve) => {
      markIdentityRead = resolve;
    });
    const running = syncOimKnowledge(
      plan(),
      {
        ...base,
        connections: {
          async findById() {
            const selected = await base.connections.findById("business-1", "connection-1");
            if (selected === null) throw new Error("expected fixture Connection");
            return {
              ...selected,
              health: { status: "action_required" as const, checkedAt: NOW.toISOString() },
            };
          },
        },
        connectionIdentities: {
          async find() {
            const identity = await base.connectionIdentities.find("business-1", "connection-1");
            markIdentityRead();
            await identityResume;
            return identity;
          },
        },
      },
      options()
    );
    await identityRead;
    await expect(syncOimKnowledge(plan(), base, options())).resolves.toMatchObject({
      published: 1,
      failures: [],
    });
    publications.invalidConnectionConflict = true;
    resumeIdentity();
    const result = await running;

    expect(result.failures).toEqual([{ code: "connection_conflict", scope: "space-1" }]);
    expect(publications.tombstonedConnections).toEqual([]);
    expect(publications.sources.get(sourceId)).toMatchObject({
      revision: "fresh",
      verification: "verified",
    });
  });

  it("tombstones when the authoritative Connection remains invalid", async () => {
    const checkpoints = new MemoryCheckpoints();
    const publications = new MemoryPublications();
    const base = deps(checkpoints, publications, async () => {
      throw new Error("provider must not run");
    });
    const result = await syncOimKnowledge(
      plan(),
      {
        ...base,
        connections: {
          async findById() {
            const selected = await base.connections.findById("business-1", "connection-1");
            if (selected === null) throw new Error("expected fixture Connection");
            return {
              ...selected,
              health: { status: "action_required" as const, checkedAt: NOW.toISOString() },
            };
          },
        },
      },
      options()
    );

    expect(result.failures).toEqual([{ code: "connection_identity_unverified", scope: "space-1" }]);
    expect(publications.tombstonedConnections).toEqual(["connection-1"]);
  });
});
