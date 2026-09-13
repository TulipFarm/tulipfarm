/** Approval binding is three safe digests; only evidence order is normalized. */

import { canonicalHash } from "@tulipfarm/schema";

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
  readonly integrationId?: string;
  readonly integrationMajorVersion?: number;
  readonly operationId?: string;
  readonly manifestDigest?: string;
  readonly configurationDigest?: string;
  readonly destination?: string;
  readonly credentialRef?: string;
  readonly connection?: {
    readonly connectionId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
    readonly operationId: string;
    readonly credentialSlot?: string;
    readonly credentialRevision?: string;
    readonly identityMode: string;
    readonly principalKind?: string;
    readonly principalId?: string;
    readonly manifestDigest: string;
    readonly configurationDigest: string;
  };
  readonly secondaryCredentialRef?: string;
  readonly secondaryConnection?: ApprovalIntent["connection"];
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
    integrationId: intent.integrationId ?? null,
    integrationMajorVersion: intent.integrationMajorVersion ?? null,
    operationId: intent.operationId ?? null,
    manifestDigest: intent.manifestDigest ?? null,
    configurationDigest: intent.configurationDigest ?? null,
    destination: intent.destination ?? null,
    credentialRef: intent.credentialRef ?? null,
    connection: intent.connection ?? null,
    secondaryCredentialRef: intent.secondaryCredentialRef ?? null,
    secondaryConnection: intent.secondaryConnection ?? null,
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
