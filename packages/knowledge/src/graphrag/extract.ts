import {
  addTokens,
  type ExtractionOutput,
  type GraphChunk,
  type GraphExtractionPort,
  NO_TOKENS,
  type TokenUsage,
} from "./types";

export interface ExtractionStore {
  /** The revision each chunk was last extracted at. A missing entry means never extracted. */
  loadExtractedRevisions(chunkIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  saveExtraction(chunk: GraphChunk, output: ExtractionOutput): Promise<void>;
}

export interface ExtractionDeps {
  readonly port: GraphExtractionPort;
  readonly store: ExtractionStore;
  /** Spend ceiling for one run. Chunks beyond it are left for the next run, not dropped. */
  readonly maxChunks?: number;
  readonly onError?: (chunkId: string, error: unknown) => void;
}

export interface ExtractionReport {
  readonly extracted: number;
  readonly skipped: number;
  readonly failed: readonly string[];
  /** Chunks still owed work, whether budgeted out or failed. Non-zero means run again. */
  readonly remaining: number;
  readonly usage: TokenUsage;
}

/**
 * Extracts entities and relationships from chunks that need it, and only those.
 *
 * Resumable and idempotent by construction: work is keyed on `(chunkId, revision)` and each result
 * is saved as it lands, so a crash costs at most the chunk in flight. A failing chunk is recorded
 * and stepped over — one unparseable document must not stall a corpus.
 */
export async function runExtraction(
  chunks: readonly GraphChunk[],
  deps: ExtractionDeps
): Promise<ExtractionReport> {
  if (chunks.length === 0) {
    return { extracted: 0, skipped: 0, failed: [], remaining: 0, usage: NO_TOKENS };
  }

  const known = await deps.store.loadExtractedRevisions(chunks.map((chunk) => chunk.chunkId));
  const pending = chunks.filter((chunk) => known.get(chunk.chunkId) !== chunk.revision);
  const skipped = chunks.length - pending.length;

  const budget = deps.maxChunks ?? pending.length;
  const selected = pending.slice(0, Math.max(0, budget));

  let usage = NO_TOKENS;
  let extracted = 0;
  const failed: string[] = [];

  for (const chunk of selected) {
    try {
      const output = await deps.port.extract(chunk);
      await deps.store.saveExtraction(chunk, output);
      usage = addTokens(usage, output.usage ?? NO_TOKENS);
      extracted++;
    } catch (error) {
      failed.push(chunk.chunkId);
      deps.onError?.(chunk.chunkId, error);
    }
  }

  return {
    extracted,
    skipped,
    failed,
    remaining: pending.length - extracted,
    usage,
  };
}
