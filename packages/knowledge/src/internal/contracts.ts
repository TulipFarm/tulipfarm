import { sourceDependenciesSchema } from '../authorization/contracts.ts';
import { createRevisionInput } from '@tulipfarm/memory-core/documents/contracts';
export {
  chunkSchema,
  knowledgeLimits,
  providerCoverage,
  sourceInput,
  parserProfileSchema,
  originalSchema,
  lexicalInput,
  proofInput,
  citationSchema,
  KnowledgeAccountChanged,
  KnowledgeError,
  KnowledgeSearchUnavailable,
  type KnowledgeCitation,
} from '@tulipfarm/memory-core/documents/contracts';
export const revisionInput = createRevisionInput(sourceDependenciesSchema);
