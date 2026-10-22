export { createKnowledgeEmbeddingProvider, prepareKnowledgeEmbeddingInputs } from '../host-ports.ts';
export type {
  EmbeddingError as KnowledgeEmbeddingError,
  EmbeddingUsage as KnowledgeEmbeddingUsage,
  EmbeddingResult as KnowledgeEmbeddingResult,
  EmbeddingProvider as KnowledgeEmbeddingProvider,
} from '@tulipfarm/memory-core/ports/embedding-provider';
