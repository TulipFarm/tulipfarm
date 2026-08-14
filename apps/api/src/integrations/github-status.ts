import type { IntegrationStore } from "@tulipfarm/storage";

/** Read GitHub state live because App installs bypass connection.yaml snapshots. */
export async function isGitHubInstalled(status: {
  integrations: IntegrationStore;
  businessId: string;
}): Promise<boolean> {
  const snapshot = await status.integrations.loadProviderSnapshot(status.businessId, "github");
  return snapshot.integrations.some((integration) => integration.status === "active");
}
