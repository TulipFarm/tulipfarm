import type { ToolIntent } from "../intent";

export type EffectState =
  | "proposed"
  | "denied"
  | "awaiting_approval"
  | "authorized"
  | "dispatched"
  | "confirmed"
  | "failed"
  | "ambiguous"
  | "compensating"
  | "compensated"
  | "reconciliation_required";

export interface EffectRecord {
  readonly effectId: string;
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly logicalEffectOrdinal: number;
  readonly idempotencyKey: string;
  readonly intentDigest: string;
  readonly intent: ToolIntent;
  readonly guardrailRevision: string;
  readonly approvalId?: string;
  readonly state: EffectState;
  readonly parentEffectId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReserveEffectInput {
  readonly effectId: string;
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly logicalEffectOrdinal: number;
  readonly idempotencyKey: string;
  readonly intentDigest: string;
  readonly intent: ToolIntent;
  readonly guardrailRevision: string;
  readonly approvalId?: string;
  readonly parentEffectId?: string;
  readonly createdAt: string;
}

export interface ReserveEffectResult {
  readonly outcome: "created" | "duplicate";
  readonly effect: EffectRecord;
}

export type EffectAttemptState = "prepared" | "dispatched" | "confirmed" | "failed" | "ambiguous";

export interface EffectAttempt {
  readonly businessId: string;
  readonly effectId: string;
  readonly attempt: number;
  readonly state: EffectAttemptState;
  readonly providerRequestId?: string;
  readonly outputDigest?: string;
  readonly errorCode?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export interface FinishEffectAttemptInput {
  readonly businessId: string;
  readonly effectId: string;
  readonly attempt: number;
  readonly attemptState: Exclude<EffectAttemptState, "prepared" | "dispatched">;
  readonly effectState: EffectState;
  readonly providerRequestId?: string;
  readonly outputDigest?: string;
  readonly errorCode?: string;
  readonly finishedAt: string;
}

export interface TransitionEffectInput {
  readonly businessId: string;
  readonly effectId: string;
  readonly expectedStates: readonly EffectState[];
  readonly state: EffectState;
  readonly updatedAt: string;
}

export type EffectLedgerErrorCode =
  | "idempotency_digest_mismatch"
  | "effect_not_found"
  | "effect_state_conflict"
  | "attempt_not_found";

export class EffectLedgerError extends Error {
  constructor(
    readonly code: EffectLedgerErrorCode,
    readonly reference: string
  ) {
    super(`${code}:${reference}`);
    this.name = "EffectLedgerError";
  }
}
