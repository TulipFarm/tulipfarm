import type { IntegrationStore } from "@tulipfarm/storage";

/**
 * GitHub is App-install-driven, not soul connection.yaml-driven (the install callback writes
 * straight to IntegrationStore, `github-install-routes.ts`) — so unlike every other bundled
 * integration, its connected state has to be read live from the store rather than a boot-time
 * snapshot. Shared by `integrations/routes.ts` (Connect UI status) and the chat tool-visibility
 * gate (`chat/turn-helpers.ts`) so both ask the same question the same way.
 */
export async function isGitHubInstalled(status: {
  integrations: IntegrationStore;
  businessId: string;
}): Promise<boolean> {
  const snapshot = await status.integrations.loadProviderSnapshot(status.businessId, "github");
  return snapshot.integrations.some((integration) => integration.status === "active");
}
