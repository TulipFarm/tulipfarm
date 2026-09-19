import type { PublicOriginsService } from "@tulipfarm/integrations";
import {
  accountDefinitionForIntegration,
  assertPublicEgressUrl,
  createMcpGuardedFetch,
  type McpAccessAudit,
  type McpAccountAccess,
  McpAccountAccessError,
  type McpAccountScope,
  type McpAccountUseContext,
  type McpCaller,
  type McpCapability,
  McpIntegrationError,
  McpIntegrationService,
  mcpServerRevision,
} from "@tulipfarm/integrations";
import {
  DevelopmentContainerMcpBackend,
  KataContainerMcpBackend,
  MCP_CATALOG,
  McpError,
} from "@tulipfarm/mcp";
import type { MutationGuard } from "@tulipfarm/observability";
import { DockerNetworkEgressPort } from "@tulipfarm/sandbox";
import {
  type CommitActor,
  createSoulMcpDefinitionStore,
  mcpIntegrationsFromBundle,
  type RuntimeBundle,
  type SoulIntegration,
  SoulPublicationError,
  type SoulWriter,
} from "@tulipfarm/soul";
import { McpExecutionAuthorizationStore } from "@tulipfarm/storage";
import type { EffectStore } from "@tulipfarm/tool-broker";
import type { AuditService } from "../audit/service";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { IntegrationAuthoringToolContext } from "../soul/integrations/tools";
import { McpToolSync, type McpToolSyncDeps } from "../tools/mcp/sync";
import { createMcpAccountAudit } from "./accounts/audit";
import { composeMcpAccounts, type McpAccountFeatureDeps } from "./accounts/compose";
import { createMcpRuntimeAccounts } from "./accounts/runtime";
import type { McpHostContextResolver } from "./mcp-context";
import type { McpIntegrationRouteDeps } from "./mcp-routes";

