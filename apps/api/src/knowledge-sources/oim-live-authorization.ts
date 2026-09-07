import {
  type ConnectionUseAuthorizer,
  compileKnowledgeProfile,
  type KnowledgeProfilePlan,
  type OimKnowledgeApiPort,
  readPointer,
} from "@tulipfarm/integrations";
import type { LiveSourceAuthorizationPort } from "@tulipfarm/knowledge";
import type { OimOperation } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";
import type { RequestContext } from "@tulipfarm/tool-host";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { ExternalIdentityRepo } from "../identity/external-links";
import { createRegistryKnowledgeApiPort } from "../integrations/oim-knowledge-api";

type OimLiveConnectionStore = Pick<ConnectionStore, "findById">;
const MAX_LIVE_AUTHORIZATION_PAGES = 50;

export interface OimLiveSourceAuthorizationDeps {
  readonly integrations: () => Iterable<SoulIntegration>;
  readonly registry: () => ToolRegistry;
  readonly authorizeIntegration: (integration: SoulIntegration) => Promise<void>;
  readonly connections: OimLiveConnectionStore;
  readonly connectionAccess: ConnectionUseAuthorizer;
  readonly identities: ExternalIdentityRepo;
  readonly now?: () => Date;
}

function supportsOwner(
  identityMode: OimOperation["identityMode"],
  connection: PersistedConnection
): boolean {
  if (identityMode === "personal_required") return connection.owner.scope === "personal";
  if (identityMode === "shared_only") return connection.owner.scope !== "personal";
  return true;
}

function installedIntegration(
  integrations: Iterable<SoulIntegration>,
  slug: string
): SoulIntegration | undefined {
  for (const integration of integrations) {
    if (integration.slug === slug) return integration;
  }
  return undefined;
}

function sourceParameters(
  bindings: Readonly<Record<string, string>> | undefined,
  fields: Readonly<Record<string, string | number | boolean>> | undefined
): Record<string, unknown> | undefined {
  const parameters: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(bindings ?? {})) {
    if (fields === undefined || !Object.hasOwn(fields, field)) return undefined;
    const value = fields[field];
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      return undefined;
    }
    parameters[name] = value;
  }
  return parameters;
}

async function checkProviderAccess(
  api: OimKnowledgeApiPort,
  live: NonNullable<KnowledgeProfilePlan["liveAuthorization"]>,
  parameters: Readonly<Record<string, unknown>>,
  externalSubject: string
): Promise<boolean | undefined> {
  if (live.allowedPointer !== undefined) {
    try {
      const { body } = await api.execute({ operationId: live.operation.id, parameters });
      const allowed = readPointer(body, live.allowedPointer);
      return typeof allowed === "boolean" ? allowed : undefined;
    } catch {
      return undefined;
    }
  }

  const principalSet = live.principalSet;
  if (principalSet === undefined) return undefined;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIVE_AUTHORIZATION_PAGES; page += 1) {
    let response: Awaited<ReturnType<OimKnowledgeApiPort["execute"]>>;
    try {
      response = await api.execute({
        operationId: live.operation.id,
        parameters,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
    } catch {
      return undefined;
    }
    const entries = readPointer(response.body, principalSet.entriesPointer);
    if (!Array.isArray(entries)) return undefined;
    let containsPrincipal = false;
    for (const entry of entries) {
      const providerId = readPointer(entry, principalSet.principalIdPointer);
      if (typeof providerId !== "string") return undefined;
      if (providerId === externalSubject) containsPrincipal = true;
    }
    if (containsPrincipal) return true;
    if (response.nextPageToken === undefined) return false;
    pageToken = response.nextPageToken;
  }
  return undefined;
}

export class OimLiveSourceAuthorization implements LiveSourceAuthorizationPort {
  private readonly now: () => Date;

  constructor(private readonly deps: OimLiveSourceAuthorizationDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async check(
    input: Parameters<LiveSourceAuthorizationPort["check"]>[0]
  ): ReturnType<LiveSourceAuthorizationPort["check"]> {
    const locator = input.sourceLocator;
    if (locator?.kind !== "oim") return undefined;
    if (locator.integrationId !== input.provider || locator.itemId !== input.externalId) {
      return { allowed: false };
    }

    const integration = installedIntegration(this.deps.integrations(), locator.integrationSlug);
    if (integration === undefined) return { allowed: false };
    const manifest = integration.oimManifest;
    if (
      manifest === undefined ||
      manifest.metadata.id !== locator.integrationId ||
      Number(manifest.metadata.version.split(".", 1)[0]) !== locator.integrationMajorVersion
    ) {
      return { allowed: false };
    }
    try {
      await this.deps.authorizeIntegration(integration);
    } catch {
      return { allowed: false };
    }

    let plan: ReturnType<typeof compileKnowledgeProfile>;
    try {
      plan = compileKnowledgeProfile(manifest);
    } catch {
      return { allowed: false };
    }
    const live = plan.liveAuthorization;
    if (live === undefined) return undefined;

    let connection: PersistedConnection | null;
    try {
      connection = await this.deps.connections.findById(input.businessId, locator.connectionId);
    } catch {
      return { allowed: false };
    }
    if (
      connection === null ||
      connection.id !== locator.connectionId ||
      connection.status !== "active" ||
      connection.integration.id !== locator.integrationId ||
      connection.integration.majorVersion !== locator.integrationMajorVersion ||
      connection.health.status === "action_required" ||
      (connection.expiresAt !== null && new Date(connection.expiresAt) <= this.now()) ||
      !supportsOwner(live.operation.identityMode, connection)
    ) {
      return { allowed: false };
    }
    if (
      live.principalParameter === undefined &&
      live.principalSet === undefined &&
      connection.owner.scope !== "personal"
    ) {
      return { allowed: false };
    }

    for (const principal of input.principals) {
      if (principal.kind !== "user") continue;
      if (connection.owner.scope === "personal" && connection.owner.principalId !== principal.id) {
        continue;
      }

      let canUse: boolean;
      try {
        canUse = await this.deps.connectionAccess.canUse(principal, connection);
      } catch {
        return { allowed: false };
      }
      if (!canUse) continue;

      let mappings: Awaited<ReturnType<ExternalIdentityRepo["listProvenMappingsForUser"]>>;
      try {
        mappings = await this.deps.identities.listProvenMappingsForUser(principal.id);
      } catch {
        return { allowed: false };
      }
      for (const mapping of mappings) {
        if (mapping.provider !== locator.integrationId) continue;
        if (mapping.expiresAt !== null && mapping.expiresAt <= this.now()) continue;

        const ctx: RequestContext = {
          userId: principal.id,
          subject: principal,
        };
        const api = createRegistryKnowledgeApiPort({
          slug: locator.integrationSlug,
          manifest,
          registry: this.deps.registry(),
          ctx,
          connectionId: locator.connectionId,
        });
        const parameters = sourceParameters(live.parameters, locator.fields);
        if (parameters === undefined) return { allowed: false };
        if (live.itemParameter !== undefined) parameters[live.itemParameter] = locator.itemId;
        if (live.principalParameter !== undefined) {
          parameters[live.principalParameter] = mapping.externalSubject;
        }
        const allowed = await checkProviderAccess(api, live, parameters, mapping.externalSubject);
        if (allowed === true) return { allowed: true };
      }
    }
    return { allowed: false };
  }
}

export function createOimLiveSourceAuthorization(
  deps: OimLiveSourceAuthorizationDeps
): LiveSourceAuthorizationPort {
  return new OimLiveSourceAuthorization(deps);
}
