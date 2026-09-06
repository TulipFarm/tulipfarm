import {
  type IntegrationHttpPort,
  SLACK_ADAPTER_REF,
  type SlackExternalUploadPort,
  type SlackFileUploadSource,
  type SlackFileUploadStatePort,
  type SlackIntegrationIdentityPort,
  type SlackOwnedObjectPort,
  SlackToolAdapter,
  type SlackToolAdapterDeps,
} from "@tulipfarm/integrations";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretsService,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import {
  CredentialDispatcher,
  type ToolAdapter,
  type ToolReconciliationAdapter,
} from "@tulipfarm/tool-broker";
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
  readonly integrationIdentity?: SlackIntegrationIdentityPort;
  readonly ownedObjects?: SlackOwnedObjectPort;
  readonly files?: SlackFileUploadSource;
  readonly externalUpload?: SlackExternalUploadPort;
  readonly fileUploads?: SlackFileUploadStatePort;
}

export interface SlackTooling {
  readonly adapters: ReadonlyMap<string, ToolAdapter>;
  readonly reconciliationAdapters?: ReadonlyMap<string, ToolReconciliationAdapter>;
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
  const tokenProvider = new SlackBotTokenProvider({ secrets: options.secrets });
  const provider = slackCompositeSecretProvider(
    secretsServiceProvider({
      resolveCurrent: async (key) => (await options.secrets()).resolveCurrent(key),
      revision: async (key) => (await options.secrets()).revision(key),
    }),
    tokenProvider
  );
  const adapter = new SlackToolAdapter({
    http,
    channelRunDelivery: options.channelRunDelivery,
    integrationIdentity: options.integrationIdentity,
    ownedObjects: options.ownedObjects,
    files: options.files,
    externalUpload: options.externalUpload,
    fileUploads: options.fileUploads,
    reconciliationCredential: {
      async resolve() {
        return (await tokenProvider.resolveCurrent(SLACK_BOT_TOKEN_SECRET_REF))?.value;
      },
    },
  });
  const secretBroker = new SecretBroker({ provider, authorizer: slackOnlyAuthorizer });
  const credentials = new CredentialDispatcher({
    secrets: secretBroker,
    reauthorize: () => true,
  });

  return {
    adapters: new Map<string, ToolAdapter>([[SLACK_ADAPTER_REF, adapter]]),
    reconciliationAdapters: new Map<string, ToolReconciliationAdapter>([
      [SLACK_ADAPTER_REF, adapter],
    ]),
    credentials,
  };
}
