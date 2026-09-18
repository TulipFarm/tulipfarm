import { type Static, Type } from "@sinclair/typebox";
import {
  McpAccountAccessError,
  type McpAccountAuthority,
  type McpAccountLifecycle,
  McpAccountLifecycleError,
  type McpAccountRepository,
  type McpChatAccountContext,
  summarizeMcpAccount,
} from "@tulipfarm/integrations";
import {
  type McpAccount,
  McpAccountCreateSchema,
  type McpAccountGrant,
  McpAccountGrantSchema,
  McpAccountSelectionRequestSchema,
  McpAccountSummarySchema,
} from "@tulipfarm/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { RequireAuthorization } from "../../authz/route-gate";
import type { RequestPrincipal } from "../../identity/principal";
import { McpAccountGrantSummarySchema } from "./schemas";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const id = Type.String({ minLength: 1, maxLength: 256 });
const keyParams = Type.Object({ key: id }, { additionalProperties: false });
const accountParams = Type.Object({ key: id, accountId: id }, { additionalProperties: false });
const subject = Type.Object(
  {
    kind: Type.Unsafe<McpAccountGrant["subject"]["kind"]>({
      type: "string",
      enum: ["user", "team", "routine", "knowledge_sync"],
    }),
    id,
  },
  { additionalProperties: false }
);
const updateSchema = Type.Partial(
  Type.Pick(McpAccountCreateSchema, ["label", "isDefault", "values"]),
  { additionalProperties: false, minProperties: 1 }
);
const security: Record<string, string[]>[] = [{ sessionCookie: [] }, { bearerToken: [] }];
const errors = {
  400: ErrorSchema,
  401: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  409: ErrorSchema,
  422: ErrorSchema,
  502: ErrorSchema,
};

export interface McpAccountRoutesDeps {
  readonly accounts: McpAccountRepository;
  readonly authority: McpAccountAuthority;
  readonly lifecycle: McpAccountLifecycle;
  readonly chatContext: (
    principal: RequestPrincipal,
    conversationId: string,
    integrationKey: string
  ) => Promise<McpChatAccountContext>;
  readonly grantSubject: (
    principal: RequestPrincipal,
    account: McpAccount,
    subjectInput: Static<typeof subject>
  ) => Promise<McpAccountGrant["subject"]>;
  readonly audit: (input: {
    readonly action: string;
    readonly principal: RequestPrincipal;
    readonly accountId: string;
    readonly subject?: Static<typeof subject>;
  }) => Promise<void>;
}

function caller(request: FastifyRequest): RequestPrincipal {
  if (request.principal?.kind !== "user") {
    throw new McpAccountAccessError("account_access_denied");
  }
  return request.principal;
}

export async function accountResponse<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: () => Promise<T>
): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpAccountAccessError || error instanceof McpAccountLifecycleError) {
      request.log.warn({ event: "integration.account.refused", code: error.code });
      const status =
        error.code === "account_not_found"
          ? 404
          : error.code === "account_access_denied" ||
              error.code === "principal_inactive" ||
              error.code === "private_context_required"
            ? 403
            : error.code === "probe_failed"
              ? 502
              : error instanceof McpAccountLifecycleError
                ? 422
                : 409;
      return reply.code(status).send({ error: error.code });
    }
    throw error;
  }
}

