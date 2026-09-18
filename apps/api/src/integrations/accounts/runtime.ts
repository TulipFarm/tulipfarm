import {
  type McpAccountAccess,
  McpAccountAccessError,
  type McpAccountAuthority,
  type McpAccountAuthorization,
  type McpAccountRepository,
  type McpAccountScope,
  type McpAccountUseContext,
  type McpCaller,
  type McpCapability,
  type McpOAuthLifecycle,
  type McpSession,
  mcpServerRevision,
} from "@tulipfarm/integrations";
import { type IsolatedMcpStdioBackend, McpClient, McpError } from "@tulipfarm/mcp";
import {
  canonicalHash,
  type McpAccount,
  type McpExecutionAuthorization,
  type McpExecutionBinding,
  type McpIntegrationDefinition,
  type McpServerDefinition,
} from "@tulipfarm/schema";
import type { McpAccountSecrets } from "@tulipfarm/secrets";
import type { McpExecutionAuthorizationStore } from "@tulipfarm/storage";
import { createMcpKnowledgeAccountHost } from "./knowledge";
import type { McpAccountProbeDefinition } from "./probe";

export type McpContextSession = <T>(
  context: McpAccountUseContext,
  capability: McpCapability,
  callback: (session: McpSession) => Promise<T>,
  signal?: AbortSignal
) => Promise<T>;

export interface McpRuntimeAccountsDeps {
  readonly businessId: string;
  readonly accounts: McpAccountRepository;
  readonly authority: McpAccountAuthority;
  readonly authorization: McpAccountAuthorization;
  readonly secrets: McpAccountSecrets;
  readonly oauth: Pick<McpOAuthLifecycle, "refresh">;
  readonly authorizations: Pick<McpExecutionAuthorizationStore, "get" | "save">;
  readonly definition: (id: string) => Promise<McpAccountProbeDefinition>;
  readonly integration: (id: string) => McpIntegrationDefinition | undefined;
  readonly context: (
    caller: McpCaller,
    scope: McpAccountScope,
    capability: McpCapability
  ) => Promise<McpAccountUseContext>;
  readonly guardedFetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly localBackend?: (
    environment: Readonly<Record<string, string>>
  ) => IsolatedMcpStdioBackend;
  readonly environment: "development" | "production";
}

function subject(context: McpAccountUseContext): string {
  return context.kind === "chat" || context.kind === "interactive"
    ? context.principalId
    : context.ownerPrincipalId;
}

function contextDigest(context: McpAccountUseContext): string {
  if (context.kind !== "chat") return canonicalHash(context);
  const { pinned: _pinned, ...material } = context;
  return canonicalHash(material);
}

