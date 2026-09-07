import type { IntegrationEvent } from "@tulipfarm/integrations";
import type { EventTriggerGateway } from "./event-dispatch";

interface OimEventDispatchDeps {
  readonly authorizeEvent: (event: IntegrationEvent) => Promise<void>;
  readonly eventTriggers: Pick<EventTriggerGateway, "dispatchIntegrationEvent">;
}

/** Preserve the normalized OIM identity through release authorization and Trigger dispatch. */
export function oimEventDispatcher(deps: OimEventDispatchDeps) {
  return async (event: IntegrationEvent): Promise<void> => {
    await deps.authorizeEvent(event);
    await deps.eventTriggers.dispatchIntegrationEvent(event);
  };
}
