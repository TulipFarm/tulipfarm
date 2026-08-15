import {
  DecryptError,
  PRINCIPAL_MODEL_API_KEY,
  principalSecretKey,
  type SecretsService,
  SecretUnavailableError,
} from "@tulipfarm/secrets";
import type { PrincipalCredentialResolver, PrincipalRef } from "./provider";

/**
 * Reads a principal's own model-provider key from the secrets store.
 *
 * Absence is the normal case — most principals have connected nothing — so it resolves to
 * `undefined` rather than throwing, and the caller falls back to the deployment credential. An
 * undecryptable value is treated the same way: it is unusable either way, and failing the call
 * would take down a turn the shared credential could still serve.
 */
export class SecretsPrincipalCredentials implements PrincipalCredentialResolver {
  constructor(private readonly secrets: SecretsService) {}

  async resolve(principal: PrincipalRef, provider: string): Promise<string | undefined> {
    const key = principalSecretKey(principal, provider, PRINCIPAL_MODEL_API_KEY);
    try {
      return await this.secrets.get(key);
    } catch (err) {
      if (err instanceof SecretUnavailableError || err instanceof DecryptError) return undefined;
      throw err;
    }
  }
}
