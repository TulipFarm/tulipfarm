import { randomUUID } from "node:crypto";
import type {
  McpAccountScope,
  McpAccountUseContext,
  McpCaller,
  McpCapability,
} from "@tulipfarm/integrations";
import {
  createMcpKnowledgeLiveAccess,
  decideSourceAccess,
  type EmbeddingPort,
  type LiveSourceAuthorizationPort,
  MCP_KNOWLEDGE_POLL_INTERVAL_MS,
  type McpKnowledgeBinding,
  type McpKnowledgeCheckpoint,
  McpKnowledgeError,
  McpKnowledgePublication,
  type McpKnowledgeReadPort,
  mcpKnowledgeFreshness,
  mcpKnowledgeSourceId,
  PgKnowledgePageRepo,
  sameMcpKnowledgeBinding,
  syncMcpKnowledgeBatch,
  validateMcpKnowledgeSelection,
} from "@tulipfarm/knowledge";
import {
  canonicalHash,
  type McpKnowledgePut,
  type McpKnowledgeSelectionDocument,
  type McpKnowledgeStatus,
  validateMcpKnowledgeCheckpointDocument,
} from "@tulipfarm/schema";
import {
  type McpKnowledgeClaim,
  McpKnowledgeFenceError,
  McpKnowledgeStore,
  type Queryable,
  RunStore,
  type TransactionPort,
} from "@tulipfarm/storage";
import { PgKnowledgeIndexStore } from "../index-store";
import { PgKnowledgeSourceStore } from "../source-store";

export interface McpKnowledgeAccountHost {
  bindingFor(input: {
    readonly integrationKey: string;
    readonly accountId: string;
    readonly readerUserId: string;
  }): Promise<McpKnowledgeEligibleBinding | undefined>;
  captureIdentity(input: {
    readonly binding: McpKnowledgeEligibleBinding;
    readonly readerUserId: string;
  }): Promise<string>;
  open<T>(
    input: {
      readonly binding: McpKnowledgeBinding;
      readonly readerUserId: string;
      readonly selectionId: string;
      readonly assertCurrent: () => Promise<void>;
    },
    callback: (read: McpKnowledgeReadPort) => Promise<T>
  ): Promise<T>;
}

export type McpKnowledgeEligibleBinding = Omit<McpKnowledgeBinding, "externalAccountId"> & {
  readonly externalAccountId?: string;
};

function fencedRead(
  read: McpKnowledgeReadPort,
  assertCurrent: () => Promise<void>
): McpKnowledgeReadPort {
  return {
    ...read,
    async callTool(input) {
      input.signal.throwIfAborted();
      await assertCurrent();
      const result = await read.callTool(input);
      input.signal.throwIfAborted();
      await assertCurrent();
      return result;
    },
  };
}

