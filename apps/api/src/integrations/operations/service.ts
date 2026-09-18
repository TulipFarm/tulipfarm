import {
  OimKnowledgeSubscriptionStore,
  OimOperationsStore,
  type Queryable,
} from "@tulipfarm/storage";
import {
  type ConnectionActor,
  OimConnectionRequestError,
  type OimConnectionService,
} from "../connections/service";

export interface SaveKnowledgeSubscription {
  readonly sourceKindId: string;
  readonly scopes: readonly string[];
  readonly enabled: boolean;
}

export class IntegrationOperationsService {
  private readonly subscriptions: OimKnowledgeSubscriptionStore;
  private readonly operations: OimOperationsStore;

  constructor(
    private readonly connections: OimConnectionService,
    queryable: Queryable
  ) {
    this.subscriptions = new OimKnowledgeSubscriptionStore(queryable);
    this.operations = new OimOperationsStore(queryable);
  }

  async read(key: string, actor: ConnectionActor) {
    const connections = await this.connections.list(key, actor);
    return {
      ...this.connections.operationsCapabilities(key),
      observedAt: new Date().toISOString(),
      connections: await Promise.all(
        connections.map(async (connection) => ({
          connectionId: connection.id,
          label: connection.label,
          authorization: connection.health.status,
          disconnectPending: await this.connections.isDisconnecting(connection.id),
          subscriptions: await this.subscriptions.list(connection.businessId, connection.id),
          operations: await this.operations.read(connection.businessId, connection.id),
        }))
      ),
    };
  }

  async save(
    key: string,
    connectionId: string,
    actor: ConnectionActor,
    input: SaveKnowledgeSubscription
  ) {
    const connection = await this.connections.get(key, connectionId, actor);
    const capabilities = this.connections.operationsCapabilities(key);
    if (!capabilities.sourceKinds.some(({ id }) => id === input.sourceKindId)) {
      throw new OimConnectionRequestError(400, "knowledge_source_kind_not_declared");
    }
    if (
      input.enabled &&
      (connection.status !== "active" ||
        !["healthy", "expiring"].includes(connection.health.status) ||
        (connection.expiresAt !== null && Date.parse(connection.expiresAt) <= Date.now()) ||
        (await this.connections.isDisconnecting(connection.id)))
    ) {
      throw new OimConnectionRequestError(409, "connection_authorization_required");
    }
    const existing = (await this.subscriptions.list(connection.businessId, connectionId)).find(
      ({ sourceKindId }) => sourceKindId === input.sourceKindId
    );
    return this.subscriptions.save({
      businessId: connection.businessId,
      integrationSlug: key,
      integrationId: connection.integration.id,
      integrationMajorVersion: connection.integration.majorVersion,
      connectionId,
      sourceKindId: input.sourceKindId,
      scopes: input.scopes,
      enabled: input.enabled,
      classification: existing?.classification ?? ["internal"],
      aclMaximumAgeSeconds: existing?.aclMaximumAgeSeconds ?? 300,
      liveMaximumAgeSeconds: existing?.liveMaximumAgeSeconds ?? 60,
    });
  }
}
