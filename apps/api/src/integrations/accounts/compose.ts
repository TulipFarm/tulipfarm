import {
  McpAccountAuthority,
  McpAccountLifecycle,
  McpAccountLifecycleError,
  McpOAuthLifecycle,
} from "@tulipfarm/integrations";
import type { IsolatedMcpStdioBackend, McpOAuthOptions } from "@tulipfarm/mcp";
import { McpAccountSecrets, type SecretsService } from "@tulipfarm/secrets";
import {
  McpAccountStore,
  McpOAuthStore,
  type Queryable,
  type TeamRepo,
  type TransactionPort,
} from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UserRepo } from "../../auth/users";
import type { AuthorizationCheck, RequireAuthorization } from "../../authz/route-gate";
import { createMcpAccountAuthorization } from "./authorization";
import { createMcpAccountOAuthProtocol } from "./oauth-protocol";
import { registerMcpOAuthRoutes } from "./oauth-routes";
import { createMcpAccountProbe, type McpAccountProbeDefinition } from "./probe";
import { type McpAccountRoutesDeps, registerMcpAccountRoutes } from "./routes";

export interface McpAccountFeatureDeps {
  readonly db: Queryable;
  readonly transactions: TransactionPort;
  readonly secrets: SecretsService;
  readonly businessId: string;
  readonly users: Pick<UserRepo, "findById">;
  readonly teams: Pick<TeamRepo, "getTeam" | "getMembership">;
  readonly authorizationCheck: AuthorizationCheck;
  readonly definition: (key: string) => Promise<McpAccountProbeDefinition>;
  readonly guardedFetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly localBackend?: (
    environment: Readonly<Record<string, string>>
  ) => IsolatedMcpStdioBackend;
  readonly environment: "development" | "production";
  readonly oauthUrlPolicy: McpOAuthOptions["validateUrl"];
  readonly callbackUrl: (integrationKey: string, accountId: string) => string;
  readonly webUrl: () => Promise<string>;
  readonly chatContext: McpAccountRoutesDeps["chatContext"];
  readonly grantSubject: McpAccountRoutesDeps["grantSubject"];
  readonly audit: (event: {
    readonly action: string;
    readonly businessId: string;
    readonly accountId: string;
    readonly principalId: string;
    readonly revision?: number;
    readonly code?: string;
    readonly subject?: { readonly kind: string; readonly id: string };
  }) => Promise<void>;
}

export function composeMcpAccounts(deps: McpAccountFeatureDeps) {
  const accounts = new McpAccountStore(deps.db, deps.transactions);
  const authorization = createMcpAccountAuthorization(deps);
  const authority = new McpAccountAuthority(accounts, authorization);
  const secrets = new McpAccountSecrets(deps.secrets);
  const attempts = new McpOAuthStore(deps.db);
  const lifecycle = new McpAccountLifecycle({
    accounts,
    authority,
    secrets,
    definition: deps.definition,
    probe: createMcpAccountProbe({
      secrets,
      definition: deps.definition,
      guardedFetch: deps.guardedFetch,
      localBackend: deps.localBackend,
      environment: deps.environment,
    }),
    audit: deps.audit,
  });
  const oauth = new McpOAuthLifecycle({
    accounts,
    lifecycle,
    attempts,
    secrets,
    protocol: createMcpAccountOAuthProtocol({
      fetch: deps.guardedFetch,
      validateUrl: deps.oauthUrlPolicy,
    }),
    definition: async (key) => {
      const definition = await deps.definition(key);
      if (definition.server.transport.type !== "streamable-http") {
        throw new McpAccountLifecycleError("unsupported_account_mode");
      }
      return { ...definition, serverUrl: definition.server.transport.url };
    },
    callbackUrl: deps.callbackUrl,
    audit: deps.audit,
  });
  const routes: McpAccountRoutesDeps = {
    accounts,
    authority,
    lifecycle,
    chatContext: deps.chatContext,
    grantSubject: deps.grantSubject,
    audit: (event) =>
      deps.audit({
        action: event.action,
        businessId: event.principal.businessId,
        accountId: event.accountId,
        principalId: event.principal.id,
        ...(event.subject ? { subject: event.subject } : {}),
      }),
  };
  return {
    accounts,
    authority,
    authorization,
    secrets,
    lifecycle,
    oauth,
    register(
      app: FastifyInstance,
      requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
      requireAuthorization: RequireAuthorization
    ) {
      registerMcpAccountRoutes(app, routes, requireAuth, requireAuthorization);
      registerMcpOAuthRoutes(
        app,
        { oauth, webUrl: deps.webUrl },
        requireAuth,
        requireAuthorization
      );
    },
  };
}
