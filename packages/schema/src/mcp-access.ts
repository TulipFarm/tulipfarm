import type { McpIntegrationDefinition } from "./mcp";
import type { McpSetupAccess } from "./mcp-setup";

/** Saved policy, not account authentication or this Turn's effective Tool authority. */
export function describeMcpAccess(definition: McpIntegrationDefinition): McpSetupAccess {
  const { tools, resources, prompts } = definition.reviewed;
  return {
    enabled: definition.enabled,
    tools: tools.length,
    resources: resources.length,
    prompts: prompts.length,
    state:
      tools.length + resources.length + prompts.length > 0
        ? "allowed"
        : definition.reviewPolicy === "uninitialized"
          ? "uninitialized"
          : definition.reviewPolicy === "initial"
            ? "initial_empty"
            : "preserved_empty",
  };
}
