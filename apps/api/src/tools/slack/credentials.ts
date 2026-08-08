import type { SecretProvider, SecretsService } from "@tulipfarm/secrets";
import { integrationSecretKey } from "../../integrations/connection-env";

/**
 * The `SecretProvider` the `send_slack_message` chat Tool's `credentialRef` resolves to. Reuses
 * the same sealed bot token `/api/v1/internal/channels/*` already reads
 * (`integrationSecretKey("slack", "SLACK_BOT_TOKEN")`, `apps/api/src/internal/channel-routes.ts`)
 * rather than adding a second Slack credential path.
 */
export const SLACK_BOT_TOKEN_SECRET_REF = "secret://integrations/slack/bot-token";

export interface SlackBotTokenProviderDeps {
  readonly secrets: () => Promise<SecretsService>;
}

export class SlackBotTokenProvider implements SecretProvider {
  constructor(private readonly deps: SlackBotTokenProviderDeps) {}

  async resolveCurrent(secretRef: string) {
    if (secretRef !== SLACK_BOT_TOKEN_SECRET_REF) return null;
    try {
      const secrets = await this.deps.secrets();
      const value = await secrets.get(integrationSecretKey("slack", "SLACK_BOT_TOKEN"));
      return { value };
    } catch {
      return null;
    }
  }
}

/** Routes the Slack bot-token ref to `slack`; every other ref falls through to `base`. */
export function slackCompositeSecretProvider(
  base: SecretProvider,
  slack: SecretProvider
): SecretProvider {
  return {
    async resolveCurrent(secretRef) {
      if (secretRef === SLACK_BOT_TOKEN_SECRET_REF) return slack.resolveCurrent(secretRef);
      return base.resolveCurrent(secretRef);
    },
  };
}
