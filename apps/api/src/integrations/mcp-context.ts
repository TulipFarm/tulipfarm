import {
  accountDefinitionForIntegration,
  McpAccountAccessError,
  type McpAccountAuthority,
  type McpAccountRepository,
  type McpAccountScope,
  type McpAccountUseContext,
  type McpCaller,
  type McpCapability,
  type McpChatAccountContext,
  McpIntegrationError,
} from "@tulipfarm/integrations";
import {
  type AgentDefinition,
  AgentDefinitionSchema,
  ajv,
  canonicalHash,
  type McpAccount,
  mcpToolName,
  routine,
  type ToolContractDefinition,
  ToolContractDefinitionSchema,
} from "@tulipfarm/schema";
import { mcpIntegrationsFromBundle, type RuntimeBundle } from "@tulipfarm/soul";
import type {
  NativeChannelInboxStore,
  PersistedRun,
  Queryable,
  RunStore,
} from "@tulipfarm/storage";
import type { FastifyRequest } from "fastify";
import type { ConversationRepo } from "../chat/conversations";
import type { ConversationStore } from "../conversations/service";
import type { RequestPrincipal } from "../identity/principal";
import type { RoutineMcpBundleReader } from "../internal/routine-mcp-authority";
import { NativeChannelError } from "./native/credentials";
import type { NativeChannelDeps } from "./native/service";

const validateRoutine = ajv.compile<routine.RoutineDefinition>(routine.RoutineDefinitionSchema);
const validateAgent = ajv.compile<AgentDefinition>(AgentDefinitionSchema);
const validateTool = ajv.compile<ToolContractDefinition>(ToolContractDefinitionSchema);

export interface McpHostContextDeps {
  readonly businessId: string;
  readonly db: Queryable;
  readonly runs: Pick<RunStore, "find" | "listLineage">;
  readonly turns: Pick<ConversationStore, "findTurnByRunId">;
  readonly conversations: Pick<ConversationRepo, "findById">;
  readonly accounts: Pick<McpAccountRepository, "list" | "grants">;
  readonly accountAuthority: Pick<McpAccountAuthority, "resolve" | "resolveForRefresh">;
  readonly nativeRoutes: Pick<NativeChannelInboxStore, "routineRoutes" | "findByRun">;
  readonly activeBundle: () => Promise<RuntimeBundle | undefined>;
  readonly bundles: RoutineMcpBundleReader;
}

/** Resolves account authority from durable product identity, never Worker or model account arguments. */
export class McpHostContextResolver {
  constructor(private readonly deps: McpHostContextDeps) {}

  readonly callerForRequest = async (
    request: FastifyRequest,
    conversationId?: string
  ): Promise<McpCaller> => {
    const principal = request.principal;
    if (principal?.kind !== "user" || principal.businessId !== this.deps.businessId) {
      throw new McpAccountAccessError("account_access_denied");
    }
    if (conversationId !== undefined) await this.assertConversation(principal.id, conversationId);
    return {
      principal: { kind: "user", id: principal.id },
      ...(conversationId ? { conversationId } : {}),
    };
  };

  readonly callerForRun = async (input: {
    readonly runId: string;
    readonly principal: { readonly kind: string; readonly id: string };
  }): Promise<McpCaller> => {
    const current = await this.deps.runs.find(this.deps.businessId, input.runId);
    if (
      current?.status !== "running" ||
      current.identity.effectiveSubject.kind !== input.principal.kind ||
      current.identity.effectiveSubject.id !== input.principal.id
    )
      throw new McpAccountAccessError("account_access_denied");
    const root = await this.originalRun(current);
    const turn = await this.deps.turns.findTurnByRunId(this.deps.businessId, root.id);
    return {
      principal: root.identity.effectiveSubject,
      runId: current.id,
      ...(root.source === "routine" ? { routineId: root.bundle.routineId } : {}),
      ...(turn ? { conversationId: turn.conversationId } : {}),
    };
  };

