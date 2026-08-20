import type { ChildAuthority, ChildLinkAncestry, ChildLinkStore } from "@tulipfarm/run-kernel";
import { ChildRunManager } from "@tulipfarm/run-kernel";
import {
  type ChildRunStarter,
  DELEGATION_DEADLINE_LIMIT_KEY,
  DelegationCoordinator,
  type StartChildRunInput,
} from "./delegate";

/** How deep a delegation chain may go before a further hop is refused. */
export const DELEGATION_MAX_DEPTH = 3;
/** How long a root delegation chain may run before every descendant's deadline has passed. */
export const DELEGATION_MAX_DURATION_MS = 10 * 60_000;
/** How long a delegating turn holds its Tool call open waiting for the helper's answer. */
export const DELEGATION_WAIT_MS = 60_000;
const DELEGATION_POLL_MS = 500;

export interface DelegationOutcome {
  readonly agentId: string;
  readonly childRunId: string;
  readonly conversationId: string;
  readonly depth: number;
  readonly deadlineAt: string;
  readonly status: "succeeded" | "failed" | "running";
  readonly result: string | null;
}

export interface DelegateToAgentInput {
  readonly parentRunId: string;
  readonly parentAgentId?: string;
  readonly parentToolAllowlist?: readonly string[];
  readonly agentId: string;
  readonly task: string;
  readonly context?: Record<string, unknown>;
}

/** The slice of the Conversation store a delegating turn needs to learn its helper's answer. */
export interface DelegationConversationReader {
  findTurnByRunId(
    businessId: string,
    runId: string
  ): Promise<{ readonly status: string } | null | undefined>;
  listMessages(
    businessId: string,
    conversationId: string
  ): Promise<readonly { role: string; content: string }[]>;
}

/** One Tool as delegation reads it: its name, whether it has effects, and what data it touches. */
export interface DelegationCatalogEntry {
  readonly name: string;
  readonly mutating?: boolean;
  readonly dataClasses?: readonly string[];
}

