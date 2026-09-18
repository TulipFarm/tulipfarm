/** Approval binding is three safe digests; only evidence order is normalized. */

import { canonicalHash, type McpExecutionBinding } from "@tulipfarm/schema";

/** The canonical Tool intent fields an Approval is bound to (SPEC §11.1 `ToolIntent`). */
export interface ApprovalIntent {
  readonly businessId?: string;
  readonly runStateId?: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly action: string;
  readonly targetRefs: readonly {
    readonly type: string;
    readonly id: string;
    readonly domain?: string;
  }[];
  readonly arguments: unknown;
  readonly filePrincipalId?: string;
  readonly fileIds?: readonly string[];
  readonly agentPrincipalId?: string;
  readonly principalKind?: string;
  readonly principalId?: string;
  readonly activeSkillName?: string;
  readonly destination?: string;
  readonly credentialRef?: string;
  readonly mcp?: McpExecutionBinding;
}

export interface ApprovalBindingInput {
  readonly intent: ApprovalIntent;
  /** Hashes of the input Artifacts/evidence the approver saw. Order-insensitive. */
  readonly evidenceHashes: readonly string[];
  /** Revision identifier of the Guardrail set that required this Approval. */
  readonly guardrailRevision: string;
}

export interface ApprovalBinding {
  readonly intentDigest: string;
  readonly evidenceDigest: string;
  readonly guardrailRevision: string;
}

export function approvalIntentDigest(intent: ApprovalIntent): string {
  return canonicalHash({
    businessId: intent.businessId ?? null,
    runStateId: intent.runStateId ?? null,
    toolId: intent.toolId,
    toolVersion: intent.toolVersion,
    action: intent.action,
    targetRefs: intent.targetRefs.map((ref) => ({
      type: ref.type,
      id: ref.id,
      domain: ref.domain ?? null,
    })),
    arguments: intent.arguments,
    filePrincipalId: intent.filePrincipalId ?? null,
    fileIds: intent.fileIds ?? null,
    agentPrincipalId: intent.agentPrincipalId ?? null,
    principalKind: intent.principalKind ?? null,
    principalId: intent.principalId ?? null,
    activeSkillName: intent.activeSkillName ?? null,
    // Reserved nulls preserve existing native and MCP Approval digests without accepting OIM input.
    integrationId: null,
    integrationMajorVersion: null,
    operationId: null,
    manifestDigest: null,
    configurationDigest: null,
    destination: intent.destination ?? null,
    credentialRef: intent.credentialRef ?? null,
    connection: null,
    secondaryCredentialRef: null,
    secondaryConnection: null,
    ...(intent.mcp === undefined ? {} : { mcp: intent.mcp }),
  });
}

/** Throws when intent arguments cannot be canonicalized exactly. */
export function computeApprovalBinding(input: ApprovalBindingInput): ApprovalBinding {
  return {
    intentDigest: approvalIntentDigest(input.intent),
    evidenceDigest: canonicalHash([...input.evidenceHashes].sort()),
    guardrailRevision: input.guardrailRevision,
  };
}

/** True only when both bindings agree on intent, evidence, and Guardrail revision. */
export function bindingsMatch(a: ApprovalBinding, b: ApprovalBinding): boolean {
  return (
    a.intentDigest === b.intentDigest &&
    a.evidenceDigest === b.evidenceDigest &&
    a.guardrailRevision === b.guardrailRevision
  );
}
