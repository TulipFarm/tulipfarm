import type {
  ChildAuthority,
  ChildLink,
  ChildLinkAncestry,
  ChildLinkStore,
  RegisteredWait,
  RegisterWaitInput,
} from "@tulipfarm/run-kernel";
import { CHILD_COMPLETION_SCHEMA_REF, ChildRunManager } from "@tulipfarm/run-kernel";
import { contentText, type MessageContent } from "@tulipfarm/schema";
import {
  type ChildRunStarter,
  DELEGATION_DEADLINE_LIMIT_KEY,
  DelegationCoordinator,
  DelegationError,
  type StartChildRunInput,
} from "./delegate";

/** How deep a delegation chain may go before a further hop is refused. */
export const DELEGATION_MAX_DEPTH = 3;
/** How long a root delegation chain may run before every descendant's deadline has passed. */
export const DELEGATION_MAX_DURATION_MS = 10 * 60_000;
export interface DelegationOutcome {
  readonly agentId: string;
  readonly childRunId: string;
  readonly conversationId: string;
  readonly depth: number;
  readonly deadlineAt: string;
  /**
   * `awaiting` means the helper is still running and the caller must park on `waitId`. It is not
   * a failure and carries no answer — the previous `running` said the same thing but arrived only
   * after a fixed 60s of polling, which silently truncated every helper slower than that.
   */
  readonly status: "succeeded" | "failed" | "awaiting";
  readonly result: string | null;
  /** Present only for `awaiting`: the durable wait the child's completion will signal. */
  readonly waitId: string | null;
}

export interface DelegateToAgentInput {
  readonly parentRunId: string;
  /** The Run State the delegating call runs in; the parent's resume wait is registered on it. */
  readonly parentStateKey: string;
  /** The delegating Tool call. Stable across a replay, which is what makes the spawn idempotent. */
  readonly callId: string;
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
  ): Promise<{ readonly status: string; readonly conversationId: string } | null | undefined>;
  listMessages(
    businessId: string,
    conversationId: string
  ): Promise<readonly { role: string; content: MessageContent }[]>;
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
  /**
   * The durable wait the parent parks on. Registered between minting the child Run and writing
   * its link, so the grant the child's completion reads back exists before the child can finish.
   */
  readonly waits: DelegationWaitPort;
  readonly newWaitId: () => string;
  readonly now?: () => Date;
}

/** The slice of `DurableWaitManager` delegation needs. */
export interface DelegationWaitPort {
  register(input: RegisterWaitInput): Promise<RegisteredWait>;
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
    if (message?.role === "assistant") return contentText(message.content);
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
  const children = new ChildRunManager(deps.links, deps.ancestry);
  const coordinator = new DelegationCoordinator({
    children,
    tools: { isReadOnly: isReadOnlyTool },
    starter,
    policy: { maxDepth: DELEGATION_MAX_DEPTH },
  });
  const businessId = deps.businessId;

