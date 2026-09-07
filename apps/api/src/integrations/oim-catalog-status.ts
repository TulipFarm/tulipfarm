import type { ConnectionPrincipal, ConnectionUseAuthorizer } from "@tulipfarm/integrations";
import type { PersistedConnection } from "@tulipfarm/storage";

export async function oimCatalogStatus(
  connections: readonly PersistedConnection[],
  requiredSlots: readonly string[],
  principal: ConnectionPrincipal,
  access: ConnectionUseAuthorizer,
  now = Date.now()
): Promise<{ connected: boolean; personalConnected: boolean }> {
  let connected = false;
  let personalConnected = false;
  for (const connection of connections) {
    if (
      connection.status !== "active" ||
      connection.health.status === "action_required" ||
      (connection.expiresAt !== null && Date.parse(connection.expiresAt) <= now) ||
      requiredSlots.some((slot) => connection.secretBindings[slot] === undefined) ||
      !(await access.canUse(principal, connection))
    ) {
      continue;
    }
    connected = true;
    personalConnected ||= connection.owner.scope === "personal";
  }
  return { connected, personalConnected };
}