export function registerMcpAccountRoutes(
  app: FastifyInstance,
  deps: McpAccountRoutesDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const gate = (action: string, fallback: "admin" | "authenticated" = "authenticated") => [
    requireAuth,
    requireAuthorization({ action, resourceType: "integration_account", fallback }),
  ];
  const base = "/api/v1/integrations/:key/accounts";
  const chatContext = async (
    principal: RequestPrincipal,
    conversationId: string,
    integrationKey: string
  ) => {
    const context = await deps.chatContext(principal, conversationId, integrationKey);
    if (
      context.kind !== "chat" ||
      context.principalId !== principal.id ||
      context.businessId !== principal.businessId ||
      context.conversationId !== conversationId ||
      context.integrationKey !== integrationKey
    ) {
      throw new McpAccountAccessError("account_access_denied");
    }
    return context;
  };
  app.get<{ Params: Static<typeof keyParams> }>(
    base,
    {
      preHandler: gate("integration.accounts.read"),
      schema: {
        description: "List the caller's personal and explicitly granted shared MCP accounts.",
        tags: ["integrations"],
        security,
        params: keyParams,
        response: { 200: Type.Array(McpAccountSummarySchema), ...errors },
      },
    },
    (request, reply) =>
      accountResponse(request, reply, () => {
        const principal = caller(request);
        return deps.authority.list(principal.businessId, request.params.key, principal.id);
      })
  );
  app.post<{ Params: Static<typeof keyParams>; Body: Static<typeof McpAccountCreateSchema> }>(
    base,
    {
      preHandler: gate("integration.accounts.write"),
      schema: {
        description: "Create and probe an MCP account; browser OAuth starts pending.",
        tags: ["integrations"],
        security,
        params: keyParams,
        body: McpAccountCreateSchema,
        response: { 201: McpAccountSummarySchema, ...errors },
      },
    },
    (request, reply) =>
      accountResponse(request, reply, async () => {
        const principal = caller(request);
        const result = await deps.lifecycle.create(
          principal.businessId,
          request.params.key,
          principal.id,
          request.body
        );
        return reply.code(201).send(result);
      })
  );
  app.patch<{ Params: Static<typeof accountParams>; Body: Static<typeof updateSchema> }>(
    `${base}/:accountId`,
    {
      preHandler: gate("integration.accounts.write"),
      schema: {
        description: "Rename, set a default, or replace and probe an exact MCP account.",
        tags: ["integrations"],
        security,
        params: accountParams,
        body: updateSchema,
        response: { 200: McpAccountSummarySchema, ...errors },
      },
    },
    (request, reply) =>
      accountResponse(request, reply, () => {
        const principal = caller(request);
        return deps.lifecycle.update(
          principal.businessId,
          request.params.key,
          request.params.accountId,
          principal.id,
          request.body
        );
      })
  );
  app.delete<{ Params: Static<typeof accountParams> }>(
    `${base}/:accountId`,
    {
      preHandler: gate("integration.accounts.write"),
      schema: {
        description:
          "Revoke an exact MCP account and invalidate subsequent use before Secret deletion.",
        tags: ["integrations"],
        security,
        params: accountParams,
        response: { 200: McpAccountSummarySchema, ...errors },
      },
    },
    (request, reply) =>
      accountResponse(request, reply, () => {
        const principal = caller(request);
        return deps.lifecycle.revoke(
          principal.businessId,
          request.params.key,
          request.params.accountId,
          principal.id
        );
      })
  );
  const managedShared = async (
    request: FastifyRequest<{ Params: Static<typeof accountParams> }>
  ) => {
    const principal = caller(request);
    const account = await deps.lifecycle.managed(
      principal.businessId,
      request.params.key,
      request.params.accountId,
      principal.id
    );
    if (account.owner.scope !== "shared") {
      throw new McpAccountAccessError("account_access_denied");
    }
    return { principal, account };
  };
  app.get<{ Params: Static<typeof accountParams> }>(
    `${base}/:accountId/grants`,
    {
      preHandler: gate("integration.accounts.manage", "admin"),
      schema: {
        description:
          "List shared-account grants with server-calculated approval status against the current account revision and persisted target configuration.",
        tags: ["integrations"],
        security,
        params: accountParams,
        response: { 200: Type.Array(McpAccountGrantSummarySchema), ...errors },
      },
    },
    (request, reply) =>
      accountResponse(request, reply, async () => {
        const { principal, account } = await managedShared(request);
        const grants = await deps.accounts.grants(principal.businessId, account.id);
        const summaries: Static<typeof McpAccountGrantSummarySchema>[] = [];
        for (const grant of grants) {
          let status: "active" | "stale" = "stale";
          if (grant.accountRevision === account.revision) {
            try {
              const current = await deps.grantSubject(principal, account, {
                kind: grant.subject.kind,
                id: grant.subject.id,
              });
              if (
                current.kind === grant.subject.kind &&
                current.id === grant.subject.id &&
                (!("configurationDigest" in grant.subject) ||
                  ("configurationDigest" in current &&
                    current.configurationDigest === grant.subject.configurationDigest))
              ) {
                status = "active";
              }
            } catch (error) {
              if (!(error instanceof McpAccountAccessError)) throw error;
              request.log.warn({
                event: "integration.account.grant_stale",
                accountId: account.id,
                code: error.code,
              });
            }
          }
          summaries.push({ ...grant, status });
        }
        return summaries;
      })
  );
  app.post<{ Params: Static<typeof accountParams>; Body: Static<typeof subject> }>(
    `${base}/:accountId/grants`,
    {
      preHandler: gate("integration.accounts.manage", "admin"),
      schema: {
        description:
          "Grant shared access to a live user, Team, Routine, or Knowledge sync. Configuration digests are computed by the server.",
        tags: ["integrations"],
        security,
        params: accountParams,
        body: subject,
        response: { 201: McpAccountGrantSchema, ...errors },
      },
    },
    (request, reply) =>
      accountResponse(request, reply, async () => {
        const { principal, account } = await managedShared(request);
        const grant: McpAccountGrant = {
          businessId: principal.businessId,
          accountId: account.id,
          accountRevision: account.revision,
          subject: await deps.grantSubject(principal, account, request.body),
          grantedBy: principal.id,
          grantedAt: new Date().toISOString(),
        };
        if (!(await deps.accounts.saveGrant(grant))) {
          throw new McpAccountAccessError("conflict");
        }
        await deps.audit({
          action: "integration.account.grant_added",
          principal,
          accountId: account.id,
          subject: request.body,
        });
        return reply.code(201).send(grant);
      })
  );
  const revokeParams = Type.Object(
    { key: id, accountId: id, subjectKind: subject.properties.kind, subjectId: id },
    { additionalProperties: false }
  );
  app.delete<{ Params: Static<typeof revokeParams> }>(
    `${base}/:accountId/grants/:subjectKind/:subjectId`,
    {
      preHandler: gate("integration.accounts.manage", "admin"),
      schema: {
        description: "Revoke a specific shared-account grant for subsequent MCP calls.",
        tags: ["integrations"],
        security,
        params: revokeParams,
        response: { 204: Type.Null(), ...errors },
      },
    },
    (request, reply) =>
      accountResponse(request, reply, async () => {
        const { principal, account } = await managedShared(request);
        await deps.accounts.revokeGrant(
          principal.businessId,
          account.id,
          request.params.subjectKind,
          request.params.subjectId
        );
        await deps.audit({
          action: "integration.account.grant_revoked",
          principal,
          accountId: account.id,
          subject: { kind: request.params.subjectKind, id: request.params.subjectId },
        });
        return reply.code(204).send();
      })
  );
  const chatParams = Type.Object({ conversationId: id, key: id }, { additionalProperties: false });
  const chatPath = "/api/v1/chats/:conversationId/integrations/:key/account";
  app.get<{ Params: Static<typeof chatParams> }>(
    chatPath,
    {
      preHandler: gate("integration.accounts.read"),
      schema: {
        description:
          "Resolve the exact current account for a Chat using its durable audience and membership.",
        tags: ["integrations"],
        security,
        params: chatParams,
        response: { 200: McpAccountSummarySchema, ...errors },
      },
    },
    (request, reply) =>
      accountResponse(request, reply, async () => {
        const context = await chatContext(
          caller(request),
          request.params.conversationId,
          request.params.key
        );
        const account = await deps.authority.resolve(context);
        return summarizeMcpAccount(account);
      })
  );
  app.put<{
    Params: Static<typeof chatParams>;
    Body: Static<typeof McpAccountSelectionRequestSchema>;
  }>(
    chatPath,
    {
      preHandler: gate("integration.accounts.write"),
      schema: {
        description:
          "Explicitly choose an exact MCP account for a Chat; shared use requires confirmation.",
        tags: ["integrations"],
        security,
        params: chatParams,
        body: McpAccountSelectionRequestSchema,
        response: { 200: McpAccountSummarySchema, ...errors },
      },
    },
    (request, reply) =>
      accountResponse(request, reply, async () => {
        const principal = caller(request);
        const context = await chatContext(
          principal,
          request.params.conversationId,
          request.params.key
        );
        const selected = await deps.authority.selectChatAccount(
          context,
          request.body.accountId,
          request.body.confirmShared
        );
        await deps.audit({
          action: "integration.account.selected",
          principal,
          accountId: selected.id,
        });
        return selected;
      })
  );
}
