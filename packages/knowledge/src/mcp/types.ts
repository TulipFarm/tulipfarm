import type { KnowledgeSourceRecord, MutableKnowledgeSourceStore } from "../source";

export { GITHUB_KNOWLEDGE_IMAGE, GITHUB_KNOWLEDGE_SERVER_REVISION } from "@tulipfarm/schema";

export const MCP_KNOWLEDGE_POLL_INTERVAL_MS = 15 * 60 * 1000;
export const MCP_KNOWLEDGE_MAX_STALE_MS = 24 * 60 * 60 * 1000;
export const MCP_KNOWLEDGE_MAX_SELECTION = 1000;
export const MCP_KNOWLEDGE_MAX_BATCH = 20;
export const MCP_KNOWLEDGE_MAX_FILE_BYTES = 256 * 1024;

export interface McpKnowledgeBinding {
  readonly businessId: string;
  readonly integrationId: string;
  readonly accountId: string;
  readonly accountRevision: number;
  readonly ownerUserId: string;
  readonly externalAccountId: string;
  readonly configurationRevision: string;
}

export interface GithubKnowledgeFile {
  readonly owner: string;
  readonly repo: string;
  readonly path: string;
  readonly ref: string;
}

export interface McpKnowledgeSelection {
  readonly id: string;
  readonly revision: string;
  readonly binding: McpKnowledgeBinding;
  readonly visibility: "personal" | "shared";
  readonly enabled: boolean;
  readonly files: readonly GithubKnowledgeFile[];
  readonly pollIntervalMs?: number;
}

/** The host binds credentials and checks current account/selection authority before every call. */
export interface McpKnowledgeReadPort {
  readonly binding: McpKnowledgeBinding;
  readonly readerUserId: string;
  readonly server: { readonly distribution: "github-official-local"; readonly revision: string };
  callTool(input: {
    readonly name: "get_me" | "get_file_contents";
    readonly arguments: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }): Promise<{ readonly isError?: boolean; readonly content: readonly unknown[] }>;
}

export interface McpKnowledgeDocument {
  readonly text: string;
  readonly revision: string;
  readonly sourceUrl: string;
}

export type McpKnowledgeFailureCode =
  | "unsupported_source"
  | "unsupported_shared_sync"
  | "invalid_selection"
  | "identity_mismatch"
  | "source_unavailable"
  | "source_too_large"
  | "source_response_invalid"
  | "selection_changed"
  | "publication_failed";

export class McpKnowledgeError extends Error {
  constructor(readonly code: McpKnowledgeFailureCode) {
    super(code);
    this.name = "McpKnowledgeError";
  }
}

export interface McpKnowledgeCheckpoint {
  readonly selectionRevision: string;
  readonly nextIndex: number;
  readonly synced: number;
  readonly failed: number;
  readonly complete: boolean;
  readonly failures: readonly {
    readonly index: number;
    readonly code: McpKnowledgeFailureCode;
  }[];
  readonly updatedAt: string;
}

export interface McpKnowledgeCheckpointPort {
  load(selection: McpKnowledgeSelection): Promise<McpKnowledgeCheckpoint | undefined>;
  save(selection: McpKnowledgeSelection, checkpoint: McpKnowledgeCheckpoint): Promise<void>;
}

export interface McpKnowledgeChunk {
  readonly businessId: string;
  readonly sourceId: string;
  readonly chunkId: string;
  readonly revision: string;
  readonly classification: readonly string[];
  readonly digest: string;
  readonly text: string;
}

/** Structurally compatible with the Integration emission sink; never creates authored Pages. */
export interface McpKnowledgeSink {
  emitSource(source: KnowledgeSourceRecord): Promise<void>;
  emitChunk(chunk: McpKnowledgeChunk): Promise<void>;
  removeSourceContent(businessId: string, sourceId: string): Promise<void>;
}

export interface McpKnowledgeSyncDeps {
  readonly sources: MutableKnowledgeSourceStore;
  readonly sink: McpKnowledgeSink;
  readonly checkpoints: McpKnowledgeCheckpointPort;
  readonly read: McpKnowledgeReadPort;
  readonly now: () => Date;
  /** Throws on changed, disabled, disconnected, or unauthorized selections. No cached grants. */
  readonly assertCurrent: (selection: McpKnowledgeSelection) => Promise<void>;
  /** Complete existing invalidation before publication; persist unfinished jobs and throw on failure. */
  readonly invalidate: (source: KnowledgeSourceRecord) => Promise<void>;
  readonly publishDocument?: (
    source: KnowledgeSourceRecord,
    document: McpKnowledgeDocument,
    chunks: readonly McpKnowledgeChunk[],
    signal: AbortSignal
  ) => Promise<void>;
}