  readonly knowledgeReaderForRun = async (runId: string): Promise<string | undefined> => {
    const current = await this.deps.runs.find(this.deps.businessId, runId);
    if (current?.status !== "running") return undefined;
    try {
      const caller = await this.callerForRun({
        runId,
        principal: current.identity.effectiveSubject,
      });
      if (caller.principal.kind !== "user") return undefined;
      const root = await this.originalRun(current);
      if (root.identity.initiator.kind === "integration") return undefined;
      if (caller.conversationId !== undefined) {
        await this.assertConversation(caller.principal.id, caller.conversationId);
        return (await this.conversationVisibility(caller.conversationId)) === "private"
          ? caller.principal.id
          : undefined;
      }
      if (caller.routineId === undefined) return undefined;
      const pinned = await this.deps.bundles.load(this.deps.businessId, root.bundle.digest);
      if (!pinned) return undefined;
      assertMcpRoutineUnchanged(pinned, await this.deps.activeBundle(), caller.routineId);
      return caller.principal.id;
    } catch (error) {
      if (error instanceof McpAccountAccessError || error instanceof McpIntegrationError)
        return undefined;
      throw error;
    }
  };

  async chatContext(
    principal: Pick<RequestPrincipal, "kind" | "id" | "businessId">,
    conversationId: string,
    scope: McpAccountScope
  ): Promise<McpChatAccountContext> {
    if (
      principal.kind !== "user" ||
      principal.businessId !== this.deps.businessId ||
      scope.businessId !== this.deps.businessId
    ) {
      throw new McpAccountAccessError("account_access_denied");
    }
    await this.assertConversation(principal.id, conversationId);
    return {
      ...scope,
      kind: "chat",
      principalId: principal.id,
      conversationId,
      visibility: await this.conversationVisibility(conversationId),
    };
  }

