import type { AuthOAuth2Step } from "@tulipfarm/soul";
import { oauth2ExpiresAtEnv, oauth2RefreshTokenEnv } from "@tulipfarm/soul";
import type { AuthStepOutcome } from "./auth-broker";
import { AuthBrokerError } from "./auth-broker";
import type { PrincipalProviderTokenRepo } from "./principal-tokens";
import { principalSecretKey } from "./principal-tokens";

/** User-scoped credentials must never reach committed `connection.yaml`. */

/** The narrow slice of `SecretsService` sealing needs — no reads, so a leak has nowhere to go. */
export interface PrincipalSecretStore {
  set(key: string, plaintext: string): Promise<void>;
}

export interface SealPrincipalCredentialInput {
  readonly outcome: AuthStepOutcome;
  readonly secrets: PrincipalSecretStore;
  readonly tokens: PrincipalProviderTokenRepo;
  readonly now?: () => Date;
  readonly externalSubject?: string | null;
}

function parseExpiry(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Refuse principal outcomes without an OAuth2 step. */
export async function sealPrincipalCredential(
  input: SealPrincipalCredentialInput
): Promise<{ readonly provider: string; readonly scopes: readonly string[] }> {
  const { outcome, secrets, tokens } = input;
  const principal = outcome.principal;
  if (principal === undefined) {
    throw new AuthBrokerError("invalid_state", "outcome names no principal", outcome.slug);
  }
  const step: AuthOAuth2Step | undefined = outcome.oauth2Step;
  if (step === undefined) {
    throw new AuthBrokerError(
      "unknown_step",
      "a personal credential can only come from an oauth2 step",
      outcome.slug
    );
  }

  const accessToken = outcome.env[step.token_env];
  if (accessToken === undefined) {
    throw new AuthBrokerError("exchange_failed", "no access token to seal", outcome.slug);
  }

  const now = (input.now ?? (() => new Date()))();
  const secretKey = principalSecretKey(principal, outcome.slug, step.token_env);
  await secrets.set(secretKey, accessToken);

  const refreshEnv = oauth2RefreshTokenEnv(step);
  const refreshToken = outcome.env[refreshEnv];
  let refreshSecretKey: string | null = null;
  if (refreshToken !== undefined) {
    refreshSecretKey = principalSecretKey(principal, outcome.slug, refreshEnv);
    await secrets.set(refreshSecretKey, refreshToken);
  }

  const scopes = step.scopes ?? [];
  await tokens.upsert({
    principalKind: principal.kind,
    principalId: principal.id,
    provider: outcome.slug,
    secretKey,
    refreshSecretKey,
    // Only what the provider actually reported. A subject we invented would be worse than none:
    // it is the value an audit uses to say which account acted.
    externalSubject: input.externalSubject ?? null,
    scopes,
    connectedAt: now,
    updatedAt: now,
    expiresAt: parseExpiry(outcome.env[oauth2ExpiresAtEnv(step)]),
    revokedAt: null,
  });

  return { provider: outcome.slug, scopes };
}
