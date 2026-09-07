import { canonicalHash } from "@tulipfarm/schema";

export interface ToolTargetRef {
  readonly type: string;
  readonly id: string;
  readonly domain?: string;
}

export interface ToolConnectionBinding {
  readonly connectionId: string;
  readonly integrationId: string;
  readonly credentialSlot: string;
  readonly principalKind?: string;
  readonly principalId?: string;
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
  /** The person whose File ACL permits an OIM upload or receives an OIM binary response. */
  readonly filePrincipalId?: string;
  readonly destination?: string;
  readonly credentialRef?: string;
  readonly connection?: ToolConnectionBinding;
  /** A second bounded credential for an operation that declares `secondaryCredential`. */
  readonly secondaryCredentialRef?: string;
  readonly secondaryConnection?: ToolConnectionBinding;
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

function connectionBinding(value: unknown): value is ToolConnectionBinding | undefined {
  if (value === undefined) return true;
  if (
    !record(value) ||
    !nonEmptyString(value.connectionId) ||
    !nonEmptyString(value.integrationId) ||
    !nonEmptyString(value.credentialSlot) ||
    !optionalString(value.principalKind) ||
    !optionalString(value.principalId)
  ) {
    return false;
  }
  return (value.principalKind === undefined) === (value.principalId === undefined);
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
    !optionalString(input.filePrincipalId) ||
    !optionalString(input.destination) ||
    !optionalString(input.credentialRef) ||
    !optionalString(input.secondaryCredentialRef) ||
    !connectionBinding(input.connection) ||
    !connectionBinding(input.secondaryConnection) ||
    (input.connection !== undefined &&
      (input.credentialRef === undefined ||
        !input.credentialRef.startsWith("secret://") ||
        input.destination === undefined)) ||
    ((input.secondaryCredentialRef !== undefined || input.secondaryConnection !== undefined) &&
      (input.credentialRef === undefined || input.connection === undefined)) ||
    (input.secondaryConnection !== undefined &&
      (input.secondaryCredentialRef === undefined ||
        !input.secondaryCredentialRef.startsWith("secret://") ||
        input.destination === undefined)) ||
    !nonEmptyString(input.idempotencyKey)
  ) {
    throw new ToolIntentError("invalid_intent");
  }

  const targetRefs: ToolTargetRef[] = [];
  for (const target of input.targetRefs) {
    if (
      !record(target) ||
      !nonEmptyString(target.type) ||
      !nonEmptyString(target.id) ||
      !optionalString(target.domain)
    ) {
      throw new ToolIntentError("invalid_intent");
    }
    targetRefs.push(
      Object.freeze({
        type: target.type,
        id: target.id,
        ...(target.domain === undefined ? {} : { domain: target.domain }),
      })
    );
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
    ...(input.filePrincipalId === undefined ? {} : { filePrincipalId: input.filePrincipalId }),
    destination: input.destination,
    credentialRef: input.credentialRef,
    ...(input.connection === undefined
      ? {}
      : { connection: Object.freeze({ ...input.connection }) }),
    secondaryCredentialRef: input.secondaryCredentialRef,
    ...(input.secondaryConnection === undefined
      ? {}
      : { secondaryConnection: Object.freeze({ ...input.secondaryConnection }) }),
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
    filePrincipalId: intent.filePrincipalId ?? null,
    destination: intent.destination ?? null,
    credentialRef: intent.credentialRef ?? null,
    connection: intent.connection ?? null,
    secondaryCredentialRef: intent.secondaryCredentialRef ?? null,
    secondaryConnection: intent.secondaryConnection ?? null,
  });
}
