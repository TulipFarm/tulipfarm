/** Optional vector-search accelerator; never an authorization or correctness boundary. */

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
