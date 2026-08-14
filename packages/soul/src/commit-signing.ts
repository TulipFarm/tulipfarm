import { createHmac, timingSafeEqual } from "node:crypto";
import type { SoulChangesetSource } from "./changeset";

/** The principal on whose behalf an authored write is committed. */
export interface CommitActor {
  readonly principalId: string;
  readonly name: string;
  readonly email: string;
}

/** The exact Approval decision that authorized the write, when one was required. */
export interface CommitApproval {
  readonly approvalId: string;
  readonly approverId: string;
  readonly decisionAt: string;
}

/** A schema the changeset resolved against, recorded for provenance. */
export interface CommitSchemaRef {
  readonly apiVersion: string;
  readonly kind: string;
}

/** Everything that must be bound into — and covered by — the commit signature. */
export interface SignedCommitMetadata {
  readonly changesetId: string;
  readonly businessId: string;
  readonly source: SoulChangesetSource;
  readonly actor: CommitActor;
  readonly approval?: CommitApproval;
  readonly schemas: readonly CommitSchemaRef[];
}

export interface CommitSignature {
  readonly keyId: string;
  readonly value: string;
}

/** Pluggable signer; key material stays with the caller and signing failure aborts before refs move. */
export interface CommitSigner {
  readonly keyId: string;
  sign(payload: string): string;
}

/** Deterministic, payload-safe signing failure suitable for boundary evidence. */
export class CommitSigningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CommitSigningError";
  }
}

function canonicalSchemas(schemas: readonly CommitSchemaRef[]): string[] {
  return [...schemas].map((schema) => `${schema.kind}@${schema.apiVersion}`).sort();
}

/** Deterministic commit-signing bytes covering tree, actor, schemas, and approval. */
export function buildCommitSigningPayload(
  treeSha: string,
  parentSha: string | null,
  meta: SignedCommitMetadata
): string {
  return JSON.stringify({
    tree: treeSha,
    parent: parentSha,
    changeset: meta.changesetId,
    business: meta.businessId,
    source: meta.source,
    principal: meta.actor.principalId,
    approval: meta.approval
      ? {
          id: meta.approval.approvalId,
          approver: meta.approval.approverId,
          at: meta.approval.decisionAt,
        }
      : null,
    schemas: canonicalSchemas(meta.schemas),
  });
}

/** HMAC-SHA256 signer over the canonical payload. */
export function createHmacCommitSigner(keyId: string, secret: string): CommitSigner {
  if (keyId.length === 0 || secret.length === 0) {
    throw new CommitSigningError("HMAC commit signer requires a non-empty keyId and secret");
  }
  return {
    keyId,
    sign(payload: string): string {
      return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
    },
  };
}

/** Constant-time verification that `signature` covers `payload` under `signer`. */
export function verifyCommitSignature(
  signer: CommitSigner,
  payload: string,
  signature: string
): boolean {
  const expected = Buffer.from(signer.sign(payload), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Build the commit message: a human subject plus deterministic metadata trailers, ending with the
 * signature trailer. The trailers are the auditable actor/approval/schema evidence carried in Git.
 */
export function buildCommitMessage(
  subject: string,
  meta: SignedCommitMetadata,
  signature: CommitSignature
): string {
  const trailers = [
    `Soul-Changeset: ${meta.changesetId}`,
    `Soul-Business: ${meta.businessId}`,
    `Soul-Source: ${meta.source}`,
    `Soul-Principal: ${meta.actor.principalId}`,
  ];
  if (meta.approval) {
    trailers.push(`Soul-Approval: ${meta.approval.approvalId}`);
    trailers.push(`Soul-Approver: ${meta.approval.approverId}`);
    trailers.push(`Soul-Approved-At: ${meta.approval.decisionAt}`);
  }
  for (const schema of canonicalSchemas(meta.schemas)) {
    trailers.push(`Soul-Schema: ${schema}`);
  }
  trailers.push(`Soul-Signature: ${signature.keyId}:${signature.value}`);
  return `${subject}\n\n${trailers.join("\n")}\n`;
}
