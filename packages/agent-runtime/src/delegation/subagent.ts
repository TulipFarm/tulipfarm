import type {
  ChildLink,
  ChildLinkAncestry,
  ChildLinkStore,
  RegisteredWait,
  RegisterWaitInput,
} from "@tulipfarm/run-kernel";
import { CHILD_COMPLETION_SCHEMA_REF, ChildRunManager } from "@tulipfarm/run-kernel";
import {
  DELEGATION_MAX_DEPTH,
  DELEGATION_MAX_DURATION_MS,
  type DelegationCatalogEntry,
  type DelegationWaitPort,
  rootDelegationAuthority,
} from "./composition";
import {
  type ChildRunStarter,
  DELEGATION_DEADLINE_LIMIT_KEY,
  DelegationCoordinator,
  type StartChildRunInput,
} from "./delegate";

/** The persona a caller invents for one helper. Never resolved against the Soul. */
export interface SubagentPersona {
  readonly name: string;
  readonly instructions: string;
}

export interface SpawnSubagentInput {
  readonly parentRunId: string;
  /** The Run State the spawning call runs in; the parent's resume wait is registered on it. */
  readonly parentStateKey: string;
  /** The spawning Tool call. Stable across a replay, which is what makes the spawn idempotent. */
  readonly callId: string;
  readonly parentAgentId?: string;
  readonly persona: SubagentPersona;
  readonly task: string;
  readonly context?: Record<string, unknown>;
  /**
   * The Tools the helper is asked to hold, narrowed against the parent's own authority. Naming a
   * Tool the parent does not hold refuses the spawn. Omitted or empty grants none.
   */
  readonly toolNames?: readonly string[];
}

export interface SpawnSubagentOutcome {
  readonly personaName: string;
  readonly childRunId: string;
  readonly depth: number;
  readonly deadlineAt: string;
  /** `awaiting` means the helper is still running and the caller must park on `waitId`. */
  readonly status: "succeeded" | "failed" | "awaiting";
  readonly answer: string | null;
  readonly waitId: string | null;
}

/** Mints a Conversation-less sub-agent Run. Only the coordinator may call it. */
export type StartSubagentRun = (
  input: StartChildRunInput & {
    readonly persona: SubagentPersona;
    readonly callId: string;
    /**
     * The Agent that spawned this helper. The helper binds by that Agent's own capability
     * restrictions and autonomy ceiling, so a scoped or supervised Agent cannot obtain a wider
     * one by spawning a persona the Soul never authored.
     */
    readonly parentAgentId?: string;
  }
) => Promise<{ readonly childRunId: string }>;

/** Reads a finished sub-agent's answer out of the Artifact it published. */
export interface SubagentAnswerReader {
  /** `null` while the Run is unfinished; `status` is what the Run itself reached. */
  read(
    businessId: string,
    childRunId: string
  ): Promise<{ readonly status: "succeeded" | "failed" | null; readonly answer: string | null }>;
}

export interface SubagentSpawningDeps {
  readonly businessId: string;
  readonly links: ChildLinkStore;
  readonly ancestry: ChildLinkAncestry;
  readonly startSubagentRun: StartSubagentRun;
  readonly cancelRun: (input: {
    businessId: string;
    runId: string;
    reason: string;
  }) => Promise<unknown>;
  readonly answers: SubagentAnswerReader;
  readonly catalog: () => readonly DelegationCatalogEntry[];
  /** The Tool names the spawning Agent's own capability restrictions leave it holding. */
  readonly parentToolNames?: (agentId: string | undefined) => readonly string[] | undefined;
  readonly waits: DelegationWaitPort;
  readonly newWaitId: () => string;
  readonly now?: () => Date;
}

/**
 * Composes the only production path that spawns an ad-hoc sub-agent Run.
 *
 * Sits beside `createAgentDelegation` and shares its coordinator, so an invented helper is bound
 * by the same depth ceiling, the same deadline that may only narrow, and the same read-only
 * default as a Soul-defined one. The differences are confined to the two things a Conversation-less
 * helper genuinely does differently: how it is minted, and where its answer is read from.
 *
 * The persona is *not* authority. It decides what the helper is told to do; the child link decides
 * what it may do. Keeping those apart is what stops a model from widening its own reach by writing
 * itself a more permissive set of instructions.
 */
