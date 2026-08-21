import type { SecretProvider, SecretsService } from "@tulipfarm/secrets";
import { type AuthOAuth2Step, oauth2ExpiresAtEnv, oauth2RefreshTokenEnv } from "@tulipfarm/soul";
import { refreshOAuth2Credentials } from "../../integrations/auth-broker";
import { integrationSecretKey, resolveConnectionEnv } from "../../integrations/connection-env";

/** Google chat Tools lease the sealed OAuth access token, refreshing it before it expires. */
export const GOOGLE_ACCESS_TOKEN_SECRET_REF = "secret://integrations/google/access-token";

const GOOGLE_INTEGRATION = "google";
const ACCESS_TOKEN_ENV = "GOOGLE_ACCESS_TOKEN";
/** Refresh this far ahead of expiry so an in-flight Tool call never carries a token that lapses. */
const DEFAULT_REFRESH_SKEW_MS = 2 * 60 * 1000;

/** The Google OAuth2 auth step plus its connection env (secret refs unresolved). */
export interface GoogleConnection {
  readonly step: AuthOAuth2Step;
  readonly env: Record<string, string>;
}

export interface GoogleAccessTokenProviderDeps {
  readonly secrets: () => Promise<SecretsService>;
  /** Supplies the OAuth step + connection env so the token can auto-refresh; omit to disable it. */
  readonly connection?: () => Promise<GoogleConnection | undefined>;
  readonly now?: () => Date;
  readonly skewMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * Leases the Google access token, transparently exchanging the refresh token for a new one when the
 * stored token is within the skew window of expiry. Rotated token and expiry are written back to the
 * secret store so the soul's `secret://` refs keep resolving to the live credential — no soul commit.
 */
export class GoogleAccessTokenProvider implements SecretProvider {
  private inFlight: Promise<{ value: string } | null> | null = null;

  constructor(private readonly deps: GoogleAccessTokenProviderDeps) {}

  async resolveCurrent(secretRef: string): Promise<{ value: string } | null> {
    if (secretRef !== GOOGLE_ACCESS_TOKEN_SECRET_REF) return null;
    // Collapse concurrent leases so a burst of Tool calls triggers at most one refresh round-trip.
    if (this.inFlight !== null) return this.inFlight;
    const pending = this.resolveFresh().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  private async resolveFresh(): Promise<{ value: string } | null> {
    let secrets: SecretsService;
    try {
      secrets = await this.deps.secrets();
    } catch {
      // No reachable secret store means no credential to lease; the caller treats null as
      // "Google not connected" rather than surfacing an infrastructure error to the Tool layer.
      return null;
    }

    const connection = this.deps.connection
      ? await this.deps.connection().catch(() => undefined)
      : undefined;
    if (connection === undefined) return this.storedToken(secrets);

    const { step } = connection;
    const env = await resolveConnectionEnv(connection.env, secrets).catch(() => null);
    const current = env?.[step.token_env];
    if (env === null || !current) return this.storedToken(secrets);

    const expiresAt = (await this.shadowExpiry(secrets, step)) ?? env[oauth2ExpiresAtEnv(step)];
    const now = (this.deps.now ?? (() => new Date()))();
    const skewMs = this.deps.skewMs ?? DEFAULT_REFRESH_SKEW_MS;
    const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (Number.isFinite(expiryMs) && now.getTime() < expiryMs - skewMs) {
      return { value: current };
    }

    return this.refresh(secrets, step, env, current, now);
  }

  private async refresh(
    secrets: SecretsService,
    step: AuthOAuth2Step,
    env: Record<string, string>,
    current: string,
    now: Date
  ): Promise<{ value: string }> {
    try {
      const mapped = await refreshOAuth2Credentials(step, env, {
        now,
        ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
      });
      const rotatedToken = mapped[step.token_env];
      if (typeof rotatedToken === "string" && rotatedToken.length > 0) {
        await secrets.set(integrationSecretKey(GOOGLE_INTEGRATION, step.token_env), rotatedToken);
      }
      const refreshEnv = oauth2RefreshTokenEnv(step);
      const rotatedRefresh = mapped[refreshEnv];
      if (
        typeof rotatedRefresh === "string" &&
        rotatedRefresh.length > 0 &&
        rotatedRefresh !== env[refreshEnv]
      ) {
        await secrets.set(integrationSecretKey(GOOGLE_INTEGRATION, refreshEnv), rotatedRefresh);
      }
      const expiresAtEnv = oauth2ExpiresAtEnv(step);
      const rotatedExpiry = mapped[expiresAtEnv];
      if (typeof rotatedExpiry === "string" && rotatedExpiry.length > 0) {
        await secrets.set(integrationSecretKey(GOOGLE_INTEGRATION, expiresAtEnv), rotatedExpiry);
      }
      return {
        value: typeof rotatedToken === "string" && rotatedToken.length > 0 ? rotatedToken : current,
      };
    } catch {
      // Revoked refresh token or a provider outage: serve the stale token so the Google call itself
      // returns 401, which the Tool layer turns into a "reconnect Google" message.
      return { value: current };
    }
  }

  private async shadowExpiry(
    secrets: SecretsService,
    step: AuthOAuth2Step
  ): Promise<string | undefined> {
    try {
      return await secrets.get(integrationSecretKey(GOOGLE_INTEGRATION, oauth2ExpiresAtEnv(step)));
    } catch {
      // No shadow expiry has been written yet; fall back to the connection env's expiry instead.
      return undefined;
    }
  }

  private async storedToken(secrets: SecretsService): Promise<{ value: string } | null> {
    try {
      return {
        value: await secrets.get(integrationSecretKey(GOOGLE_INTEGRATION, ACCESS_TOKEN_ENV)),
      };
    } catch {
      // A missing access token resolves to "no credential"; the caller handles null.
      return null;
    }
  }
}

/** Routes the Google access-token ref to `google`; every other ref falls through to `base`. */
export function googleCompositeSecretProvider(
  base: SecretProvider,
  google: SecretProvider
): SecretProvider {
  return {
    async resolveCurrent(secretRef) {
      if (secretRef === GOOGLE_ACCESS_TOKEN_SECRET_REF) return google.resolveCurrent(secretRef);
      return base.resolveCurrent(secretRef);
    },
  };
}