export interface AgentDelegationDeps {
  readonly businessId: string;
  readonly links: ChildLinkStore;
  readonly ancestry: ChildLinkAncestry;
  /** Mints the helper's Conversation and chat Run. Only the coordinator may call it. */
  readonly startChildConversation: (
    input: StartChildRunInput
  ) => Promise<{ childRunId: string; conversationId: string }>;
  readonly cancelRun: (input: {
    businessId: string;
    runId: string;
    reason: string;
  }) => Promise<unknown>;
  readonly conversations: DelegationConversationReader;
  /**
   * The live Tool catalog the delegating turn draws from. Read at delegation time so a Tool
   * registered after composition is neither invisible nor stale.
   */
  readonly catalog: () => readonly DelegationCatalogEntry[];
  /**
   * The Tool names the delegating Agent's own capability restrictions leave it holding, or
   * `undefined` when it authored none. Delegation may only narrow, so this bounds the root
   * authority a chain starts from: without it a restricted Agent could hand a helper the very
   * mutation it was itself refused (#461). Resolved per call, because the Agent is per call.
   */
  readonly parentToolNames?: (agentId: string | undefined) => readonly string[] | undefined;
  readonly now?: () => Date;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/** The helper's answer is the last assistant Message its own Conversation received. */
async function lastAssistantMessage(
  conversations: DelegationConversationReader,
  businessId: string,
  conversationId: string
): Promise<string | null> {
  const messages = await conversations.listMessages(businessId, conversationId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.content;
  }
  return null;
}

/**
 * Binds a live Tool registry as delegation's catalog source. Deferred because both Tool hosts
 * compose the registry and the delegation guard in the same statement.
 */
export function delegationCatalogOf(registry: {
  getAll(): readonly Parameters<typeof delegationCatalogFrom>[0][number][];
}): () => readonly DelegationCatalogEntry[] {
  return () => delegationCatalogFrom(registry.getAll());
}

/** Reduces a live Tool registry to what delegation reads. Structural: `ToolDef` satisfies it. */
export function delegationCatalogFrom(
  tools: readonly {
    readonly name: string;
    readonly mutating?: boolean;
    readonly definition?: { readonly authorization?: { readonly dataClasses?: readonly string[] } };
  }[]
): readonly DelegationCatalogEntry[] {
  return tools.map((tool) => ({
    name: tool.name,
    mutating: tool.mutating === true,
    dataClasses: tool.definition?.authorization?.dataClasses ?? [],
  }));
}

/**
 * The authority a chain starts from when the delegating Run holds no link row of its own.
 *
 * Seeding it from the live catalog is what makes the grant describe authority that exists: an
 * empty Tool seed would narrow every helper to nothing, and `read_only` would have nothing to
 * filter. It cannot manufacture authority either — the child's own Agent allowlist and the Tool
 * gate still bound every call it makes, and this only ever intersects with them.
 */
export function rootDelegationAuthority(
  catalog: readonly DelegationCatalogEntry[],
  deadlineEpochMs: number
): ChildAuthority {
  return {
    tools: catalog.map((tool) => tool.name),
    classifications: [...new Set(catalog.flatMap((tool) => tool.dataClasses ?? []))],
    limits: { [DELEGATION_DEADLINE_LIMIT_KEY]: deadlineEpochMs },
  };
}

/**
 * Composes the only production path that starts a delegated child Run. The coordinator owns the
 * starter, so depth, deadline, and authority narrowing are not optional for a future caller.
 */
export function createAgentDelegation(deps: AgentDelegationDeps): {
  delegate(input: DelegateToAgentInput): Promise<DelegationOutcome>;
} {
  const now = deps.now ?? (() => new Date());
  const isReadOnlyTool = (name: string): boolean =>
    deps.catalog().some((tool) => tool.name === name && tool.mutating !== true);
  const starter: ChildRunStarter = {
    start: deps.startChildConversation,
    cancel: async (businessId, childRunId, reason) => {
      await deps.cancelRun({ businessId, runId: childRunId, reason });
    },
  };
  const coordinator = new DelegationCoordinator({
    children: new ChildRunManager(deps.links, deps.ancestry),
    tools: { isReadOnly: isReadOnlyTool },
    starter,
    policy: { maxDepth: DELEGATION_MAX_DEPTH },
  });
  const waitMs = deps.waitMs ?? DELEGATION_WAIT_MS;
  const pollMs = deps.pollMs ?? DELEGATION_POLL_MS;
  const businessId = deps.businessId;

  return {
    delegate: async (input) => {
      const startedAt = now();
      const parentToolAllowlist =
        input.parentToolAllowlist ?? deps.parentToolNames?.(input.parentAgentId);
      const helper = await coordinator.delegate({
        businessId,
        parentRunId: input.parentRunId,
        agentId: input.agentId,
        task: input.task,
        ...(input.context === undefined ? {} : { context: input.context }),
        // Only consulted when the parent Run is unlinked, i.e. it is itself the root of the chain.
        rootAuthority: rootDelegationAuthority(
          parentToolAllowlist === undefined
            ? deps.catalog()
            : deps.catalog().filter((tool) => parentToolAllowlist.includes(tool.name)),
          startedAt.getTime() + DELEGATION_MAX_DURATION_MS
        ),
        requested: { mode: "read_only" },
        now: startedAt.toISOString(),
      });

      const settleBy = Math.min(startedAt.getTime() + waitMs, Date.parse(helper.deadlineAt));
      let status: DelegationOutcome["status"] = "running";
      while (now().getTime() < settleBy) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        const turn = await deps.conversations.findTurnByRunId(businessId, helper.childRunId);
        if (turn?.status === "succeeded" || turn?.status === "failed") {
          status = turn.status;
          break;
        }
        if (turn?.status === "start_failed") {
          status = "failed";
          break;
        }
      }

      return {
        agentId: input.agentId,
        childRunId: helper.childRunId,
        conversationId: helper.conversationId,
        depth: helper.depth,
        deadlineAt: helper.deadlineAt,
        status,
        result:
          status === "succeeded"
            ? await lastAssistantMessage(deps.conversations, businessId, helper.conversationId)
            : null,
      };
    },
  };
}
