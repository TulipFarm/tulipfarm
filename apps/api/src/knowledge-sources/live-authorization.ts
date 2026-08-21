import type { SlackKnowledgeApiPort } from "@tulipfarm/integrations";
import type { LiveSourceAuthorizationPort } from "@tulipfarm/knowledge";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { ExternalIdentityRepo } from "../identity/external-links";
import { integrationSecretKey } from "../integrations/connection-env";
import { SlackHttpKnowledgeApi } from "./slack-http";

const SLACK_PROVIDER = "slack";

/** Live Slack auth allows current members; unreadable/provider errors return denied `undefined`. */
export class SlackLiveSourceAuthorization implements LiveSourceAuthorizationPort {
  constructor(
    private readonly api: SlackKnowledgeApiPort,
    private readonly identity: ExternalIdentityRepo
  ) {}

  async check(input: {
    readonly businessId: string;
    readonly sourceId: string;
    readonly provider: string;
    readonly externalId: string;
    readonly principals: readonly { readonly kind: string; readonly id: string }[];
  }): Promise<{ readonly allowed: boolean; readonly aclRevision?: string } | undefined> {
    if (input.provider !== SLACK_PROVIDER) return undefined;

    let members: readonly string[] | undefined;
    try {
      members = await this.api.listMembers(input.externalId);
    } catch {
      // A membership lookup failure yields no authorization decision; the caller decides.
      return undefined;
    }
    if (members === undefined) return undefined;

    const memberSet = new Set(members);
    const now = Date.now();
    for (const principal of input.principals) {
      if (principal.kind !== "user") continue;
      const mappings = await this.identity.listProvenMappingsForUser(principal.id);
      for (const mapping of mappings) {
        if (mapping.provider !== SLACK_PROVIDER) continue;
        if (mapping.expiresAt && mapping.expiresAt.getTime() <= now) continue;
        if (memberSet.has(mapping.externalSubject)) return { allowed: true };
      }
    }
    return { allowed: false };
  }
}

/** Resolves Slack bot token fresh per check; missing token returns fail-closed `undefined`. */
export class SlackTenantLiveAuthorization implements LiveSourceAuthorizationPort {
  constructor(
    private readonly integrations: IntegrationStore,
    private readonly secrets: SecretsService,
    private readonly identity: ExternalIdentityRepo
  ) {}

  async check(
    input: Parameters<LiveSourceAuthorizationPort["check"]>[0]
  ): ReturnType<LiveSourceAuthorizationPort["check"]> {
    if (input.provider !== SLACK_PROVIDER) return undefined;

    const snapshot = await this.integrations.loadProviderSnapshot(input.businessId, SLACK_PROVIDER);
    const integration = snapshot.integrations.find((i) => i.status === "active");
    if (!integration) return undefined;

    const token = await this.secrets
      .get(integrationSecretKey("slack", "SLACK_BOT_TOKEN"))
      .catch(() => undefined);
    if (!token) return undefined;

    const api = new SlackHttpKnowledgeApi({ token, teamId: integration.externalTenantId });
    return new SlackLiveSourceAuthorization(api, this.identity).check(input);
  }
}

export class CompositeLiveSourceAuthorization implements LiveSourceAuthorizationPort {
  constructor(private readonly ports: readonly LiveSourceAuthorizationPort[]) {}

  async check(
    input: Parameters<LiveSourceAuthorizationPort["check"]>[0]
  ): ReturnType<LiveSourceAuthorizationPort["check"]> {
    for (const port of this.ports) {
      const result = await port.check(input);
      if (result !== undefined) return result;
    }
    return undefined;
  }
}
