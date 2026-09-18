import { canonicalHash } from "@tulipfarm/schema";
import { chunkText } from "../chunk";
import type { KnowledgeSourceRecord } from "../source";
import {
  mcpKnowledgeSourceId,
  readGithubKnowledgeFile,
  sameMcpKnowledgeBinding,
  validateGithubKnowledgeFile,
} from "./github-file";
import {
  MCP_KNOWLEDGE_MAX_BATCH,
  MCP_KNOWLEDGE_MAX_SELECTION,
  MCP_KNOWLEDGE_MAX_STALE_MS,
  MCP_KNOWLEDGE_POLL_INTERVAL_MS,
  type McpKnowledgeCheckpoint,
  McpKnowledgeError,
  type McpKnowledgeSelection,
  type McpKnowledgeSyncDeps,
} from "./types";

export function validateMcpKnowledgeSelection(selection: McpKnowledgeSelection): void {
  if (selection.visibility !== "personal") throw new McpKnowledgeError("unsupported_shared_sync");
  if (
    !selection.enabled ||
    !selection.id ||
    !selection.revision ||
    [
      selection.binding.businessId,
      selection.binding.integrationId,
      selection.binding.accountId,
      selection.binding.ownerUserId,
      selection.binding.externalAccountId,
      selection.binding.configurationRevision,
    ].some((value) => typeof value !== "string" || !value) ||
    !Number.isSafeInteger(selection.binding.accountRevision) ||
    selection.binding.accountRevision < 1 ||
    selection.files.length === 0 ||
    selection.files.length > MCP_KNOWLEDGE_MAX_SELECTION ||
    !Number.isSafeInteger(selection.pollIntervalMs ?? MCP_KNOWLEDGE_POLL_INTERVAL_MS) ||
    (selection.pollIntervalMs ?? MCP_KNOWLEDGE_POLL_INTERVAL_MS) < 60_000 ||
    (selection.pollIntervalMs ?? MCP_KNOWLEDGE_POLL_INTERVAL_MS) > MCP_KNOWLEDGE_MAX_STALE_MS
  ) {
    throw new McpKnowledgeError("invalid_selection");
  }
  for (const file of selection.files) validateGithubKnowledgeFile(file);
  if (new Set(selection.files.map((file) => canonicalHash(file))).size !== selection.files.length)
    throw new McpKnowledgeError("invalid_selection");
}

