/** Where a principal's own sealed credentials live, so every plane names them identically. */

/** Whom a credential belongs to. Structural, so callers need not depend on the Run kernel. */
export interface CredentialPrincipal {
  readonly kind: string;
  readonly id: string;
}

/**
 * The secrets-store key holding one principal's credential for one provider.
 *
 * Both the effect plane (Tool calls) and the model plane read per-principal credentials, and a
 * key written by one must be findable by the other, so the format is defined once here rather
 * than rebuilt at each call site.
 */
export function principalSecretKey(
  principal: CredentialPrincipal,
  provider: string,
  envName: string
): string {
  return `principal.${principal.kind}.${principal.id}.${provider}.${envName}`;
}

/**
 * The credential name a model call looks for.
 *
 * Model providers authenticate with a single API key, unlike the effect plane's OAuth pairs, so
 * one well-known name is enough to locate it.
 */
export const PRINCIPAL_MODEL_API_KEY = "API_KEY";