export function composeMcpKnowledge(deps: {
  readonly db: Queryable;
  readonly transactions: TransactionPort;
  readonly businessId: string;
  readonly accounts: McpKnowledgeAccountHost;
  readonly embeddings: EmbeddingPort;
  readonly now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const store = new McpKnowledgeStore(deps.db, deps.transactions);
  const sources = new PgKnowledgeSourceStore(deps.db);

  async function bindingFor(integrationKey: string, accountId: string, readerUserId: string) {
    const binding = await deps.accounts.bindingFor({ integrationKey, accountId, readerUserId });
    if (
      binding &&
      (binding.businessId !== deps.businessId ||
        binding.integrationId !== integrationKey ||
        binding.accountId !== accountId ||
        binding.ownerUserId !== readerUserId)
    ) {
      throw new McpKnowledgeError("identity_mismatch");
    }
    return binding;
  }

  async function assertSelection(selection: McpKnowledgeSelectionDocument, readerUserId: string) {
    await store.assertCurrent(selection);
    const binding = await bindingFor(
      selection.binding.integrationId,
      selection.binding.accountId,
      readerUserId
    );
    if (
      !binding ||
      !sameMcpKnowledgeBinding(selection.binding, {
        ...binding,
        externalAccountId: binding.externalAccountId ?? selection.binding.externalAccountId,
      })
    ) {
      throw new McpKnowledgeError("selection_changed");
    }
  }

  async function status(
    integrationKey: string,
    accountId: string,
    readerUserId: string
  ): Promise<McpKnowledgeStatus> {
    const binding = await bindingFor(integrationKey, accountId, readerUserId);
    const saved = await store.get(deps.businessId, accountId);
    if (
      saved &&
      (saved.selection.binding.ownerUserId !== readerUserId ||
        saved.selection.binding.integrationId !== integrationKey)
    )
      throw new McpKnowledgeError("identity_mismatch");
    return {
      eligibility: {
        supported: binding !== undefined,
        reason: binding ? null : "unsupported_source",
        sourceKind: "github-file",
        visibility: "personal",
      },
      selection: saved
        ? {
            id: saved.selection.id,
            revision: saved.revision,
            enabled: saved.selection.enabled,
            files: saved.selection.files,
            pollIntervalMs: saved.selection.pollIntervalMs ?? MCP_KNOWLEDGE_POLL_INTERVAL_MS,
            progress: saved.checkpoint,
            lastAttemptAt: saved.lastAttemptAt,
            lastCompletedAt: saved.lastCompletedAt,
            nextAttemptAt: saved.nextAttemptAt,
            errorCode: saved.errorCode,
            cleanupPending: saved.cleanupPending,
          }
        : null,
    };
  }

  async function put(
    integrationKey: string,
    accountId: string,
    readerUserId: string,
    input: McpKnowledgePut
  ) {
    const eligible = await bindingFor(integrationKey, accountId, readerUserId);
    if (!eligible) throw new McpKnowledgeError("unsupported_source");
    const externalAccountId = await deps.accounts.captureIdentity({
      binding: eligible,
      readerUserId,
    });
    if (
      !/^[1-9][0-9]*$/.test(externalAccountId) ||
      !Number.isSafeInteger(Number(externalAccountId))
    ) {
      throw new McpKnowledgeError("identity_mismatch");
    }
    const binding: McpKnowledgeBinding = { ...eligible, externalAccountId };
    const current = await store.get(deps.businessId, accountId);
    const selection: McpKnowledgeSelectionDocument = {
      id: current?.selection.id ?? randomUUID(),
      revision: String((input.expectedRevision ?? 0) + 1),
      binding,
      visibility: "personal",
      enabled: input.enabled,
      files: input.files,
      pollIntervalMs: input.pollIntervalMs ?? MCP_KNOWLEDGE_POLL_INTERVAL_MS,
    };
    validateMcpKnowledgeSelection({ ...selection, enabled: true });
    await store.save(selection, input.expectedRevision);
    return status(integrationKey, accountId, readerUserId);
  }

  async function change(
    integrationKey: string,
    accountId: string,
    readerUserId: string,
    revision: number,
    remove: boolean
  ) {
    const saved = await store.get(deps.businessId, accountId);
    if (
      !saved ||
      saved.selection.binding.integrationId !== integrationKey ||
      saved.selection.binding.ownerUserId !== readerUserId
    )
      throw new McpKnowledgeError("identity_mismatch");
    if (remove) await store.disable(deps.businessId, accountId, revision);
    else {
      await assertSelection(saved.selection, readerUserId);
      await store.requestSync(deps.businessId, accountId, revision);
    }
    return status(integrationKey, accountId, readerUserId);
  }

  function liveAccess(readerUserId: string): LiveSourceAuthorizationPort {
    return {
      async check(input) {
        const source = await sources.get(input.businessId, input.sourceId);
        const locator = source?.sourceLocator;
        if (!source || locator?.kind !== "mcp") return undefined;
        if (
          input.businessId !== deps.businessId ||
          locator.ownerUserId !== readerUserId ||
          !input.principals.some(
            (principal) => principal.kind === "user" && principal.id === readerUserId
          )
        ) {
          return { allowed: false };
        }
        const saved = await store.get(deps.businessId, locator.accountId);
        if (
          !saved ||
          saved.selection.id !== locator.selectionId ||
          saved.selection.revision !== locator.selectionRevision ||
          !saved.selection.files.some(
            (file) =>
              mcpKnowledgeSourceId(saved.selection.binding, file, saved.selection.id) ===
              source.sourceId
          )
        )
          return { allowed: false };
        const assertCurrent = () => assertSelection(saved.selection, readerUserId);
        await assertCurrent();
        return deps.accounts.open(
          {
            binding: saved.selection.binding,
            readerUserId,
            selectionId: saved.selection.id,
            assertCurrent,
          },
          async (read) => {
            const gate = createMcpKnowledgeLiveAccess({
              sources,
              readerUserId,
              now,
              open: async ({ binding }) => {
                await assertCurrent();
                if (!sameMcpKnowledgeBinding(binding, saved.selection.binding)) return undefined;
                return fencedRead(read, assertCurrent);
              },
            });
            const result = await gate.check(input);
            await assertCurrent();
            return result;
          }
        );
      },
    };
  }

  async function canReadPage(
    readerUserId: string | undefined,
    pageId: string
  ): Promise<boolean | undefined> {
    const page = await new PgKnowledgePageRepo(deps.db).getById(pageId);
    if (page?.source !== "mcp") return undefined;
    if (!readerUserId || !page.active) return false;
    const link = await store.linkForPage(deps.businessId, pageId);
    if (!link || link.cleanupPending || page.sourceId !== link.sourceId) return false;
    const source = await sources.get(deps.businessId, link.sourceId);
    if (
      source?.sourceLocator?.kind !== "mcp" ||
      Number(source.sourceLocator.selectionRevision) !== link.selectionRevision
    )
      return false;
    const decision = await decideSourceAccess(
      source,
      { businessId: deps.businessId, principals: [{ kind: "user", id: readerUserId }] },
      { live: liveAccess(readerUserId) },
      now()
    );
    return decision.allowed;
  }

  async function pageMetadata(readerUserId: string, pageId: string) {
    if (!(await canReadPage(readerUserId, pageId))) return undefined;
    const link = await store.linkForPage(deps.businessId, pageId);
    if (!link) return undefined;
    const source = await sources.get(deps.businessId, link.sourceId);
    if (source?.sourceLocator?.kind !== "mcp") return undefined;
    const saved = await store.get(deps.businessId, source.sourceLocator.accountId);
    const freshness = mcpKnowledgeFreshness(
      source,
      now(),
      saved?.selection.pollIntervalMs,
      saved?.errorCode !== null && saved?.errorCode !== undefined
    );
    return {
      readOnly: true,
      sourceUrl: source.sourceLocator.sourceUrl,
      lastSyncedAt: freshness.lastSyncedAt,
      stale: freshness.stale,
    };
  }

  async function isReadOnlySubject(subjectKind: "page" | "space", id: string) {
    const pages = new PgKnowledgePageRepo(deps.db);
    if (subjectKind === "page") return (await pages.getById(id))?.source === "mcp";
    return (await pages.listBySpace(id)).some((page) => page.source === "mcp");
  }

  async function contextFor(
    readerUserId: string,
    selectionId: string
  ): Promise<Extract<McpAccountUseContext, { kind: "knowledge_sync" }>> {
    const selection = await store.selectionById(deps.businessId, selectionId);
    if (selection?.visibility !== "personal" || selection.binding.ownerUserId !== readerUserId) {
      throw new McpKnowledgeError("identity_mismatch");
    }

    await assertSelection(selection, readerUserId);
    return {
      kind: "knowledge_sync",
      businessId: deps.businessId,
      integrationKey: selection.binding.integrationId,
      definitionDigest: selection.binding.configurationRevision,
      ownerPrincipalId: readerUserId,
      visibility: "owner",
      accountId: selection.binding.accountId,
      accountRevision: selection.binding.accountRevision,
      configurationDigest: canonicalHash(selection),
      syncId: selection.id,
    };
  }

  async function context(
    caller: McpCaller,
    scope: McpAccountScope,
    capability: McpCapability
  ): Promise<McpAccountUseContext> {
    if (
      caller.principal.kind !== "user" ||
      !caller.knowledgeSyncId ||
      capability.kind !== "tool" ||
      (capability.name !== "get_me" && capability.name !== "get_file_contents")
    ) {
      throw new McpKnowledgeError("identity_mismatch");
    }
    const current = await contextFor(caller.principal.id, caller.knowledgeSyncId);
    if (
      current.businessId !== scope.businessId ||
      current.integrationKey !== scope.integrationKey ||
      current.definitionDigest !== scope.definitionDigest
    ) {
      throw new McpKnowledgeError("selection_changed");
    }
    return current;
  }

  async function canReadPageForRun(
    runId: string,
    readerUserId: string,
    pageId: string
  ): Promise<boolean> {
    const runs = new RunStore(deps.transactions);
    const run = await runs.find(deps.businessId, runId);
    if (
      run?.status !== "running" ||
      run.identity.effectiveSubject.kind !== "user" ||
      run.identity.effectiveSubject.id !== readerUserId
    )
      return false;
    const allowed = await canReadPage(run.identity.effectiveSubject.id, pageId);
    const current = await runs.find(deps.businessId, runId);
    return (
      allowed === true &&
      current?.status === "running" &&
      current.identity.effectiveSubject.kind === "user" &&
      current.identity.effectiveSubject.id === readerUserId
    );
  }

  async function reconcile() {
    for (const selection of await store.listEnabled(deps.businessId)) {
      // No network probes here: only a confirmed local account/definition refusal schedules purge.
      const binding = await bindingFor(
        selection.binding.integrationId,
        selection.binding.accountId,
        selection.binding.ownerUserId
      );
      if (
        !binding ||
        !sameMcpKnowledgeBinding(
          {
            ...binding,
            externalAccountId: binding.externalAccountId ?? selection.binding.externalAccountId,
          },
          selection.binding
        )
      ) {
        await store.markAccountCleanup(deps.businessId, selection.binding.accountId);
      }
    }
    return store.cleanupBatch(deps.businessId, async (tx, link) => {
      await new McpKnowledgePublication(
        tx,
        new PgKnowledgeSourceStore(tx, true),
        deps.embeddings
      ).remove(link.businessId, link.sourceId, link.pageId);
    });
  }

  async function batch(input: {
    readonly accountId: string;
    readonly selectionId: string;
    readonly selectionRevision: string;
    readonly leaseId: string;
  }): Promise<McpKnowledgeCheckpoint> {
    const saved = await store.get(deps.businessId, input.accountId);
    if (
      !saved ||
      saved.selection.id !== input.selectionId ||
      saved.selection.revision !== input.selectionRevision
    )
      throw new McpKnowledgeFenceError();
    return runClaim({ selection: saved.selection, leaseId: input.leaseId });
  }

  async function runClaim(claim: McpKnowledgeClaim): Promise<McpKnowledgeCheckpoint> {
    const selection = claim.selection;
    const assertCurrent = async () => {
      await assertSelection(selection, selection.binding.ownerUserId);
      await store.withLease(claim, now(), async () => {});
    };
    await assertCurrent();
    return deps.accounts.open(
      {
        binding: selection.binding,
        readerUserId: selection.binding.ownerUserId,
        selectionId: selection.id,
        assertCurrent,
      },
      async (read) =>
        syncMcpKnowledgeBatch(selection, {
          sources,
          sink: {
            emitSource: async () => {
              throw new Error("mcp_atomic_publication_required");
            },
            emitChunk: async () => {
              throw new Error("mcp_atomic_publication_required");
            },
            removeSourceContent: async () => {
              throw new Error("mcp_atomic_publication_required");
            },
          },
          invalidate: async () => {
            throw new Error("mcp_atomic_publication_required");
          },
          read: fencedRead(read, assertCurrent),
          now,
          assertCurrent,
          checkpoints: {
            load: async () =>
              (await store.get(deps.businessId, selection.binding.accountId))?.checkpoint ??
              undefined,
            save: async (_, checkpoint) => {
              await assertCurrent();
              await store.checkpoint(
                claim,
                validateMcpKnowledgeCheckpointDocument(checkpoint),
                now()
              );
            },
          },
          publishDocument: async (source, document, chunks, signal) => {
            signal.throwIfAborted();
            await assertCurrent();
            const pageId = await store.withLease(claim, now(), async (tx) => {
              const publication = new McpKnowledgePublication(
                tx,
                new PgKnowledgeSourceStore(tx, true),
                deps.embeddings
              );
              const id = await publication.hide(source);
              await store.linkSource(tx, claim, source.sourceId, id);
              await tx.query(
                `UPDATE mcp_knowledge_source_links SET cleanup_pending=true WHERE business_id=$1 AND source_id=$2`,
                [deps.businessId, source.sourceId]
              );
              signal.throwIfAborted();
              return id;
            });
            await assertCurrent();
            await store.withLease(claim, now(), async (tx) => {
              const publication = new McpKnowledgePublication(
                tx,
                new PgKnowledgeSourceStore(tx, true),
                deps.embeddings
              );
              await publication.publish(source, document, pageId);
              const index = new PgKnowledgeIndexStore(tx, deps.embeddings);
              for (const chunk of chunks) {
                signal.throwIfAborted();
                await index.upsert(chunk);
              }
              await store.linkSource(tx, claim, source.sourceId, pageId);
              signal.throwIfAborted();
            });
          },
        })
    );
  }

  return {
    store,
    status,
    put,
    change,
    reconcile,
    batch,
    liveAccess,
    canReadPage,
    pageMetadata,
    isReadOnlySubject,
    contextFor,
    context,
    canReadPageForRun,
  };
}

export type McpKnowledgeFeature = ReturnType<typeof composeMcpKnowledge>;
