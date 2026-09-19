import type { McpSetupAccess } from "@tulipfarm/schema";

const countLabel = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;

export function mcpAccessMessage(access?: McpSetupAccess): string {
  if (!access) return "Setup is saved. Review the integration's current access before using it.";
  if (!access.enabled) return "This integration is disabled. An admin manages its access settings.";
  switch (access.state) {
    case "allowed":
      return `${countLabel(access.tools, "Tool")}, ${countLabel(access.resources, "resource")} and ${countLabel(access.prompts, "prompt")} allowed. Account permissions and action approvals still apply.`;
    case "discovered_empty":
      return "The provider returned no Tools or content during setup. Check its permissions, then review available access.";
    case "initial_empty":
      return "The initial access policy has no Tools or content. An admin can review available access.";
    case "uninitialized":
      return "An admin needs to finish setting up access.";
    case "preserved_empty":
      return "Existing settings allow no Tools or content; those restrictions are unchanged.";
  }
}
