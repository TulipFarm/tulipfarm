/** Approval binding is three safe digests; only evidence order is normalized. */

import { canonicalHash } from "@tulipfarm/schema";

/** The canonical Tool intent fields an Approval is bound to (SPEC §11.1 `ToolIntent`). */
export interface ApprovalIntent {
  readonly toolId: string;
  readonly toolVersion: string;
  readonly action: string;
  readonly targetRefs: readonly { readonly type: string; readonly id: string }[];
  readonly arguments: unknown;
  readonly filePrincipalId?: string;
  readonly destination?: string;
  readonly credentialRef?: string;
  readonly secondaryCredentialRef?: string;
  /**
   * The Connection the intent was resolved against.
   *
   * Part of the digest so an Approval granted for one account cannot be replayed against another.
   * Must stay identical to `intentDigest` in `@tulipfarm/tool-broker`: the two are computed
   * independently, and a divergence makes every Approval fail to bind.
   */
  readonly connection?: {
    readonly connectionId: string;
    readonly integrationId: string;
    readonly credentialSlot: string;
    readonly principalKind?: string;
    readonly principalId?: string;
  };
  readonly secondaryConnection?: {
    readonly connectionId: string;
    readonly integrationId: string;
    readonly credentialSlot: string;
    readonly principalKind?: string;
    readonly principalId?: string;
  };
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

/** Throws when intent arguments cannot be canonicalized exactly. */
export function computeApprovalBinding(input: ApprovalBindingInput): ApprovalBinding {
  const { intent } = input;
  return {
    intentDigest: canonicalHash({
      toolId: intent.toolId,
      toolVersion: intent.toolVersion,
      action: intent.action,
      targetRefs: intent.targetRefs.map((ref) => ({ type: ref.type, id: ref.id })),
      arguments: intent.arguments,
      filePrincipalId: intent.filePrincipalId ?? null,
      destination: intent.destination ?? null,
      credentialRef: intent.credentialRef ?? null,
      connection: intent.connection ?? null,
      secondaryCredentialRef: intent.secondaryCredentialRef ?? null,
      secondaryConnection: intent.secondaryConnection ?? null,
    }),
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
