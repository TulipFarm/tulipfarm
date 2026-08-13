import type { AuthOAuth2Step } from "@tulipfarm/soul";
import { oauth2ExpiresAtEnv, oauth2RefreshTokenEnv } from "@tulipfarm/soul";
import type { AuthStepOutcome } from "./auth-broker";
import { AuthBrokerError } from "./auth-broker";
import type { PrincipalProviderTokenRepo } from "./principal-tokens";
import { principalSecretKey } from "./principal-tokens";

/**
 * Landing a user-scoped connect (D7).
 *
 * The auth broker produces the same `env` map whether the flow was run for the deployment or for
 * one person; what differs is where it may be written. A personal credential must **never** reach
 * `connection.yaml`: that file is committed and pushed to the customer's own soul git repo, and it
 * is the credential every unattended caller spends. Writing one human's token there would both
 * publish it and hand it to everybody.
 *
 * So the split is enforced here rather than left to the caller's discipline: this module is the
 * only writer of `principal_provider_tokens`, and the callback route routes to exactly one of the
 * two destinations based on whether the consumed request named a principal.
 */

/** The narrow slice of `SecretsService` sealing needs — no reads, so a leak has nowhere to go. */
export interface PrincipalSecretStore {
  set(key: string, plaintext: string): Promise<void>;
}

export interface SealPrincipalCredentialInput {
  readonly outcome: AuthStepOutcome;
  readonly secrets: PrincipalSecretStore;
  readonly tokens: PrincipalProviderTokenRepo;
  readonly now?: () => Date;
}

function parseExpiry(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Seals one principal's provider credential and records the row pointing at it.
 *
 * Refuses an outcome that names a principal but carries no OAuth2 step. `startAuthStep` already
 * refuses to issue such a state, so reaching here means the request row was tampered with or a new
 * step kind was added without revisiting this decision — neither is a case to guess through.
 */
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
    externalSubject: null,
    scopes,
    connectedAt: now,
    updatedAt: now,
    expiresAt: parseExpiry(outcome.env[oauth2ExpiresAtEnv(step)]),
    revokedAt: null,
  });

  return { provider: outcome.slug, scopes };
}