  private async conversationVisibility(conversationId: string): Promise<"private" | "shared"> {
    const external = await this.deps.db.query<{ provider: string; destination: string }>(
      `SELECT d.provider, d.destination
       FROM channel_run_deliveries d
       JOIN conversation_turns t ON t.run_id::text = d.run_id
       WHERE d.business_id = $1 AND t.conversation_id = $2`,
      [this.deps.businessId, conversationId]
    );
    const mappings = await this.deps.db.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM integration_conversations WHERE conversation_id = $1",
      [conversationId]
    );
    const privateChannel =
      external.rows.length > 0 &&
      external.rows.every((row) => row.provider === "slack" && row.destination.startsWith("D"));
    const sharedRequests = await this.deps.db.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE conversation_id = $1 AND role = 'user'
         AND (
           (metadata #> '{turnRequest,nativeChannel}' IS NOT NULL
             AND metadata #>> '{turnRequest,nativeChannel,audience}' IS DISTINCT FROM 'private')
           OR (metadata #> '{turnRequest,channel}' IS NOT NULL
             AND metadata #>> '{turnRequest,channel,audience}' IS DISTINCT FROM 'private')
           OR (metadata -> 'nativeChannel' IS NOT NULL
             AND metadata #>> '{nativeChannel,audience}' IS DISTINCT FROM 'private')
           OR (metadata -> 'channel' IS NOT NULL
             AND metadata #>> '{channel,audience}' IS DISTINCT FROM 'private'))
       LIMIT 1`,
      [conversationId]
    );
    return sharedRequests.rows.length === 0 &&
      ((mappings.rows.length === 0 && external.rows.length === 0) || privateChannel)
      ? "private"
      : "shared";
  }

  async resolve(
    caller: McpCaller,
    scope: McpAccountScope,
    capability: McpCapability
  ): Promise<McpAccountUseContext> {
    if (scope.businessId !== this.deps.businessId)
      throw new McpAccountAccessError("account_access_denied");
    if (caller.runId === undefined) {
      if (caller.principal.kind !== "user" || capability.kind === "tool") {
        throw new McpAccountAccessError("account_access_denied");
      }
      if (caller.conversationId === undefined) {
        return {
          ...scope,
          kind: "interactive",
          principalId: caller.principal.id,
          ...(caller.accountId === undefined ? {} : { accountId: caller.accountId }),
          purpose: capability.kind === "discovery" ? "discovery" : "content",
        };
      }
      return this.chatContext(
        { ...caller.principal, kind: "user", businessId: this.deps.businessId },
        caller.conversationId,
        scope
      );
    }
    const current = await this.deps.runs.find(this.deps.businessId, caller.runId);
    if (current?.status !== "running") throw new McpAccountAccessError("account_access_denied");
    const root = await this.originalRun(current);
    if (
      root.identity.effectiveSubject.kind !== caller.principal.kind ||
      root.identity.effectiveSubject.id !== caller.principal.id
    )
      throw new McpAccountAccessError("account_access_denied");
    if (root.source !== "routine") {
      const turn = await this.deps.turns.findTurnByRunId(this.deps.businessId, root.id);
      if (!turn || caller.principal.kind !== "user")
        throw new McpAccountAccessError("account_access_denied");
      return this.chatContext(
        { kind: "user", id: caller.principal.id, businessId: this.deps.businessId },
        turn.conversationId,
        scope
      );
    }
    const active = await this.deps.activeBundle();
    const pinned = await this.deps.bundles.load(this.deps.businessId, root.bundle.digest);
    if (!pinned) throw new McpAccountAccessError("routine_approval_required");
    try {
      assertMcpRoutineUnchanged(pinned, active, root.bundle.routineId);
    } catch (error) {
      if (!(error instanceof McpIntegrationError)) throw error;
      throw new McpAccountAccessError("routine_approval_required");
    }
    const definition = active?.getById(root.bundle.routineId)?.document;
    if (!active || !validateRoutine(definition))
      throw new McpAccountAccessError("routine_approval_required");
    if (root.identity.initiator.kind === "integration") {
      await this.assertNativeRunAuthority(root);
    }
    const deliveries = await this.deps.db.query<{ run_id: string }>(
      "SELECT run_id FROM channel_run_deliveries WHERE business_id = $1 AND run_id = $2",
      [this.deps.businessId, root.id]
    );
    return this.approvedRoutineContext(
      active,
      root.bundle.routineId,
      scope,
      deliveries.rows.length > 0 || root.identity.initiator.kind === "integration"
        ? "shared"
        : "owner"
    );
  }

  private async approvedRoutineContext(
    bundle: RuntimeBundle,
    routineId: string,
    scope: McpAccountScope,
    visibility: "owner" | "shared"
  ): Promise<Extract<McpAccountUseContext, { kind: "routine" }>> {
    const definition = bundle.getById(routineId)?.document;
    if (!validateRoutine(definition)) throw new McpAccountAccessError("routine_approval_required");
    const ownerPrincipalId = definition.spec.owner;
    const candidates: Array<{ account: McpAccount; configurationDigest: string }> = [];
    for (const account of await this.deps.accounts.list(
      this.deps.businessId,
      scope.integrationKey,
      ownerPrincipalId
    )) {
      if (visibility === "shared" && account.owner.scope !== "shared") continue;
      const subject = await this.routineSubject(bundle, account, routineId);
      const granted = (await this.deps.accounts.grants(this.deps.businessId, account.id)).some(
        (grant) =>
          grant.accountRevision === account.revision &&
          grant.subject.kind === "routine" &&
          grant.subject.id === subject.id &&
          grant.subject.configurationDigest === subject.configurationDigest
      );
      if (granted) candidates.push({ account, configurationDigest: subject.configurationDigest });
    }
    if (candidates.length !== 1) throw new McpAccountAccessError("routine_approval_required");
    const selected = candidates[0];
    const context: Extract<McpAccountUseContext, { kind: "routine" }> = {
      ...scope,
      kind: "routine",
      routineId,
      ownerPrincipalId,
      accountId: selected.account.id,
      accountRevision: selected.account.revision,
      configurationDigest: selected.configurationDigest,
      visibility,
    };
    return context;
  }

  async routineGrantSubject(account: McpAccount, routineId: string) {
    const bundle = await this.deps.activeBundle();
    if (!bundle) throw new McpAccountAccessError("routine_approval_required");
    return this.routineSubject(bundle, account, routineId);
  }

  private async routineSubject(bundle: RuntimeBundle, account: McpAccount, routineId: string) {
    const definition = bundle?.getById(routineId)?.document;
    if (bundle.businessId !== this.deps.businessId || !validateRoutine(definition)) {
      throw new McpAccountAccessError("routine_approval_required");
    }
    if (account.owner.scope === "personal" && account.owner.principalId !== definition.spec.owner) {
      throw new McpAccountAccessError("account_access_denied");
    }
    const destinations = definition.spec.states.flatMap((state) =>
      state.type === "tool" && state.destination !== undefined ? [state.destination] : []
    );
    const nativeDestinations = (
      await Promise.all([
        this.deps.nativeRoutes.routineRoutes(this.deps.businessId, "slack"),
        this.deps.nativeRoutes.routineRoutes(this.deps.businessId, "github"),
      ])
    )
      .flat()
      .filter((route) => route.routineId === routineId)
      .map(({ id, provider, integrationId, destination, eventType, routineId }) => ({
        id,
        provider,
        integrationId,
        destination,
        eventType,
        routineId,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      kind: "routine" as const,
      id: routineId,
      configurationDigest: mcpRoutineConfigurationDigest(bundle, routineId, account, {
        owner: definition.spec.owner,
        destinations,
        nativeDestinations,
        output: definition.spec.output ?? null,
      }),
    };
  }

  readonly nativeRoutineAuthority: NonNullable<NativeChannelDeps["authorizeRoutine"]> = async (
    input
  ) => {
    try {
      const bundle = await this.deps.activeBundle();
      const definition = bundle?.getById(input.routineId)?.document;
      if (!bundle || bundle.businessId !== this.deps.businessId || !validateRoutine(definition)) {
        throw new NativeChannelError("native_routine_not_published");
      }
      const material = mcpRoutineMaterial(bundle, input.routineId);
      if (
        material.integrations.length > 0 &&
        !(await this.deps.nativeRoutes.routineRoutes(this.deps.businessId, input.provider)).some(
          (route) =>
            route.routineId === input.routineId &&
            route.integrationId === input.integrationId &&
            route.destination === input.destination &&
            route.eventType === input.eventType
        )
      )
        throw new NativeChannelError("native_routine_destination_approval_required");
      const accounts: Array<Extract<McpAccountUseContext, { kind: "routine" }>> = [];
      for (const { id: serverId, definition: integration } of material.integrations) {
        const accountDefinition = accountDefinitionForIntegration(integration);
        if (!accountDefinition.sharedAllowed)
          throw new NativeChannelError("native_routine_shared_account_unavailable");
        try {
          const context = await this.approvedRoutineContext(
            bundle,
            input.routineId,
            {
              businessId: this.deps.businessId,
              integrationKey: serverId,
              definitionDigest: accountDefinition.definitionDigest,
            },
            "shared"
          );
          try {
            await this.deps.accountAuthority.resolve(context);
          } catch (error) {
            if (!(error instanceof McpAccountAccessError) || error.code !== "account_expired")
              throw error;
            await this.deps.accountAuthority.resolveForRefresh(context);
          }
          accounts.push(context);
        } catch (error) {
          if (!(error instanceof McpAccountAccessError)) throw error;
          throw new NativeChannelError(error.code);
        }
      }
      assertMcpRoutineUnchanged(bundle, await this.deps.activeBundle(), input.routineId);
      return {
        definitionRef: `published:routine:${definition.metadata.slug}`,
        principal: { kind: "user", id: definition.spec.owner },
        configurationDigest: canonicalHash({
          material,
          accounts,
          destination: {
            provider: input.provider,
            integrationId: input.integrationId,
            destination: input.destination,
            eventType: input.eventType,
          },
        }),
      };
    } catch (error) {
      if (error instanceof McpIntegrationError)
        throw new NativeChannelError("native_routine_approval_changed");
      throw error;
    }
  };

  private async assertNativeRunAuthority(run: PersistedRun): Promise<void> {
    const event = await this.deps.nativeRoutes.findByRun(this.deps.businessId, run.id);
    if (
      !event ||
      event.status === "denied" ||
      event.integrationId !== run.identity.initiator.id ||
      event.binding.routineRoute === undefined
    )
      throw new McpAccountAccessError("routine_approval_required");
    const pinnedDigest = canonicalHash(event.binding.routineRoute);
    const route = (
      await this.deps.nativeRoutes.routineRoutes(this.deps.businessId, event.provider)
    ).find(
      (candidate) =>
        candidate.enabled &&
        candidate.authority !== null &&
        candidate.routineId === run.bundle.routineId &&
        candidate.integrationId === event.integrationId &&
        canonicalHash(candidate) === pinnedDigest
    );
    if (!route) throw new McpAccountAccessError("routine_approval_required");
    try {
      if (
        canonicalHash(await this.nativeRoutineAuthority(route)) !== canonicalHash(route.authority)
      )
        throw new McpAccountAccessError("routine_approval_required");
    } catch (error) {
      if (error instanceof NativeChannelError)
        throw new McpAccountAccessError("routine_approval_required");
      throw error;
    }
  }

  private async assertConversation(principalId: string, conversationId: string) {
    const conversation = await this.deps.conversations.findById(conversationId);
    if (conversation?.userId !== principalId)
      throw new McpAccountAccessError("account_access_denied");
  }

  private async originalRun(run: PersistedRun): Promise<PersistedRun> {
    const seen = new Set<string>();
    let current = run;
    while (seen.size < 64 && !seen.has(current.id)) {
      seen.add(current.id);
      const parents = (await this.deps.runs.listLineage(this.deps.businessId, current.id)).filter(
        (edge) => edge.relation === "child" && edge.targetRunId === current.id
      );
      if (parents.length === 0) return current;
      if (parents.length !== 1) break;
      const parent = await this.deps.runs.find(this.deps.businessId, parents[0].sourceRunId);
      if (!parent || !["running", "waiting"].includes(parent.status)) break;
      current = parent;
    }
    throw new McpAccountAccessError("account_access_denied");
  }
}

/** Material approval input includes referenced Agent instructions and Tool contracts, not only a Routine id. */
export function mcpRoutineMaterial(bundle: RuntimeBundle, routineId: string) {
  const root = bundle.getById(routineId);
  if (root?.kind !== "Routine") {
    throw new McpIntegrationError("forbidden", "The published Routine is unavailable.");
  }
  const pending = [root];
  const included = new Map<string, typeof root>();
  while (pending.length > 0) {
    const definition = pending.pop();
    if (!definition || included.has(definition.id)) continue;
    included.set(definition.id, definition);
    for (const reference of definition.references) {
      const dependency = bundle.getById(reference.id);
      if (!dependency) {
        throw new McpIntegrationError(
          "forbidden",
          "A published Routine dependency is unavailable."
        );
      }
      pending.push(dependency);
    }
  }
  const integrations = mcpIntegrationsFromBundle(bundle);
  const required = new Set<string>();
  for (const { kind, document } of included.values()) {
    if (kind === "ToolContract") {
      if (!validateTool(document))
        throw new McpIntegrationError("forbidden", "A published Tool contract is invalid.");
      if (document.spec.adapter.kind === "mcp") required.add(document.spec.adapter.ref);
    }
    if (kind === "Agent") {
      if (!validateAgent(document))
        throw new McpIntegrationError("forbidden", "A published Agent is invalid.");
      for (const [serverId, integration] of integrations) {
        if (
          integration.mcp?.enabled &&
          integration.mcp.reviewed.tools.some(
            (tool) =>
              document.spec.allowedTools === undefined ||
              document.spec.allowedTools.includes(mcpToolName(serverId, tool.name))
          )
        )
          required.add(serverId);
      }
    }
  }
  return {
    integrations: [...required].sort().map((id) => {
      const definition = integrations.get(id)?.mcp;
      if (!definition?.enabled)
        throw new McpIntegrationError("forbidden", "A published MCP Integration is unavailable.");
      return { id, definition };
    }),
    definitions: [...included.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, document }) => ({ id, document })),
    assets: bundle.assets
      .filter((asset) => included.has(asset.ownerDefinitionId))
      .map(({ ownerDefinitionId, path, digest }) => ({ ownerDefinitionId, path, digest }))
      .sort((a, b) =>
        `${a.ownerDefinitionId}/${a.path}`.localeCompare(`${b.ownerDefinitionId}/${b.path}`)
      ),
  };
}

export function mcpRoutineConfigurationDigest(
  bundle: RuntimeBundle,
  routineId: string,
  account: { readonly id: string; readonly revision: number },
  destination: unknown
): string {
  return canonicalHash({
    material: mcpRoutineMaterial(bundle, routineId),
    accountId: account.id,
    accountRevision: account.revision,
    destination,
  });
}

export function assertMcpRoutineUnchanged(
  pinned: RuntimeBundle,
  active: RuntimeBundle | undefined,
  routineId: string
): void {
  if (
    active === undefined ||
    active.businessId !== pinned.businessId ||
    canonicalHash(mcpRoutineMaterial(pinned, routineId)) !==
      canonicalHash(mcpRoutineMaterial(active, routineId))
  ) {
    throw new McpIntegrationError("forbidden", "The Routine changed after this Run started.");
  }
}
