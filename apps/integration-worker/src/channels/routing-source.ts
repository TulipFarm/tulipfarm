import type { ChannelRoutingSnapshot, ChannelRoutingSource } from "@tulipfarm/integrations";
import type { AccessGrantDefinition } from "@tulipfarm/schema";
import type { IntegrationStore } from "@tulipfarm/storage";

/** Reshapes routing rows from null-at-rest to undefined-on-port fields. */
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