export function createSubagentSpawning(deps: SubagentSpawningDeps): {
  spawn(input: SpawnSubagentInput): Promise<SpawnSubagentOutcome>;
} {
  const now = deps.now ?? (() => new Date());
  const isReadOnlyTool = (name: string): boolean =>
    deps.catalog().some((tool) => tool.name === name && tool.mutating !== true);
  const children = new ChildRunManager(deps.links, deps.ancestry);
  const businessId = deps.businessId;

  return {
    spawn: async (input) => {
      const startedAt = now();

      // A parked Tool call is re-dispatched when the Run resumes, so the first thing to ask is
      // whether this call already has a helper. Spawning a second one would double the work and
      // park on a child nothing is waiting for.
      const existing = await deps.ancestry.callLink?.(businessId, input.parentRunId, input.callId);
      if (existing) return adopt(existing, input.persona.name);

      const parentToolAllowlist = deps.parentToolNames?.(input.parentAgentId);
      const starter: ChildRunStarter = {
        start: async (start) =>
          deps.startSubagentRun({
            ...start,
            persona: input.persona,
            callId: input.callId,
            ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
          }),
        cancel: async (business, childRunId, reason) => {
          await deps.cancelRun({ businessId: business, runId: childRunId, reason });
        },
      };
      const coordinator = new DelegationCoordinator({
        children,
        tools: { isReadOnly: isReadOnlyTool },
        starter,
        policy: { maxDepth: DELEGATION_MAX_DEPTH },
      });

      const helper = await coordinator.delegate({
        businessId,
        parentRunId: input.parentRunId,
        // The coordinator records who the helper is; for an ad-hoc one that is the persona name,
        // which names no Soul Agent and therefore grants nothing on its own.
        agentId: input.persona.name,
        task: input.task,
        callId: input.callId,
        ...(input.context === undefined ? {} : { context: input.context }),
        rootAuthority: rootDelegationAuthority(
          parentToolAllowlist === undefined
            ? deps.catalog()
            : deps.catalog().filter((tool) => parentToolAllowlist.includes(tool.name)),
          startedAt.getTime() + DELEGATION_MAX_DURATION_MS
        ),
        // `tools` is always sent explicitly, including as an empty list. Omitting it makes
        // `narrowChildAuthority` inherit the parent's whole read-only set, which would hand a
        // helper whose caller named no Tools the run of every record in the business. It also
        // disagrees with `SubagentTurnContextResolver`, which offers a Tool-less request no Tools
        // at all — and two layers disagreeing about a default is how the safer one gets "fixed"
        // to match the wider one later. Naming a Tool the parent does not hold refuses the spawn
        // rather than dropping it, so a caller never gets a quieter helper than it asked for.
        requested: { mode: "read_only", tools: [...(input.toolNames ?? [])] },
        resumeFor: async (childRunId) => {
          const registered = await deps.waits.register({
            id: deps.newWaitId(),
            businessId,
            runId: input.parentRunId,
            stateKey: input.parentStateKey,
            kind: "child_run",
            aggregation: "first",
            schemaRef: CHILD_COMPLETION_SCHEMA_REF,
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

      // The child is claimable from the moment it is minted, so it can finish before its link —
      // and therefore its resume grant — is durable. Re-reading closes that window.
      const settled = await deps.answers.read(businessId, helper.childRunId);
      if (settled.status !== null) {
        return {
          personaName: input.persona.name,
          childRunId: helper.childRunId,
          depth: helper.depth,
          deadlineAt: helper.deadlineAt,
          status: settled.status,
          answer: settled.answer,
          waitId: null,
        };
      }

      return {
        personaName: input.persona.name,
        childRunId: helper.childRunId,
        depth: helper.depth,
        deadlineAt: helper.deadlineAt,
        status: "awaiting",
        answer: null,
        waitId: helper.link.resume?.waitId ?? null,
      };
    },
  };

  /**
   * Answers a replayed call from the helper it already spawned.
   *
   * Depth and deadline are re-derived from the persisted chain rather than remembered, because the
   * replay is a different process from the one that spawned the child and the link row is the only
   * thing both of them can agree on.
   */
  async function adopt(link: ChildLink, personaName: string): Promise<SpawnSubagentOutcome> {
    const childRunId = link.childRunId;
    const settled = await deps.answers.read(businessId, childRunId);
    const chain = await children.ancestors(businessId, childRunId, DELEGATION_MAX_DEPTH + 1);
    const deadlineMs = link.authority.limits[DELEGATION_DEADLINE_LIMIT_KEY];
    return {
      personaName,
      childRunId,
      depth: chain.length,
      deadlineAt: deadlineMs === undefined ? "" : new Date(deadlineMs).toISOString(),
      status: settled.status ?? "awaiting",
      answer: settled.answer,
      waitId: settled.status === null ? (link.resume?.waitId ?? null) : null,
    };
  }
}
