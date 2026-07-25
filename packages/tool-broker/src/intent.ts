import { canonicalHash } from "@tulipfarm/schema";

export interface ToolTargetRef {
  readonly type: string;
  readonly id: string;
}

export interface ToolIntent {
  readonly intentId: string;
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly action: string;
  readonly targetRefs: readonly ToolTargetRef[];
  readonly arguments: unknown;
  readonly destination?: string;
  readonly credentialRef?: string;
  readonly idempotencyKey: string;
}

export type ToolIntentErrorCode =
  | "invalid_intent"
  | "invalid_arguments"
  | "unknown_contract"
  | "contract_mismatch";

export class ToolIntentError extends Error {
  constructor(readonly code: ToolIntentErrorCode) {
    super(code);
    this.name = "ToolIntentError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || nonEmptyString(value);
}

export function normalizeToolIntent(input: unknown): ToolIntent {
  if (
    !record(input) ||
    !nonEmptyString(input.intentId) ||
    !nonEmptyString(input.businessId) ||
    !nonEmptyString(input.runId) ||
    !nonEmptyString(input.stateId) ||
    !nonEmptyString(input.toolId) ||
    !nonEmptyString(input.toolVersion) ||
    !nonEmptyString(input.action) ||
    !Array.isArray(input.targetRefs) ||
    !optionalString(input.destination) ||
    !optionalString(input.credentialRef) ||
    !nonEmptyString(input.idempotencyKey)
  ) {
    throw new ToolIntentError("invalid_intent");
  }

  const targetRefs: ToolTargetRef[] = [];
  for (const target of input.targetRefs) {
    if (!record(target) || !nonEmptyString(target.type) || !nonEmptyString(target.id)) {
      throw new ToolIntentError("invalid_intent");
    }
    targetRefs.push(Object.freeze({ type: target.type, id: target.id }));
  }

  const intent = {
    intentId: input.intentId,
    businessId: input.businessId,
    runId: input.runId,
    stateId: input.stateId,
    toolId: input.toolId,
    toolVersion: input.toolVersion,
    action: input.action,
    targetRefs: Object.freeze(targetRefs),
    arguments: structuredClone(input.arguments),
    destination: input.destination,
    credentialRef: input.credentialRef,
    idempotencyKey: input.idempotencyKey,
  };
  intentDigest(intent);
  return Object.freeze(intent);
}

export function intentDigest(intent: ToolIntent): string {
  return canonicalHash({
    toolId: intent.toolId,
    toolVersion: intent.toolVersion,
    action: intent.action,
    targetRefs: intent.targetRefs,
    arguments: intent.arguments,
    destination: intent.destination ?? null,
    credentialRef: intent.credentialRef ?? null,
  });
}
