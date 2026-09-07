import type { PersistedConnection } from "@tulipfarm/storage";
import type { OimTriggerAuthorizationInput } from "./event-dispatch";

export interface RoutineConnectionUseAuthorizer {
  canUse(input: {
    readonly businessId: string;
    readonly routineRef: { readonly name: string; readonly version: string };
    readonly connection: PersistedConnection;
  }): Promise<boolean>;
}

interface OimTriggerAuthorizationDeps {
  readonly connections: {
    findById(businessId: string, connectionId: string): Promise<PersistedConnection | null>;
  };
  readonly routineConnectionAccess: RoutineConnectionUseAuthorizer;
}

/**
 * Re-authorize the pinned Routine's live owner against the exact live Connection.
 *
 * The normalized provider payload is intentionally absent from this seam: it cannot nominate a
 * TulipFarm user, Team, organization grant, or Connection.
 */
export function oimTriggerAuthorizer(deps: OimTriggerAuthorizationDeps) {
  return async (input: OimTriggerAuthorizationInput): Promise<boolean> => {
    if (
      input.trigger.type !== "integration_event" ||
      input.trigger.protocol !== "oim" ||
      input.trigger.provider !== input.integrationId ||
      input.trigger.integrationMajorVersion !== input.integrationMajorVersion ||
      input.trigger.connectionId !== input.connectionId
    ) {
      return false;
    }

    const connection = await deps.connections.findById(input.businessId, input.connectionId);
    if (
      connection === null ||
      connection.businessId !== input.businessId ||
      connection.status !== "active" ||
      connection.integration.id !== input.integrationId ||
      connection.integration.majorVersion !== input.integrationMajorVersion
    ) {
      return false;
    }

    try {
      return await deps.routineConnectionAccess.canUse({
        businessId: input.businessId,
        routineRef: input.trigger.routineRef,
        connection,
      });
    } catch {
      return false;
    }
  };
}
