/**
 * Provider-neutral vector-search port.
 *
 * Capability id `vector` (optional accelerator — see `@tulipfarm/observability`
 * capability catalog). pgvector is one adapter; correctness and ACLs never depend
 * on it (invariant 16). Knowledge authorization happens before this port is
 * queried, so a vector result is never an authorization decision.
 */

export type VectorMetadata = Readonly<Record<string, string | number | boolean>>;

export interface VectorMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata?: VectorMetadata;
}

export interface VectorPort {
  upsert(id: string, embedding: readonly number[], metadata?: VectorMetadata): Promise<void>;
  query(embedding: readonly number[], k: number): Promise<VectorMatch[]>;
  delete(id: string): Promise<void>;
}
