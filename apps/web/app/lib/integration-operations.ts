import { apiGet, apiWrite } from "./api";

export interface KnowledgeSubscription {
  sourceKindId: string;
  scopes: string[];
  enabled: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCodes: string[];
}

export interface IntegrationOperationsView {
  sourceKinds: { id: string; label: string; description?: string }[];
  liveAuthorization: boolean;
  ingress: string | null;
  observedAt: string;
  connections: {
    connectionId: string;
    label: string;
    authorization: string;
    disconnectPending: boolean;
    subscriptions: KnowledgeSubscription[];
    operations: {
      webhook: {
        state: string;
        desiredState: string;
        attempts: number;
        nextAttemptAt: string;
        hasError: boolean;
        updatedAt: string;
      } | null;
      delivery: {
        pending: number;
        retrying: number;
        deadLetter: number;
        dispatched: number;
        nextAttemptAt: string | null;
        hasError: boolean;
      };
      polling: { nextPollAt: string; leaseExpiresAt: string | null } | null;
      sync: {
        sourceKindId: string;
        scope: string;
        inProgress: boolean;
        pendingDeletions: number;
        requiresFullRebuild: boolean;
        updatedAt: string;
      }[];
    };
  }[];
}

const base = (key: string) => `/api/v1/integrations/${encodeURIComponent(key)}`;

export function getIntegrationOperations(key: string, signal?: AbortSignal) {
  return apiGet<IntegrationOperationsView>(`${base(key)}/operations`, { signal });
}

export function saveKnowledgeSubscription(
  key: string,
  connectionId: string,
  subscription: Pick<KnowledgeSubscription, "sourceKindId" | "scopes" | "enabled">
) {
  return apiWrite<KnowledgeSubscription>(
    "PUT",
    `${base(key)}/connections/${encodeURIComponent(connectionId)}/knowledge-subscription`,
    subscription
  );
}