/** A scan covers only explicitly selected files. No listing or absence-based deletion is used. */
export async function syncMcpKnowledgeBatch(
  selection: McpKnowledgeSelection,
  deps: McpKnowledgeSyncDeps,
  options: { readonly maxItems?: number; readonly signal?: AbortSignal } = {}
): Promise<McpKnowledgeCheckpoint> {
  validateMcpKnowledgeSelection(selection);
  if (!sameMcpKnowledgeBinding(selection.binding, deps.read.binding))
    throw new McpKnowledgeError("identity_mismatch");
  const maxItems = options.maxItems ?? MCP_KNOWLEDGE_MAX_BATCH;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MCP_KNOWLEDGE_MAX_BATCH)
    throw new McpKnowledgeError("invalid_selection");
  await deps.assertCurrent(selection);
  const prior = await deps.checkpoints.load(selection);
  let checkpoint: McpKnowledgeCheckpoint =
    prior?.selectionRevision === selection.revision && !prior.complete
      ? prior
      : {
          selectionRevision: selection.revision,
          nextIndex: 0,
          synced: 0,
          failed: 0,
          complete: false,
          failures: [],
          updatedAt: deps.now().toISOString(),
        };
  if (
    !Number.isSafeInteger(checkpoint.nextIndex) ||
    checkpoint.nextIndex < 0 ||
    checkpoint.nextIndex >= selection.files.length
  ) {
    throw new McpKnowledgeError("invalid_selection");
  }
  const end = Math.min(checkpoint.nextIndex + maxItems, selection.files.length);
  const timeout = AbortSignal.timeout(60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  for (let index = checkpoint.nextIndex; index < end; index++) {
    signal.throwIfAborted();
    await deps.assertCurrent(selection);
    const file = selection.files[index];
    if (!file) throw new McpKnowledgeError("invalid_selection");
    let failure: McpKnowledgeCheckpoint["failures"][number] | undefined;
    let publishing = false;
    try {
      const document = await readGithubKnowledgeFile(deps.read, selection.binding, file, signal);
      await deps.assertCurrent(selection);
      const now = deps.now().toISOString();
      const sourceId = mcpKnowledgeSourceId(selection.binding, file, selection.id);
      const source: KnowledgeSourceRecord = {
        sourceId,
        businessId: selection.binding.businessId,
        integrationId: selection.binding.integrationId,
        provider: "github",
        externalId: `${file.owner}/${file.repo}/${file.ref}/${file.path}`,
        externalTenantId: file.owner,
        ownerExternalId: selection.binding.externalAccountId,
        sourceLocator: {
          kind: "mcp",
          adapter: "github-file",
          integrationId: selection.binding.integrationId,
          accountId: selection.binding.accountId,
          accountRevision: selection.binding.accountRevision,
          ownerUserId: selection.binding.ownerUserId,
          externalAccountId: selection.binding.externalAccountId,
          configurationRevision: selection.binding.configurationRevision,
          selectionId: selection.id,
          selectionRevision: selection.revision,
          visibility: "personal",
          ...file,
          sourceUrl: document.sourceUrl,
        },
        revision: document.revision,
        classification: ["private"],
        status: "active",
        verification: "verified",
        accessControl: { mode: "live", maximumAgeSeconds: MCP_KNOWLEDGE_MAX_STALE_MS / 1000 },
        provenance: {
          capturedAt: now,
          contentHash: canonicalHash(document.text),
          checkpoint: `${selection.revision}:${index}`,
        },
        lastSyncedAt: now,
      };
      publishing = true;
      const chunks = chunkText(document.text).map((chunk, chunkIndex) => ({
        businessId: source.businessId,
        sourceId,
        chunkId: `${sourceId}:${document.revision}:${chunkIndex}`,
        revision: document.revision,
        classification: source.classification,
        digest: canonicalHash(chunk.content),
        text: chunk.content,
      }));
      if (deps.publishDocument) {
        await deps.publishDocument(source, document, chunks, signal);
      } else {
        const hidden: KnowledgeSourceRecord = { ...source, verification: "unverifiable" };
        await deps.sources.put(hidden);
        await deps.sink.emitSource(hidden);
        await deps.invalidate(source);
        await deps.sink.removeSourceContent(source.businessId, source.sourceId);
        for (const chunk of chunks) await deps.sink.emitChunk(chunk);
        await deps.assertCurrent(selection);
        signal.throwIfAborted();
        await deps.sink.emitSource(source);
        await deps.sources.put(source);
      }
    } catch (error) {
      if (publishing) throw error;
      failure = {
        index,
        code: error instanceof McpKnowledgeError ? error.code : "source_unavailable",
      };
    }
    checkpoint = {
      selectionRevision: selection.revision,
      nextIndex: index + 1,
      synced: checkpoint.synced + (failure ? 0 : 1),
      failed: checkpoint.failed + (failure ? 1 : 0),
      complete: index + 1 === selection.files.length,
      failures: failure ? [...checkpoint.failures, failure] : checkpoint.failures,
      updatedAt: deps.now().toISOString(),
    };
    await deps.checkpoints.save(selection, checkpoint);
  }
  return checkpoint;
}

/** Only a confirmed lifecycle event calls this; transient MCP errors never do. */
export async function removeMcpKnowledgeSource(
  deps: Pick<McpKnowledgeSyncDeps, "sources" | "sink" | "invalidate">,
  input: {
    readonly businessId: string;
    readonly sourceId: string;
    readonly accountId: string;
    readonly reason: "disconnected" | "removed" | "source_deleted" | "source_access_lost";
  }
): Promise<{ readonly outcome: "not_found" | "purged" }> {
  const source = await deps.sources.get(input.businessId, input.sourceId);
  if (!source) return { outcome: "not_found" };
  if (source.sourceLocator?.kind !== "mcp" || source.sourceLocator.accountId !== input.accountId) {
    throw new McpKnowledgeError("identity_mismatch");
  }
  const hidden: KnowledgeSourceRecord = {
    ...source,
    status: input.reason === "source_deleted" || input.reason === "removed" ? "deleted" : "revoked",
    verification: "unverifiable",
  };
  await deps.sources.put(hidden);
  await deps.sink.emitSource(hidden);
  await deps.invalidate(hidden);
  await deps.sink.removeSourceContent(source.businessId, source.sourceId);
  return { outcome: "purged" };
}
