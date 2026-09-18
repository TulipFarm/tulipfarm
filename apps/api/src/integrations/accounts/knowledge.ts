import {
  McpAccountAccessError,
  type McpAccountUseContext,
  mcpCapabilityDigest,
} from "@tulipfarm/integrations";
import {
  GITHUB_KNOWLEDGE_IMAGE,
  GITHUB_KNOWLEDGE_SERVER_REVISION,
  type McpKnowledgeBinding,
  parseGithubKnowledgeIdentity,
} from "@tulipfarm/knowledge";
import { canonicalHash } from "@tulipfarm/schema";
import type { McpKnowledgeAccountHost } from "../../knowledge-sources/mcp/compose";
import type { McpContextSession, McpRuntimeAccountsDeps } from "./runtime";

export function createMcpKnowledgeAccountHost(
  deps: McpRuntimeAccountsDeps,
  openContext: McpContextSession
): McpKnowledgeAccountHost {
  async function bindingFor(input: {
    readonly integrationKey: string;
    readonly accountId: string;
    readonly readerUserId: string;
  }) {
    const account = await deps.accounts.get(deps.businessId, input.accountId);
    const integration = deps.integration(input.integrationKey);
    if (
      !account ||
      !integration?.enabled ||
      account.integrationKey !== input.integrationKey ||
      account.owner.scope !== "personal" ||
      account.owner.principalId !== input.readerUserId ||
      account.authentication !== "token" ||
      account.status !== "active" ||
      integration.server.transport.type !== "stdio" ||
      integration.server.transport.image !== GITHUB_KNOWLEDGE_IMAGE ||
      integration.server.transport.command !== "/server/github-mcp-server" ||
      canonicalHash(integration.server.transport.args) !== canonicalHash(["stdio"]) ||
      !deps.localBackend ||
      !(await deps.authorization.isActivePrincipal(deps.businessId, input.readerUserId))
    ) {
      return undefined;
    }
    const definition = await deps.definition(input.integrationKey);
    if (
      definition.definitionDigest !== account.definitionDigest ||
      definition.authentication !== "token" ||
      definition.requiredSlots.length !== 1 ||
      definition.requiredSlots[0] !== "GITHUB_PERSONAL_ACCESS_TOKEN" ||
      !["get_me", "get_file_contents"].every((name) =>
        integration.reviewed.tools.some(
          (tool) => tool.name === name && !tool.mutating && !tool.requiresApproval
        )
      ) ||
      (account.expiresAt !== null && Date.parse(account.expiresAt) <= Date.now())
    ) {
      return undefined;
    }
    return {
      businessId: deps.businessId,
      integrationId: input.integrationKey,
      accountId: account.id,
      accountRevision: account.revision,
      ownerUserId: input.readerUserId,
      configurationRevision: account.definitionDigest,
    };
  }

  async function assertBinding(
    binding: Omit<McpKnowledgeBinding, "externalAccountId">,
    readerUserId: string
  ): Promise<void> {
    const live = await bindingFor({
      integrationKey: binding.integrationId,
      accountId: binding.accountId,
      readerUserId,
    });
    const expected = {
      businessId: binding.businessId,
      integrationId: binding.integrationId,
      accountId: binding.accountId,
      accountRevision: binding.accountRevision,
      ownerUserId: binding.ownerUserId,
      configurationRevision: binding.configurationRevision,
    };
    if (!live || canonicalHash(live) !== canonicalHash(expected)) {
      throw new McpAccountAccessError("account_binding_changed");
    }
  }

  async function call(
    context: McpAccountUseContext,
    name: "get_me" | "get_file_contents",
    args: Readonly<Record<string, string>>,
    assertCurrent: () => Promise<void>,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    await assertCurrent();
    return openContext(
      context,
      { kind: "tool", name },
      async (session) => {
        const discovery = await session.discover({ signal });
        const tool = discovery.tools.find((candidate) => candidate.name === name);
        const review = deps
          .integration(context.integrationKey)
          ?.reviewed.tools.find((candidate) => candidate.name === name);
        if (
          !tool ||
          !review ||
          review.mutating ||
          review.requiresApproval ||
          mcpCapabilityDigest(tool) !== review.digest
        ) {
          throw new McpAccountAccessError("definition_changed");
        }
        await assertCurrent();
        const result = await session.callTool(tool, args, { signal });
        await assertCurrent();
        return result;
      },
      signal
    );
  }

  return {
    bindingFor,
    async captureIdentity({ binding, readerUserId }) {
      const assertCurrent = () => assertBinding(binding, readerUserId);
      await assertCurrent();
      const context: McpAccountUseContext = {
        kind: "interactive",
        businessId: binding.businessId,
        integrationKey: binding.integrationId,
        definitionDigest: binding.configurationRevision,
        principalId: readerUserId,
        accountId: binding.accountId,
        purpose: "content",
      };
      return parseGithubKnowledgeIdentity(await call(context, "get_me", {}, assertCurrent));
    },
    async open(input, callback) {
      const assertCurrent = async () => {
        await input.assertCurrent();
        await assertBinding(input.binding, input.readerUserId);
      };
      await assertCurrent();
      return callback({
        binding: input.binding,
        readerUserId: input.readerUserId,
        server: {
          distribution: "github-official-local",
          revision: GITHUB_KNOWLEDGE_SERVER_REVISION,
        },
        async callTool(request) {
          const capability = { kind: "tool" as const, name: request.name };
          const context = await deps.context(
            {
              principal: { kind: "user", id: input.readerUserId },
              knowledgeSyncId: input.selectionId,
            },
            {
              businessId: input.binding.businessId,
              integrationKey: input.binding.integrationId,
              definitionDigest: input.binding.configurationRevision,
            },
            capability
          );
          if (
            context.kind !== "knowledge_sync" ||
            context.syncId !== input.selectionId ||
            context.ownerPrincipalId !== input.readerUserId ||
            context.accountId !== input.binding.accountId ||
            context.accountRevision !== input.binding.accountRevision
          ) {
            throw new McpAccountAccessError("account_binding_changed");
          }
          return call(context, request.name, request.arguments, assertCurrent, request.signal);
        },
      });
    },
  };
}
