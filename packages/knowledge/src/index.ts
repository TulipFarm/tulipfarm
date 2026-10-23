export { createKnowledge } from './internal/store.ts';
export type { KnowledgeOptions, ExternalSource } from './internal/store.ts';
export {
  knowledgeLimits,
  providerCoverage,
  parserProfileSchema,
  embeddingProfileSchema,
  citationSchema,
  KnowledgeAccountChanged,
  KnowledgeError,
} from './internal/contracts.ts';
export type { KnowledgeCitation, EmbeddingProfile } from './internal/contracts.ts';
export { createLocalKnowledge } from './internal/local.ts';
export {
  createConversationKnowledge,
  conversationKnowledgeInputSchema,
  type ConversationKnowledgeInput,
} from './internal/conversation.ts';
export type { LocalKnowledgeOptions } from './internal/local.ts';
export * from './contracts.ts';
export * from './retrieval-contracts.ts';
export * from './embeddings.ts';
export { createKnowledgeEmbeddings } from './internal/embeddings.ts';
export { createKnowledgeSearch } from './internal/search.ts';
export {
  createKnowledgeSourceFailures,
  knowledgeSourceFailureLimit,
  knowledgeSourceFailureSchema,
  knowledgeSourceFailuresSchema,
  type KnowledgeSourceFailures,
} from './internal/source-failures.ts';
export { createGoogleKnowledge, type GoogleKnowledge } from './internal/google.ts';
export * from './google-contracts.ts';
export { createSlackKnowledge, type SlackKnowledge } from './internal/slack.ts';
export * from './slack-contracts.ts';
export { createGitHubKnowledge, type GitHubKnowledge } from './internal/github.ts';
export * from './github-contracts.ts';
export { createAtlassianKnowledge, type AtlassianKnowledge } from './internal/atlassian.ts';
export * from './atlassian-contracts.ts';
export {
  createKnowledgeAgentTools,
  withKnowledgeSourceAuthorization,
  knowledgeCitationIdSchema,
  knowledgeToolSearchSchema,
  knowledgeToolLimits,
  type KnowledgeAgentTools,
  type KnowledgeToolContext,
} from './internal/agent-tools.ts';
export {
  createDefaultKnowledge,
  createDefaultKnowledgeGate,
  defaultKnowledgeStorageVersion,
  recordDefaultKnowledgeIntent,
  defaultKnowledgeFlagEnabled,
  defaultKnowledgeLimits,
  defaultKnowledgeProducts,
  defaultKnowledgeProductSchema,
  defaultKnowledgeIntentInputSchema,
  defaultKnowledgeWorkSchema,
  defaultKnowledgeManageSchema,
  defaultKnowledgeIntentSchema,
  type DefaultKnowledge,
  type DefaultKnowledgeIntent,
  type DefaultKnowledgeIntentInput,
  type DefaultKnowledgeProduct,
  type DefaultKnowledgeWork,
} from './internal/defaults.ts';
export type { KnowledgeSourceGate } from './internal/rolling.ts';