  return {
    delegate: async (input) => {
      const startedAt = now();

      // A parked Tool call is re-dispatched when the Run resumes, so the first thing to ask is
      // whether this call already has a helper. Spawning a second one would double the work and
      // park on a child nothing is waiting for.
      const existing = await deps.ancestry.callLink?.(businessId, input.parentRunId, input.callId);
      if (existing) return adopt(existing, input.agentId);

      const parentToolAllowlist =
        input.parentToolAllowlist ?? deps.parentToolNames?.(input.parentAgentId);
      const helper = await coordinator.delegate({
        businessId,
        parentRunId: input.parentRunId,
        agentId: input.agentId,
        task: input.task,
        callId: input.callId,
        ...(input.context === undefined ? {} : { context: input.context }),
        // Only consulted when the parent Run is unlinked, i.e. it is itself the root of the chain.
        rootAuthority: rootDelegationAuthority(
          parentToolAllowlist === undefined
            ? deps.catalog()
            : deps.catalog().filter((tool) => parentToolAllowlist.includes(tool.name)),
          startedAt.getTime() + DELEGATION_MAX_DURATION_MS
        ),
        requested: { mode: "read_only" },
        resumeFor: async (childRunId) => {
          const registered = await deps.waits.register({
            id: deps.newWaitId(),
            businessId,
            runId: input.parentRunId,
            stateKey: input.parentStateKey,
            kind: "child_run",
            aggregation: "first",
            schemaRef: CHILD_COMPLETION_SCHEMA_REF,
            // Only the child this grant was minted for may report its own completion.
            allowedPrincipals: [`run:${childRunId}`],
            expectedSignals: 1,
            quorum: null,
            deadlineAt: new Date(startedAt.getTime() + DELEGATION_MAX_DURATION_MS).toISOString(),
            createdAt: startedAt.toISOString(),
          });
          return { waitId: registered.wait.id, token: registered.token };
        },
        now: startedAt.toISOString(),
      });

      const waitId = helper.link.resume?.waitId ?? null;

      // Every Soul-agent helper is minted with a Conversation of its own, and its answer is read
      // out of that Conversation. One without is a corrupted spawn, not a helper to park on.
      const conversationId = helper.conversationId;
      if (conversationId === undefined) {
        throw new DelegationError("child_conversation_missing", "conversationId");
      }

      // The child Run is claimable from the moment it is minted, so it can reach a terminal
      // status before its link — and therefore its resume grant — is durable. Re-reading here
      // closes that window: a helper that already finished is answered now rather than parked on
      // a signal that was raised before anything could receive it.
      const settled = await terminalStatusOf(helper.childRunId);
      if (settled !== null) {
        return {
          agentId: input.agentId,
          childRunId: helper.childRunId,
          conversationId,
          depth: helper.depth,
          deadlineAt: helper.deadlineAt,
          status: settled,
          waitId: null,
          result:
            settled === "succeeded"
              ? await lastAssistantMessage(deps.conversations, businessId, conversationId)
              : null,
        };
      }

      return {
        agentId: input.agentId,
        childRunId: helper.childRunId,
        conversationId,
        depth: helper.depth,
        deadlineAt: helper.deadlineAt,
        status: "awaiting",
        waitId,
        result: null,
      };
    },
  };

  /** A child's terminal status, or `null` while it is still running. */
  async function terminalStatusOf(childRunId: string): Promise<"succeeded" | "failed" | null> {
    const turn = await deps.conversations.findTurnByRunId(businessId, childRunId);
    if (turn?.status === "succeeded") return "succeeded";
    if (turn?.status === "failed" || turn?.status === "start_failed") return "failed";
    return null;
  }

  /**
   * Answers a replayed call from the helper it already spawned.
   *
   * Depth and deadline are re-derived from the persisted chain rather than remembered, because
   * the replay is a different process from the one that spawned the child and the link row is
   * the only thing both of them can agree on.
   */
  async function adopt(link: ChildLink, agentId: string): Promise<DelegationOutcome> {
    const childRunId = link.childRunId;
    const turn = await deps.conversations.findTurnByRunId(businessId, childRunId);
    const settled =
      turn?.status === "succeeded"
        ? "succeeded"
        : turn?.status === "failed" || turn?.status === "start_failed"
          ? "failed"
          : null;
    const chain = await children.ancestors(businessId, childRunId, DELEGATION_MAX_DEPTH + 1);
    const deadlineMs = link.authority.limits[DELEGATION_DEADLINE_LIMIT_KEY];
    return {
      agentId,
      childRunId,
      conversationId: turn?.conversationId ?? "",
      depth: chain.length,
      deadlineAt: deadlineMs === undefined ? "" : new Date(deadlineMs).toISOString(),
      status: settled ?? "awaiting",
      waitId: settled === null ? (link.resume?.waitId ?? null) : null,
      result:
        settled === "succeeded" && turn
          ? await lastAssistantMessage(deps.conversations, businessId, turn.conversationId)
          : null,
    };
  }
}
