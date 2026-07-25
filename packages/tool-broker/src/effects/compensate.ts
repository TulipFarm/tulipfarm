import type { ToolAuthorizationContext } from "../authorize";
import type { ToolBroker } from "../broker";
import type { ToolCatalog } from "../catalog";
import type { ToolIntent } from "../intent";
import { EffectLedgerError, type ReserveEffectResult } from "./model";
import type { EffectStore } from "./store";

export type CompensationErrorCode =
  | "original_effect_not_found"
  | "original_effect_not_confirmed"
  | "compensation_not_declared"
  | "compensation_intent_mismatch"
  | "compensation_denied";

export class CompensationError extends Error {
  constructor(
    readonly code: CompensationErrorCode,
    readonly effectId: string
  ) {
    super(`${code}:${effectId}`);
    this.name = "CompensationError";
  }
}

export interface AuthorizeCompensationInput {
  readonly originalEffectId: string;
  readonly effectId: string;
  readonly logicalEffectOrdinal: number;
  readonly intent: ToolIntent;
  readonly authorization: ToolAuthorizationContext;
  readonly createdAt: string;
  readonly approvalId?: string;
}

export interface EffectCompensatorDeps {
  readonly store: EffectStore;
  readonly broker: ToolBroker;
  readonly catalog: ToolCatalog;
}

export class EffectCompensator {
  constructor(private readonly deps: EffectCompensatorDeps) {}

  async authorizeAndReserve(input: AuthorizeCompensationInput): Promise<ReserveEffectResult> {
    const original = await this.deps.store.get(input.intent.businessId, input.originalEffectId);
    if (original === undefined) {
      throw new CompensationError("original_effect_not_found", input.originalEffectId);
    }
    if (original.state !== "confirmed") {
      throw new CompensationError("original_effect_not_confirmed", input.originalEffectId);
    }
    const originalContract = this.deps.catalog.get(
      original.intent.toolId,
      original.intent.toolVersion
    );
    const operation = originalContract?.compensation?.operation;
    if (operation === undefined) {
      throw new CompensationError("compensation_not_declared", input.originalEffectId);
    }
    if (
      input.intent.businessId !== original.businessId ||
      input.intent.runId !== original.runId ||
      input.intent.action !== operation
    ) {
      throw new CompensationError("compensation_intent_mismatch", input.originalEffectId);
    }

    const authorization = this.deps.broker.authorize(input.intent, input.authorization);
    if (authorization.outcome !== "authorized") {
      throw new CompensationError("compensation_denied", input.originalEffectId);
    }
    try {
      return await this.deps.store.reserveCompensation(
        {
          effectId: input.effectId,
          businessId: original.businessId,
          runId: original.runId,
          stateId: original.stateId,
          logicalEffectOrdinal: input.logicalEffectOrdinal,
          idempotencyKey: authorization.intent.idempotencyKey,
          intentDigest: authorization.intentDigest,
          intent: authorization.intent,
          guardrailRevision: authorization.guardrailRevision,
          approvalId: input.approvalId,
          createdAt: input.createdAt,
        },
        original.effectId
      );
    } catch (error) {
      if (error instanceof EffectLedgerError && error.code === "effect_state_conflict") {
        throw new CompensationError("original_effect_not_confirmed", input.originalEffectId);
      }
      throw error;
    }
  }
}
