import { sourceDependenciesSchema } from '../authorization/contracts.ts';
import { createRevisionInput } from '@tulipfarm/memory-core/documents/contracts';
export {
  chunkSchema,
  knowledgeLimits,
  providerCoverage,
  sourceInput,
  parserProfileSchema,
  embeddingProfileSchema,
  originalSchema,
  lexicalInput,
  proofInput,
  citationSchema,
  KnowledgeAccountChanged,
  KnowledgeError,
  type KnowledgeCitation,
  type EmbeddingProfile,
} from '@tulipfarm/memory-core/documents/contracts';
export const revisionInput = createRevisionInput(sourceDependenciesSchema);
