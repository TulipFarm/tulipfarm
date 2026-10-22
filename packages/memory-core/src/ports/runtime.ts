import type { KnowledgeParseDiagnostics } from '../parser/contracts.js';

export type Clock = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

export type EgressPolicy = {
  deny(): void;
};

export type FeatureFlags<Name extends string = string> = {
  enabled(name: Name, principalId: string, tenantId: string): Promise<boolean>;
};

export type Telemetry = {
  recordImport(
    stage: 'item' | 'source',
    outcome: 'ready' | 'error',
    reason?: string,
    diagnostics?: KnowledgeParseDiagnostics & { error?: unknown },
  ): void;
};

export type UsageAdmission = {
  id: string;
  operationId: string;
  modelId: string;
  profileId: string;
  pricingRevision: string;
  purpose: 'ingestion' | 'query' | 'reindex';
  attribution: { kind: 'member' | 'source'; id: string };
  taskFlowId: string | null;
  upperProviderPicoUsd: string;
};
export type UsageOutcome =
  | {
      kind: 'known';
      attemptId: string;
      providerPicoUsd: string;
      inputTokens: string;
      providerRequestId: string | null;
    }
  | { kind: 'unknown' | 'undispatched' | 'marked-undispatched'; attemptId: string };
export type UsageRecord = {
  readonly workspaceId: string;
  readonly flowId: string;
  readonly modelId: string;
  readonly agentId: string | null;
  readonly activity: 'knowledge-query' | 'knowledge-ingestion';
  readonly inputTokens: number;
  readonly providerPicoUsd: string;
  readonly at: Date;
};
export type UsageMeter<Transaction> = {
  cost(input: { inputTokens: number; date: string }): {
    providerPicoUsd: string;
    pricingRevision: string;
    date: string;
  };
  reserve(transaction: Transaction, admission: UsageAdmission): Promise<unknown>;
  markDispatched(transaction: Transaction, attemptId: string): Promise<boolean>;
  outcome(transaction: Transaction, outcome: UsageOutcome): Promise<unknown>;
  record(usage: UsageRecord): Promise<void>;
};
