import type { McpCapabilityReview } from "@tulipfarm/schema";

export {
  type McpCapabilityReview,
  McpCapabilityReviewSchema,
  type McpConfigure,
  McpConfigureSchema,
  type McpIntegrationDefinition,
  McpIntegrationDefinitionSchema,
  McpPromptReviewSchema,
  McpResourceReviewSchema,
  McpToolReviewSchema,
} from "@tulipfarm/schema";

export function emptyMcpReview(): McpCapabilityReview {
  return { tools: [], resources: [], prompts: [] };
}
