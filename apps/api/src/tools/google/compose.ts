import {
  GOOGLE_ADAPTER_REF,
  type GooglePortResolver,
  GoogleToolAdapter,
} from "@tulipfarm/integrations";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretsService,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import { CredentialDispatcher, type ToolAdapter } from "@tulipfarm/tool-broker";
import { buildGooglePorts } from "../../integrations/google-http";
import {
  GOOGLE_ACCESS_TOKEN_SECRET_REF,
  GoogleAccessTokenProvider,
  type GoogleConnection,
  googleCompositeSecretProvider,
} from "./credentials";

/** Composes the Google chat Tools' adapter map and `CredentialDispatcher`. Mirrors Slack. */

export interface BuildGoogleToolingOptions {
  readonly secrets: () => Promise<SecretsService>;
  /** OAuth step + connection env, enabling transparent access-token refresh. */
  readonly connection?: () => Promise<GoogleConnection | undefined>;
  /** Per-service HTTP resolver; defaults to the live Google hosts. Tests inject a fake. */
  readonly http?: GooglePortResolver;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface GoogleTooling {
  readonly adapters: ReadonlyMap<string, ToolAdapter>;
  readonly credentials: CredentialDispatcher;
}

/** Default-deny authorizer: only the Google access-token ref may ever lease. */
const googleOnlyAuthorizer: SecretAuthorizer = {
  authorize(scope) {
    if (scope.secretRef !== GOOGLE_ACCESS_TOKEN_SECRET_REF)
      return { allowed: false, reason: "not_authorized" };
    return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
  },
};

export function buildGoogleTooling(options: BuildGoogleToolingOptions): GoogleTooling {
  const http = options.http ?? buildGooglePorts(options.fetchImpl);
  const adapter = new GoogleToolAdapter({ http });

  const tokenProvider = new GoogleAccessTokenProvider({
    secrets: options.secrets,
    ...(options.connection === undefined ? {} : { connection: options.connection }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const provider = googleCompositeSecretProvider(
    secretsServiceProvider({ get: async (key) => (await options.secrets()).get(key) }),
    tokenProvider
  );
  const secretBroker = new SecretBroker({ provider, authorizer: googleOnlyAuthorizer });
  const credentials = new CredentialDispatcher({
    secrets: secretBroker,
    reauthorize: () => true,
  });

  return {
    adapters: new Map<string, ToolAdapter>([[GOOGLE_ADAPTER_REF, adapter]]),
    credentials,
  };
}
