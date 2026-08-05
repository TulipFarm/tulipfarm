import type { ChannelRoutingSnapshot, ChannelRoutingSource } from "@tulipfarm/integrations";
import type { AccessGrantDefinition } from "@tulipfarm/schema";
import type { IntegrationStore } from "@tulipfarm/storage";

/**
 * Adapts `IntegrationStore.loadRoutingSnapshot` to the `ChannelRoutingSource` port. The persisted
 * rows and the port's snapshot types are structurally identical except for how an unset
 * `channelId`/`threadId` is spelled — `null` at rest, `undefined` on the port — so this is a pure
 * reshape, no query logic of its own.
 */
export function channelRoutingSource(store: IntegrationStore): ChannelRoutingSource {
  return {
    async load(input): Promise<ChannelRoutingSnapshot> {
      const snapshot = await store.loadRoutingSnapshot(
        input.businessId,
        input.provider,
        input.externalTenantId
      );
      return {
        apps: snapshot.apps.map((app) => ({
          id: app.id,
          businessId: app.businessId,
          provider: app.provider,
          externalAppId: app.externalAppId,
          credentialRefs: app.credentialRefs,
          status: app.status,
        })),
        integrations: snapshot.integrations.map((integration) => ({
          id: integration.id,
          businessId: integration.businessId,
          appId: integration.appId,
          externalTenantId: integration.externalTenantId,
          status: integration.status,
          ...(integration.externalAccountId === undefined
            ? {}
            : { externalAccountId: integration.externalAccountId }),
          ...(integration.credentialRef === undefined
            ? {}
            : { credentialRef: integration.credentialRef }),
        })),
        accessGrants: snapshot.accessGrants.map(
          (grant) => grant.definition as AccessGrantDefinition
        ),
        routes: snapshot.routes.map((route) => ({
          id: route.id,
          businessId: route.businessId,
          integrationId: route.integrationId,
          agentId: route.agentId,
          eventTypes: route.eventTypes,
          priority: route.priority,
          status: route.status,
          ...(route.channelId === null ? {} : { channelId: route.channelId }),
          ...(route.threadId === null ? {} : { threadId: route.threadId }),
        })),
      };
    },
  };
}
