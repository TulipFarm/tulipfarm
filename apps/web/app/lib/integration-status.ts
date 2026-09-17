import {
  getOimConnectionSetup,
  type IntegrationSummary,
  listOimConnections,
  type OimConnectionSummary,
} from "./integrations";

export type ConnectionPresentation = {
  label: string;
  tone: "success" | "warning" | "danger" | "neutral" | "info";
  usable: boolean;
};

export function connectionPresentation(
  connection: OimConnectionSummary,
  now = Date.now()
): ConnectionPresentation {
  const state = (
    label: string,
    tone: ConnectionPresentation["tone"] = "neutral",
    usable = false
  ) => ({ label, tone, usable });
  if (connection.disconnectPending) return state("Disconnecting");
  if (connection.status === "revoked") return state("Revoked");
  if (connection.expiresAt && Date.parse(connection.expiresAt) <= now) {
    return state("Expired", "danger");
  }
  if (connection.health.status === "action_required") return state("Action required", "danger");
  if (connection.setupState === "unavailable") return state("Status unavailable");
  if (
    connection.setupState === "incomplete" ||
    (connection.availableCredentialSlots.length === 0 && !connection.credentialFree)
  ) {
    return state("Setup incomplete", "warning");
  }
  if (connection.health.status === "healthy") return state("Connected", "success", true);
  if (connection.health.status === "expiring") return state("Expires soon", "warning", true);
  return state("Not checked");
}

export function connectionsPresentation(
  connections: OimConnectionSummary[] | undefined
): ConnectionPresentation {
  if (connections === undefined)
    return { label: "Status unavailable", tone: "neutral", usable: false };
  const states = connections.map((connection) => connectionPresentation(connection));
  const usable = states.find((state) => state.usable);
  if (usable) return usable;
  return (
    states.find((state) => state.tone === "danger") ??
    states[0] ?? { label: "Not connected", tone: "neutral", usable: false }
  );
}

/** Healthy credentials alone do not prove that later install/webhook steps are finished. */
export async function resolveConnectionSetupStates(
  name: string,
  connections: OimConnectionSummary[]
): Promise<OimConnectionSummary[]> {
  return Promise.all(
    connections.map(async (connection) => {
      if (
        connection.status !== "active" ||
        connection.disconnectPending ||
        (connection.health.status !== "healthy" && connection.health.status !== "expiring") ||
        (connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())
      )
        return connection;
      try {
        const setup = await getOimConnectionSetup(name, connection.id);
        return {
          ...connection,
          credentialFree:
            setup.initialAuthorizationSteps.length === 0 &&
            !setup.fieldSteps.some((step) => step.fields.some((field) => field.secret)),
          setupState:
            setup.pendingAuthorizationStepIds === undefined
              ? ("unavailable" as const)
              : setup.pendingAuthorizationStepIds.length > 0
                ? ("incomplete" as const)
                : ("complete" as const),
        };
      } catch {
        return { ...connection, setupState: "unavailable" as const };
      }
    })
  );
}

export async function resolveIntegrationStatus(
  integration: IntegrationSummary
): Promise<IntegrationSummary> {
  if (integration.type !== "oim" || !integration.installed) return integration;
  try {
    const connections = await resolveConnectionSetupStates(
      integration.name,
      await listOimConnections(integration.name)
    );
    const connectionState = connectionsPresentation(connections);
    return {
      ...integration,
      connectionState,
      status: connectionState.usable ? "connected" : "disconnected",
    };
  } catch {
    return { ...integration, status: "error", connectionState: connectionsPresentation(undefined) };
  }
}