export function createMcpRuntimeAccounts(deps: McpRuntimeAccountsDeps) {
  async function currentContext(
    caller: McpCaller,
    serverId: string,
    serverRevision: string,
    capability: McpCapability
  ) {
    const integration = deps.integration(serverId);
    if (!integration || mcpServerRevision(integration) !== serverRevision) {
      throw new McpAccountAccessError("definition_changed");
    }
    if (
      capability.kind !== "discovery" &&
      (!integration.enabled ||
        (capability.kind === "tool" &&
          !integration.reviewed.tools.some((tool) => tool.name === capability.name)) ||
        (capability.kind === "resource" &&
          !integration.reviewed.resources.some((resource) => resource.uri === capability.name)) ||
        (capability.kind === "prompt" &&
          !integration.reviewed.prompts.some((prompt) => prompt.name === capability.name)))
    ) {
      throw new McpAccountAccessError("account_access_denied");
    }
    const definition = await deps.definition(serverId);
    const scope: McpAccountScope = {
      businessId: deps.businessId,
      integrationKey: serverId,
      definitionDigest: definition.definitionDigest,
    };
    const context = await deps.context(caller, scope, capability);
    if (
      context.businessId !== scope.businessId ||
      context.integrationKey !== scope.integrationKey ||
      context.definitionDigest !== scope.definitionDigest ||
      (caller.principal.kind === "user" && caller.principal.id !== subject(context)) ||
      (context.kind === "interactive" &&
        context.purpose === "discovery" &&
        capability.kind !== "discovery") ||
      !(await deps.authorization.isActivePrincipal(deps.businessId, subject(context)))
    ) {
      throw new McpAccountAccessError("account_access_denied");
    }
    return { context, definition };
  }

  async function resolveAccount(
    context: McpAccountUseContext,
    definition: McpAccountProbeDefinition,
    caller: McpCaller,
    serverRevision: string,
    capability: McpCapability
  ): Promise<McpAccount | undefined> {
    if (definition.authentication === "none") return undefined;
    let account: McpAccount;
    try {
      account = await deps.authority.resolve(context);
    } catch (error) {
      if (!(error instanceof McpAccountAccessError) || error.code !== "account_expired") {
        throw error;
      }
      const expired = await deps.authority.resolveForRefresh(context);
      assertAccountMode(expired, definition);
      await deps.oauth.refresh(expired, subject(context), async () => {
        const live = await currentContext(caller, definition.server.id, serverRevision, capability);
        if (contextDigest(live.context) !== contextDigest(context)) {
          throw new McpAccountAccessError("account_binding_changed");
        }
        const current = await deps.authority.resolveForRefresh(live.context);
        if (current.id !== expired.id || current.revision !== expired.revision) {
          throw new McpAccountAccessError("account_binding_changed");
        }
      });
      account = await deps.authority.resolve(context);
    }
    assertAccountMode(account, definition);
    return account;
  }

  function assertAccountMode(account: McpAccount, definition: McpAccountProbeDefinition): void {
    if (
      account.authentication !== definition.authentication ||
      (account.owner.scope === "shared" && !definition.sharedAllowed)
    ) {
      throw new McpAccountAccessError("account_access_denied");
    }
  }

  async function inspect(binding: McpExecutionBinding, capability: McpCapability) {
    const record = await deps.authorizations.get(deps.businessId, binding.authorizationId);
    if (
      !record ||
      canonicalHash(record.binding) !== canonicalHash(binding) ||
      canonicalHash(record.capability) !== canonicalHash(capability)
    ) {
      throw new McpAccountAccessError("account_binding_changed");
    }
    const live = await currentContext(
      record.caller,
      binding.serverId,
      binding.serverRevision,
      capability
    );
    if (
      contextDigest(live.context) !== record.contextDigest ||
      subject(live.context) !== binding.subjectId
    ) {
      throw new McpAccountAccessError("account_binding_changed");
    }
    const account = await resolveAccount(
      live.context,
      live.definition,
      record.caller,
      binding.serverRevision,
      capability
    );
    if (
      (account?.id ?? null) !== binding.accountId ||
      (account ? String(account.revision) : live.definition.definitionDigest) !==
        binding.accountRevision
    ) {
      throw new McpAccountAccessError("account_binding_changed");
    }
    return { ...live, account, record };
  }

  const access: McpAccountAccess = {
    async bind(input) {
      if (input.pinned) {
        const live = await inspect(input.pinned, input.capability);
        if (
          canonicalHash(live.record.caller) !== canonicalHash(input.caller) ||
          input.pinned.serverRevision !== input.serverRevision ||
          input.pinned.serverId !== input.server.id
        ) {
          throw new McpAccountAccessError("account_binding_changed");
        }
        return input.pinned;
      }
      const { context, definition } = await currentContext(
        input.caller,
        input.server.id,
        input.serverRevision,
        input.capability
      );
      if (canonicalHash(input.server) !== canonicalHash(definition.server)) {
        throw new McpAccountAccessError("definition_changed");
      }
      const account = await resolveAccount(
        context,
        definition,
        input.caller,
        input.serverRevision,
        input.capability
      );
      const material = {
        businessId: deps.businessId,
        contextDigest: contextDigest(context),
        caller: input.caller,
        capability: input.capability,
        binding: {
          serverId: input.server.id,
          serverRevision: input.serverRevision,
          accountId: account?.id ?? null,
          accountRevision: account ? String(account.revision) : definition.definitionDigest,
          subjectId: subject(context),
        },
      };
      const record: McpExecutionAuthorization = {
        ...material,
        binding: { ...material.binding, authorizationId: canonicalHash(material) },
      };
      if (!(await deps.authorizations.save(record))) {
        throw new McpAccountAccessError("conflict");
      }
      return record.binding;
    },
    async revalidate(binding, capability) {
      await inspect(binding, capability);
    },
    async use<T>(
      binding: McpExecutionBinding,
      server: McpServerDefinition,
      callback: (session: McpSession) => Promise<T>
    ): Promise<T> {
      const record = await deps.authorizations.get(deps.businessId, binding.authorizationId);
      if (!record) throw new McpAccountAccessError("account_binding_changed");
      const { account, definition } = await inspect(binding, record.capability);
      if (canonicalHash(server) !== canonicalHash(definition.server)) {
        throw new McpAccountAccessError("definition_changed");
      }
      const deadline = Date.now() + 55_000;
      const authorize = async () => {
        if (Date.now() >= deadline) throw new McpError("timeout");
        const live = await inspect(binding, record.capability);
        if (
          canonicalHash(live.account?.secretBindings ?? {}) !==
          canonicalHash(account?.secretBindings ?? {})
        ) {
          throw new McpAccountAccessError("account_binding_changed");
        }
      };
      const transport = server.transport;
      const selectedBindings =
        account?.authentication === "oauth"
          ? account.secretBindings.accessToken
            ? { accessToken: account.secretBindings.accessToken }
            : {}
          : (account?.secretBindings ?? {});
      return deps.secrets.use(
        selectedBindings,
        {
          businessId: deps.businessId,
          accountId: binding.accountId ?? `public:${server.id}`,
          accountRevision: account?.revision ?? 1,
          definitionDigest: definition.definitionDigest,
          principalId: binding.subjectId,
          destination: transport.type === "streamable-http" ? transport.url : transport.image,
          purpose: record.capability.kind,
          ...(record.caller.runId ? { runId: record.caller.runId } : {}),
          ...(record.capability.kind === "tool" ? { toolId: record.capability.name } : {}),
        },
        authorize,
        async (credentials) => {
          if (transport.type === "stdio" && !deps.localBackend) {
            throw new McpError("unsupported_backend");
          }
          const environment = Object.fromEntries(
            definition.requiredSlots.map((slot) => {
              const value = credentials[slot];
              if (!value) throw new McpAccountAccessError("account_unavailable");
              return [slot, value];
            })
          );
          const client = new McpClient({
            server,
            identity: {
              serverId: server.id,
              accountId: binding.accountId,
              subjectId: binding.subjectId,
              configurationRevision: `${binding.serverRevision}:${binding.accountRevision}`,
            },
            environment: deps.environment,
            beforeRequest: async (_identity, operation) => {
              await authorize();
              const capability = record.capability;
              if (
                operation.type !== "connect" &&
                operation.type !== "discover" &&
                !(
                  (operation.type === "callTool" &&
                    capability.kind === "tool" &&
                    operation.name === capability.name) ||
                  (operation.type === "readResource" &&
                    capability.kind === "resource" &&
                    operation.uri === capability.name) ||
                  (operation.type === "getPrompt" &&
                    capability.kind === "prompt" &&
                    operation.name === capability.name)
                )
              ) {
                throw new McpAccountAccessError("account_access_denied");
              }
            },
            ...(transport.type === "stdio"
              ? {
                  local: deps.localBackend?.(environment),
                  localCredentials: {
                    environment: async () => {
                      await authorize();
                      return environment;
                    },
                  },
                }
              : {
                  remote: {
                    fetch: async (url: string | URL, init?: RequestInit) => {
                      await authorize();
                      if (new URL(url).href !== new URL(transport.url).href) {
                        throw new McpAccountAccessError("definition_changed");
                      }
                      const headers = new Headers(init?.headers);
                      if (definition.authentication !== "none") {
                        const token = credentials.accessToken;
                        if (!token || /[\r\n]/.test(token)) {
                          throw new McpAccountAccessError("account_unavailable");
                        }
                        headers.set("authorization", `Bearer ${token}`);
                      }
                      return deps.guardedFetch(url, { ...init, headers, redirect: "error" });
                    },
                  },
                }),
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          const expired = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new McpError("timeout", record.capability.kind === "tool" ? "unknown" : "none")
                ),
              Math.max(0, deadline - Date.now())
            );
          });
          try {
            return await Promise.race([callback(client), expired]);
          } finally {
            clearTimeout(timer);
            await client.close();
          }
        }
      );
    },
  };

  function callerForContext(context: McpAccountUseContext): McpCaller {
    return {
      principal: { kind: "user", id: subject(context) },
      ...(context.kind === "chat" ? { conversationId: context.conversationId } : {}),
      ...(context.kind === "routine" ? { routineId: context.routineId } : {}),
      ...(context.kind === "knowledge_sync" ? { knowledgeSyncId: context.syncId } : {}),
      ...(context.kind === "interactive" && context.accountId
        ? { accountId: context.accountId }
        : {}),
    };
  }

  async function openContext<T>(
    context: McpAccountUseContext,
    capability: McpCapability,
    callback: (session: McpSession) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const definition = deps.integration(context.integrationKey);
    if (!definition) throw new McpAccountAccessError("definition_changed");
    if (
      capability.kind === "tool" &&
      !definition.reviewed.tools.some(
        (tool) => tool.name === capability.name && !tool.mutating && !tool.requiresApproval
      )
    ) {
      throw new McpAccountAccessError("account_access_denied");
    }
    const caller = callerForContext(context);
    const live = await currentContext(
      caller,
      context.integrationKey,
      mcpServerRevision(definition),
      capability
    );
    if (contextDigest(live.context) !== contextDigest(context)) {
      throw new McpAccountAccessError("account_binding_changed");
    }
    const binding = await access.bind({
      caller,
      server: definition.server,
      serverRevision: mcpServerRevision(definition),
      capability,
    });
    return access.use(binding, definition.server, async (session) => {
      await session.connect({ signal });
      return callback(session);
    });
  }

  return {
    ...access,
    openContext,
    knowledgeAccess: createMcpKnowledgeAccountHost(deps, openContext),
    async accountConfiguration(serverId: string) {
      const { authentication, requiredSlots, sharedAllowed } = await deps.definition(serverId);
      return { authentication, requiredSlots: [...requiredSlots], sharedAllowed };
    },
  };
}
