import { approvalIntentDigest } from "@tulipfarm/authz";
import { ajv, type McpExecutionBinding, McpExecutionBindingSchema } from "@tulipfarm/schema";

const isMcpBinding = ajv.compile<McpExecutionBinding>(McpExecutionBindingSchema);

export interface ToolTargetRef {
  readonly type: string;
  readonly id: string;
  readonly domain?: string;
}

export interface ToolIntent {
  readonly intentId: string;
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  /** Run State occurrence that owns waits for this Tool call. */
  readonly runStateId?: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly action: string;
  readonly targetRefs: readonly ToolTargetRef[];
  readonly arguments: unknown;
  /** The Principal whose File ACL authorizes upload reads and owns downloaded Files. */
  readonly filePrincipalId?: string;
  /** Exact multipart File targets, sorted and unique. */
  readonly fileIds?: readonly string[];
  /** The permanent Agent Principal whose live authority also bounds File reads. */
  readonly agentPrincipalId?: string;
  readonly principalKind?: string;
  readonly principalId?: string;
  readonly activeSkillName?: string;
  readonly destination?: string;
  readonly credentialRef?: string;
  readonly mcp?: McpExecutionBinding;
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

const RETIRED_INTENT_FIELDS = [
  "integrationId",
  "integrationMajorVersion",
  "operationId",
  "manifestDigest",
  "configurationDigest",
  "connection",
  "secondaryCredentialRef",
  "secondaryConnection",
] as const;

function fileIds(value: unknown): value is readonly string[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !value.every(nonEmptyString)) return false;
  return value.every((fileId, index) => index === 0 || value[index - 1] < fileId);
}

export function normalizeToolIntent(input: unknown): ToolIntent {
  if (
    !record(input) ||
    !nonEmptyString(input.intentId) ||
    !nonEmptyString(input.businessId) ||
    !nonEmptyString(input.runId) ||
    !nonEmptyString(input.stateId) ||
    !optionalString(input.runStateId) ||
    !nonEmptyString(input.toolId) ||
    !nonEmptyString(input.toolVersion) ||
    !nonEmptyString(input.action) ||
    !Array.isArray(input.targetRefs) ||
    !optionalString(input.filePrincipalId) ||
    !fileIds(input.fileIds) ||
    !optionalString(input.agentPrincipalId) ||
    !optionalString(input.principalKind) ||
    !optionalString(input.principalId) ||
    (input.principalKind === undefined) !== (input.principalId === undefined) ||
    !optionalString(input.activeSkillName) ||
    RETIRED_INTENT_FIELDS.some((field) => input[field] !== undefined) ||
    !optionalString(input.destination) ||
    !optionalString(input.credentialRef) ||
    (input.mcp !== undefined && !isMcpBinding(input.mcp)) ||
    (input.mcp !== undefined && input.credentialRef !== undefined) ||
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
    ...(input.runStateId === undefined ? {} : { runStateId: input.runStateId }),
    toolId: input.toolId,
    toolVersion: input.toolVersion,
    action: input.action,
    targetRefs: Object.freeze(targetRefs),
    arguments: structuredClone(input.arguments),
    ...(input.filePrincipalId === undefined ? {} : { filePrincipalId: input.filePrincipalId }),
    ...(input.fileIds === undefined ? {} : { fileIds: Object.freeze([...input.fileIds]) }),
    ...(input.agentPrincipalId === undefined ? {} : { agentPrincipalId: input.agentPrincipalId }),
    ...(input.principalKind === undefined ? {} : { principalKind: input.principalKind }),
    ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
    ...(input.activeSkillName === undefined ? {} : { activeSkillName: input.activeSkillName }),
    destination: input.destination,
    credentialRef: input.credentialRef,
    ...(input.mcp === undefined ? {} : { mcp: Object.freeze({ ...input.mcp }) }),
    idempotencyKey: input.idempotencyKey,
  };
  intentDigest(intent);
  return Object.freeze(intent);
}

export function intentDigest(intent: ToolIntent): string {
  return approvalIntentDigest(intent);
}
