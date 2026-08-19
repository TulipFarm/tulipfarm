import type { KnowledgeSubjectKind } from "../subject";

/** A unit of indexed text the graph builder reads. One chunk, one extraction call. */
export interface GraphChunk {
  readonly chunkId: string;
  readonly subjectKind: KnowledgeSubjectKind;
  readonly subjectId: string;
  /** Changes whenever the text changes. Extraction is keyed on it, so a rebuild is cheap. */
  readonly revision: string;
  readonly text: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const NO_TOKENS: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export interface ExtractedEntity {
  readonly name: string;
  readonly type: string;
  readonly description: string;
}

export interface ExtractedRelationship {
  readonly source: string;
  readonly target: string;
  readonly description: string;
  readonly weight?: number;
}

export interface ExtractedClaim {
  readonly subject: string;
  readonly statement: string;
}

/** Exactly what the model is allowed to return. Note the absence of any provenance field. */
export interface ExtractionOutput {
  readonly entities: readonly ExtractedEntity[];
  readonly relationships: readonly ExtractedRelationship[];
  readonly claims: readonly ExtractedClaim[];
  readonly usage?: TokenUsage;
}

/**
 * The LLM seam. `@tulipfarm/llm` is not on this package's import allow-list, so the model arrives
 * as an injected port and the package stays testable without one.
 *
 * Takes a single chunk rather than a batch on purpose: provenance is then a fact about which chunk
 * this process fed the model, not a field the model could get wrong or be talked into forging.
 */
export interface GraphExtractionPort {
  extract(chunk: GraphChunk): Promise<ExtractionOutput>;
}

export interface GraphEntityRecord {
  readonly entityId: string;
  readonly businessId: string;
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly sourceChunkIds: readonly string[];
}

export interface GraphEdgeRecord {
  readonly edgeId: string;
  readonly businessId: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly description: string;
  readonly weight: number;
  readonly sourceChunkIds: readonly string[];
}

export interface GraphCommunityRecord {
  readonly communityId: string;
  readonly businessId: string;
  readonly level: number;
  readonly entityIds: readonly string[];
  readonly parentCommunityId?: string;
}

export interface GraphCommunitySummaryRecord {
  readonly communityId: string;
  readonly businessId: string;
  readonly buildId: string;
  readonly title: string;
  readonly summary: string;
  /** Every chunk that contributed. Revalidated against the gate on every single query. */
  readonly provenanceChunkIds: readonly string[];
  readonly usage: TokenUsage;
}

export interface ChildSummary {
  readonly communityId: string;
  readonly title: string;
  readonly summary: string;
}

export interface CommunitySummaryInput {
  readonly communityId: string;
  readonly level: number;
  readonly entities: readonly GraphEntityRecord[];
  readonly edges: readonly GraphEdgeRecord[];
  readonly childSummaries: readonly ChildSummary[];
}

export interface SummaryOutput {
  readonly title: string;
  readonly summary: string;
  readonly usage?: TokenUsage;
}

/**
 * The summarising model. Everything it is shown has already been cleared for a blanket audience —
 * it is never given material to redact, because a model cannot be trusted to redact.
 */
export interface GraphSummaryPort {
  summarize(input: CommunitySummaryInput): Promise<SummaryOutput>;
}

/**
 * Names an entity stably, so re-running extraction merges rather than duplicates.
 *
 * The separator is the ASCII unit separator, not NUL: Postgres `text` cannot hold a NUL byte and
 * rejects the whole statement if you try.
 */
export function entityKey(businessId: string, name: string, type: string): string {
  return `${businessId}\u001f${type.trim().toLowerCase()}\u001f${name.trim().toLowerCase()}`;
}

export function edgeKey(businessId: string, source: string, target: string): string {
  // Undirected: a→b and b→a are the same edge.
  const [low, high] = [source, target].sort();
  return `${businessId}\u001f${low}\u001f${high}`;
}
