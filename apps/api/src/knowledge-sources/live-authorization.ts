import type { SlackKnowledgeApiPort } from "@tulipfarm/integrations";
import type { LiveSourceAuthorizationPort } from "@tulipfarm/knowledge";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { ExternalIdentityRepo } from "../identity/external-links";
import { integrationSecretKey, resolveConnectionEnv } from "../integrations/connection-env";
import { GoogleDriveHttpKnowledgeApi } from "./google-http";
import { SlackHttpKnowledgeApi } from "./slack-http";

const SLACK_PROVIDER = "slack";
const DRIVE_PROVIDER = "google-drive";

/**
 * Live authorization for `live`-mode Slack sources (private channels, DMs, group DMs — never
 * cached, per `sync.ts`). A querying principal is allowed only if a mapped Slack identity of
 * theirs is a current member of the channel. `listMembers` returning `undefined` (unreadable) or
 * throwing (provider error) both resolve to `undefined` here — "could not determine" — never to an
 * open decision (`acl.ts` denies on `undefined`).
 */
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
      return undefined;
    }
    if (members === undefined) return undefined;

    const memberSet = new Set(members);
    const now = Date.now();
    for (const principal of input.principals) {
      if (principal.kind !== "user") continue;
      const mappings = await this.identity.listMappingsForUser(principal.id);
      for (const mapping of mappings) {
        if (mapping.provider !== SLACK_PROVIDER) continue;
        if (mapping.expiresAt && mapping.expiresAt.getTime() <= now) continue;
        if (memberSet.has(mapping.externalSubject)) return { allowed: true };
      }
    }
    return { allowed: false };
  }
}

/**
 * Resolves the business's current active Slack integration (single-tenant deployment, so at most
 * one) and its bot token fresh on every check — deliberately not cached at the composition root,
 * since a live check's whole point is to never answer from a stale credential or membership list.
 * No active integration or unresolvable token both fall through to `undefined` ("could not
 * determine"), the same fail-closed outcome `SlackLiveSourceAuthorization` already returns for an
 * unreadable channel.
 */
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

export class GoogleDriveTenantLiveAuthorization implements LiveSourceAuthorizationPort {
  constructor(
    private readonly soulLoader: SoulLoader,
    private readonly secrets: SecretsService,
    private readonly identity: ExternalIdentityRepo
  ) {}

  async check(
    input: Parameters<LiveSourceAuthorizationPort["check"]>[0]
  ): ReturnType<LiveSourceAuthorizationPort["check"]> {
    if (input.provider !== DRIVE_PROVIDER) return undefined;

    for (const [slug, integration] of this.soulLoader.integrations) {
      const isDrive = slug === DRIVE_PROVIDER || integration.sourceIntegration === DRIVE_PROVIDER;
      if (!isDrive || integration.connection?.enabled !== true || !integration.connection.env) {
        continue;
      }
      const env = await resolveConnectionEnv(integration.connection.env, this.secrets).catch(
        () => undefined
      );
      const token = env?.GOOGLE_DRIVE_ACCESS_TOKEN;
      const tenantId = env?.GOOGLE_DRIVE_TENANT_ID ?? env?.GOOGLE_WORKSPACE_ID;
      if (!token || !tenantId) continue;

      const api = new GoogleDriveHttpKnowledgeApi({
        accessToken: token,
        tenantId,
        ...(env?.GOOGLE_DRIVE_BASE_URL ? { baseUrl: env.GOOGLE_DRIVE_BASE_URL } : {}),
      });
      const permissions = await api.getPermissions(input.externalId).catch(() => undefined);
      if (permissions === undefined) return undefined;
      const subjects = new Set(
        permissions
          .filter((permission) => permission.type !== "anyone")
          .map((permission) => permission.externalSubject)
      );
      const now = Date.now();
      for (const principal of input.principals) {
        if (principal.kind !== "user") continue;
        const mappings = await this.identity.listMappingsForUser(principal.id);
        for (const mapping of mappings) {
          if (mapping.provider !== DRIVE_PROVIDER) continue;
          if (mapping.expiresAt && mapping.expiresAt.getTime() <= now) continue;
          if (subjects.has(mapping.externalSubject)) return { allowed: true };
        }
      }
      return { allowed: false };
    }
    return undefined;
  }
}
