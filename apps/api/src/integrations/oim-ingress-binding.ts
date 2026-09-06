import type { WebhookBinding } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import type { ConnectionStore } from "@tulipfarm/storage";

/**
 * Answers the two questions the OIM webhook receiver asks about an installed Integration: whose
 * manifest describes this endpoint, and which Connection holds the Secret that signs its
 * deliveries.
 */

export interface InstalledOimIntegration {
  readonly businessId: string;
  readonly manifest: OimManifest;
}

/**
 * Resolves the Integration an inbound delivery names.
 *
 * OIM Connection state is durable Postgres state, not the legacy `connection.yaml` flag. The
 * binding lookup below limits a delivery to an active Connection and its live delivery Secret.
 */
export function oimIngressResolver(
  soulLoader: SoulLoader,
  businessId: string
): (slug: string) => Promise<InstalledOimIntegration | null> {
  return async (slug) => {
    const integration = soulLoader.integrations.get(slug);
    const manifest = integration?.oimManifest;
    if (!manifest?.events) return null;
    return { businessId, manifest };
  };
}

/**
 * Finds the Connection whose Secret signs deliveries for one Integration.
 *
 * An unqualified webhook URL may use only an organization Connection. A Team Connection has a
 * connection-specific URL, because choosing between Teams from provider traffic would be
 * ambiguous. Personal Connections never qualify: a webhook has no human principal.
 */
export function oimWebhookBinding(
  connections: Pick<ConnectionStore, "findById" | "listForOwner">
): (request: {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly secretSlot: string;
  readonly connectionId?: string;
}) => Promise<WebhookBinding | null> {
  return async (request) => {
    const integration = { id: request.integrationId, majorVersion: request.majorVersion };
    const candidates =
      request.connectionId === undefined
        ? await connections.listForOwner(request.businessId, integration, { scope: "organization" })
        : await connections
            .findById(request.businessId, request.connectionId)
            .then((connection) => (connection?.owner.scope === "team" ? [connection] : []));
    const usable = candidates.filter(
      (connection) =>
        connection.status === "active" &&
        connection.integration.id === integration.id &&
        connection.integration.majorVersion === integration.majorVersion &&
        typeof connection.secretBindings[request.secretSlot] === "string"
    );
    // A default is an operator's explicit answer to "which one"; without one, a single candidate
    // is unambiguous and more than one is not something this seam may guess at.
    const chosen =
      usable.find((connection) => connection.isDefault) ??
      (usable.length === 1 ? usable[0] : undefined);
    if (!chosen) return null;

    const secretRef = chosen.secretBindings[request.secretSlot];
    if (typeof secretRef !== "string") return null;
    return { connectionId: chosen.id, secretRef };
  };
}