export async function composeMcpAccountRuntime(
  deps: Pick<
    McpAccountFeatureDeps,
    "db" | "transactions" | "secrets" | "businessId" | "users" | "teams" | "authorizationCheck"
  > & {
    readonly activeBundle: () => Promise<RuntimeBundle | undefined>;
    readonly contexts: McpHostContextResolver;
    readonly knowledgeContext: (
      caller: McpCaller,
      scope: McpAccountScope,
      capability: McpCapability
    ) => Promise<McpAccountUseContext>;
    readonly publicOrigins: PublicOriginsService;
    readonly audit: AuditService;
  }
) {
  let integrations = new Map<string, SoulIntegration>();
  const refresh = async () => {
    const active = await deps.activeBundle();
    integrations = active ? mcpIntegrationsFromBundle(active) : new Map();
  };
  await refresh();
  const integration = (id: string) => integrations.get(id)?.mcp;
  const definition: McpAccountFeatureDeps["definition"] = async (id) => {
    const previous = integration(id);
    await refresh();
    const current = integration(id);
    if (!current) throw new McpAccountAccessError("account_not_found");
    if (previous && mcpServerRevision(previous) !== mcpServerRevision(current)) {
      throw new McpAccountAccessError("definition_changed");
    }
    return { ...accountDefinitionForIntegration(current), server: current.server };
  };
  const environment = process.env.NODE_ENV === "production" ? "production" : "development";
  const dockerBinary = process.platform === "darwin" ? "/usr/local/bin/docker" : "/usr/bin/docker";
  const LocalBackend =
    environment === "production" ? KataContainerMcpBackend : DevelopmentContainerMcpBackend;
  const localBackend = (credentials: Readonly<Record<string, string>>) => {
    const backend = new LocalBackend({
      dockerBinary,
      dockerEnvironment: {},
      ...(process.env.SANDBOX_RUNTIME_IMAGE
        ? {
            egress: new DockerNetworkEgressPort({
              image: process.env.SANDBOX_RUNTIME_IMAGE,
              dockerBinary,
            }),
          }
        : {}),
    });
    return {
      attestation: () => backend.attestation(),
      open: (input: Parameters<typeof backend.open>[0]) =>
        backend.open({ ...input, environment: credentials }),
    };
  };
  const guardedFetch = createMcpGuardedFetch();
  const accounts = composeMcpAccounts({
    ...deps,
    definition,
    integrationLabel: (key) => integration(key)?.server.label ?? key,
    guardedFetch,
    localBackend,
    environment,
    oauthUrlPolicy: async (raw, purpose) => {
      const url = new URL(raw);
      if (purpose === "redirect") {
        if (
          url.origin !== new URL(deps.publicOrigins.current().apiOrigin).origin ||
          !/^\/api\/v1\/integrations\/[^/]+\/accounts\/[^/]+\/oauth\/callback$/.test(
            url.pathname
          ) ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          throw new McpError("access_denied");
        return;
      }
      assertPublicEgressUrl(url, url.href);
    },
    callbackUrl: (key, accountId) =>
      `${deps.publicOrigins.current().apiOrigin}/api/v1/integrations/${encodeURIComponent(key)}/accounts/${encodeURIComponent(accountId)}/oauth/callback`,
    webUrl: async () => deps.publicOrigins.current().webOrigin,
    chatContext: async (principal, conversationId, integrationKey) =>
      deps.contexts.chatContext(principal, conversationId, {
        businessId: deps.businessId,
        integrationKey,
        definitionDigest: (await definition(integrationKey)).definitionDigest,
      }),
    grantSubject: async (_principal, account, subject) => {
      if (subject.kind === "routine") return deps.contexts.routineGrantSubject(account, subject.id);
      if (
        subject.kind === "user" &&
        (await authorization.isActivePrincipal(deps.businessId, subject.id))
      )
        return { kind: subject.kind, id: subject.id };
      if (
        subject.kind === "team" &&
        (await deps.teams.getTeam(deps.businessId, subject.id))?.status === "active"
      )
        return { kind: subject.kind, id: subject.id };
      throw new McpAccountAccessError("account_access_denied");
    },
    audit: createMcpAccountAudit(deps.audit),
  });
  const authorization = accounts.authorization;
  const access = createMcpRuntimeAccounts({
    businessId: deps.businessId,
    accounts: accounts.accounts,
    authority: accounts.authority,
    authorization,
    secrets: accounts.secrets,
    oauth: accounts.oauth,
    authorizations: new McpExecutionAuthorizationStore(deps.db),
    definition,
    integration,
    context: async (caller, scope, capability): Promise<McpAccountUseContext> => {
      if (caller.knowledgeSyncId !== undefined) {
        if (caller.principal.kind !== "user" || caller.runId !== undefined) {
          throw new McpAccountAccessError("account_access_denied");
        }
        return deps.knowledgeContext(caller, scope, capability);
      }
      if (
        caller.runId === undefined &&
        caller.conversationId === undefined &&
        caller.principal.kind === "user" &&
        caller.accountId !== undefined &&
        capability.kind === "tool" &&
        capability.name === "get_me"
      ) {
        const binding = await access.knowledgeAccess.bindingFor({
          integrationKey: scope.integrationKey,
          accountId: caller.accountId,
          readerUserId: caller.principal.id,
        });
        if (!binding || binding.configurationRevision !== scope.definitionDigest) {
          throw new McpAccountAccessError("account_access_denied");
        }
        return {
          ...scope,
          kind: "interactive",
          principalId: caller.principal.id,
          accountId: caller.accountId,
          purpose: "content",
        };
      }
      return deps.contexts.resolve(caller, scope, capability);
    },
    guardedFetch,
    localBackend,
    environment,
  });
  return {
    accounts,
    access,
    knowledgeAccess: access.knowledgeAccess,
    definition,
    integration,
    authorization,
    refresh,
    accountConfiguration: access.accountConfiguration,
  };
}

export interface McpIntegrationFeatureDeps {
  readonly businessId: string;
  readonly soulWriter: SoulWriter;
  readonly activeBundle: () => Promise<RuntimeBundle | undefined>;
  readonly accounts: McpAccountAccess;
  readonly audit: McpAccessAudit;
  readonly callerForRequest: McpIntegrationRouteDeps["caller"];
  readonly accountConfiguration?: McpIntegrationRouteDeps["accountConfiguration"];
  readonly callerForRun: McpToolSyncDeps["callerForRun"];
  readonly afterDefinitionChange?: () => Promise<void>;
  readonly setup?: (
    service: McpIntegrationService<CommitActor>
  ) => NonNullable<McpIntegrationRouteDeps["setup"]>;
}

export async function createMcpIntegrationFeature(deps: McpIntegrationFeatureDeps) {
  let tools: McpToolSync | undefined;
  const initial = await deps.activeBundle();
  let integrations = initial ? mcpIntegrationsFromBundle(initial) : new Map();
  async function refresh() {
    const active = await deps.activeBundle();
    integrations = active ? mcpIntegrationsFromBundle(active) : new Map();
    tools?.sync();
  }
  const definitions = createSoulMcpDefinitionStore({
    loader: {
      get integrations() {
        return integrations;
      },
    },
    soulWriter: deps.soulWriter,
    businessId: deps.businessId,
  });
  async function changeDefinition(write: () => Promise<void>) {
    try {
      await write();
    } catch (error) {
      if (error instanceof SoulPublicationError) {
        throw new McpIntegrationError(
          "publication_failed",
          "TulipFarm could not activate the integration settings. An admin must check Operations and Activity before retrying setup."
        );
      }
      throw error;
    }
    await refresh();
    await deps.afterDefinitionChange?.();
  }
  const service = new McpIntegrationService<CommitActor>(
    {
      ...definitions,
      put: (definition, actor, revision) =>
        changeDefinition(() => definitions.put(definition, actor, revision)),
      resumePut: (definition, actor, revision) =>
        changeDefinition(() => definitions.resumePut(definition, actor, revision)),
      remove: (id, actor, revision) =>
        changeDefinition(() => definitions.remove(id, actor, revision)),
    },
    deps.accounts,
    deps.audit
  );
  const authoring: Omit<IntegrationAuthoringToolContext, "requestContext"> = {
    service,
    caller: async (request) => {
      if (!request.runId) throw new McpIntegrationError("forbidden", "A durable Run is required.");
      return await deps.callerForRun({
        runId: request.runId,
        principal: request.subject ?? { kind: "user", id: request.userId },
      });
    },
  };
  const routes: McpIntegrationRouteDeps = {
    service,
    catalog: MCP_CATALOG.map((entry) => ({ ...entry })),
    caller: deps.callerForRequest,
    accountConfiguration: deps.accountConfiguration,
    ...(deps.setup ? { setup: deps.setup(service) } : {}),
  };
  return {
    service,
    refresh,
    authoring,
    routes,
    bindTools(registry: ToolRegistry, effects: EffectStore, mutationGuard: MutationGuard) {
      if (tools) throw new Error("MCP Tools are already bound.");
      tools = new McpToolSync({
        registry,
        service,
        effects,
        mutationGuard,
        businessId: deps.businessId,
        callerForRun: deps.callerForRun,
      });
      tools.sync();
      return tools;
    },
  };
}
