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
    outcome: 'ready' | 'skipped' | 'error',
    reason?: string,
    diagnostics?: KnowledgeParseDiagnostics & { error?: unknown },
  ): void;
};
