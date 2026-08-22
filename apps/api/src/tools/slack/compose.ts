import {
  type IntegrationHttpPort,
  SLACK_ADAPTER_REF,
  SlackToolAdapter,
  type SlackToolAdapterDeps,
} from "@tulipfarm/integrations";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretsService,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import { CredentialDispatcher, type ToolAdapter } from "@tulipfarm/tool-broker";
import { SlackWebApiHttp } from "../../integrations/slack-http";
import {
  SLACK_BOT_TOKEN_SECRET_REF,
  SlackBotTokenProvider,
  slackCompositeSecretProvider,
} from "./credentials";

/**
 * Composes the Slack chat Tools' adapter map and `CredentialDispatcher`. Mirrors
 * `../github/compose.ts`'s `buildGitHubTooling`.
 */

export interface BuildSlackToolingOptions {
  readonly secrets: () => Promise<SecretsService>;
  readonly http?: IntegrationHttpPort;
  readonly channelRunDelivery?: SlackToolAdapterDeps["channelRunDelivery"];
}

export interface SlackTooling {
  readonly adapters: ReadonlyMap<string, ToolAdapter>;
  readonly credentials: CredentialDispatcher;
}

/** Default-deny authorizer: only the Slack bot-token ref may ever lease. */
const slackOnlyAuthorizer: SecretAuthorizer = {
  authorize(scope) {
    if (scope.secretRef !== SLACK_BOT_TOKEN_SECRET_REF)
      return { allowed: false, reason: "not_authorized" };
    return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
  },
};

export function buildSlackTooling(options: BuildSlackToolingOptions): SlackTooling {
  const http = options.http ?? new SlackWebApiHttp();
  const adapter = new SlackToolAdapter({ http, channelRunDelivery: options.channelRunDelivery });

  const tokenProvider = new SlackBotTokenProvider({ secrets: options.secrets });
  const provider = slackCompositeSecretProvider(
    secretsServiceProvider({ get: async (key) => (await options.secrets()).get(key) }),
    tokenProvider
  );
  const secretBroker = new SecretBroker({ provider, authorizer: slackOnlyAuthorizer });
  const credentials = new CredentialDispatcher({
    secrets: secretBroker,
    reauthorize: () => true,
  });

  return {
    adapters: new Map<string, ToolAdapter>([[SLACK_ADAPTER_REF, adapter]]),
    credentials,
  };
}
