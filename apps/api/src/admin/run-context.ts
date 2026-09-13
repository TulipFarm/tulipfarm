import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { INVOKE_STATE_KEY } from "@tulipfarm/run-kernel";
import { getAgent, type RoutineCatalog, type SoulLoader } from "@tulipfarm/soul";
import type {
  ChildLinkAncestryStore,
  ChildLinkStore,
  PersistedRun,
  RunStore,
} from "@tulipfarm/storage";
import type { AuthorizationCheck } from "../authz/route-gate";
import type { ConversationRepo } from "../chat/conversations";
import type { PgConversationStore } from "../conversations/store.pg";
import type { RequestPrincipal } from "../identity/principal";
import type { TeamAssetService } from "../team-assets/service";
import type { RunContextReadModel } from "./types";

export interface RunContextReader {
  get(principal: RequestPrincipal, runId: string): Promise<RunContextReadModel | undefined>;
}

interface RunContextDeps {
  runs: Pick<RunStore, "find" | "findState" | "listRelatedLineage">;
  turns: Pick<PgConversationStore, "findTurnByAttemptRunId">;
  conversations: Pick<ConversationRepo, "findById">;
  ancestry: Pick<ChildLinkAncestryStore, "parentLink">;
  children: Pick<ChildLinkStore, "listChildren">;
  soul: SoulLoader;
  routines: RoutineCatalog;
  teamAssets: Pick<TeamAssetService, "access">;
  authorizationCheck: AuthorizationCheck;
}

/** Detail-only links from persisted relationships; destinations retain their own read gates. */
export function createRunContextReader(deps: RunContextDeps): RunContextReader {
  async function sourceChat(
    principal: RequestPrincipal,
    run: PersistedRun
  ): Promise<RunContextReadModel["sourceChat"]> {
    if (principal.kind !== "user" || principal.businessId !== DEPLOYMENT_BUSINESS_ID) return;
    const turn = await deps.turns.findTurnByAttemptRunId(principal.businessId, run.id);
    if (!turn || turn.businessId !== principal.businessId) return;
    const chat = await deps.conversations.findById(turn.conversationId);
    if (!chat || chat.userId !== principal.id) return;
    return { id: chat._id, ...(chat.title ? { title: chat.title } : {}) };
  }

  async function authoringContext(
    principal: RequestPrincipal,
    run: PersistedRun
  ): Promise<Pick<RunContextReadModel, "agent" | "routine">> {
    if (principal.businessId !== DEPLOYMENT_BUSINESS_ID) return {};
    if (run.source === "routine") {
      const routines = deps.routines.listByIds
        ? await deps.routines.listByIds([run.bundle.routineId])
        : await deps.routines.list();
      const routine = routines.find((item) => item.id === run.bundle.routineId);
      if (
        routine &&
        (await deps.authorizationCheck(principal, {
          action: "routine.read",
          resourceType: "routine",
          fallback: "authenticated",
        })) &&
        (await deps.teamAssets.access("routine", routine.id, principal)).levels.includes("view")
      ) {
        return { routine: { id: routine.id, name: routine.slug } };
      }
      return {};
    }
    const state = await deps.runs.findState(principal.businessId, run.id, INVOKE_STATE_KEY);
    const prefix = "published:agent:";
    if (!state?.definitionRef.startsWith(prefix)) return {};
    const agent = getAgent(deps.soul, state.definitionRef.slice(prefix.length));
    if (
      agent &&
      (await deps.teamAssets.access("agent", agent.name, principal)).levels.includes("view")
    ) {
      return { agent: { id: agent.id, name: agent.name } };
    }
    return {};
  }

  async function relatedRuns(
    principal: RequestPrincipal,
    runId: string
  ): Promise<RunContextReadModel["relatedRuns"]> {
    const [lineage, parent, children] = await Promise.all([
      deps.runs.listRelatedLineage(principal.businessId, runId),
      deps.ancestry.parentLink(principal.businessId, runId),
      deps.children.listChildren(principal.businessId, runId),
    ]);
    const refs = new Map<string, RunContextReadModel["relatedRuns"][number]>();
    for (const link of lineage) {
      if (link.businessId !== principal.businessId) continue;
      const incoming = link.targetRunId === runId;
      if (!incoming && link.sourceRunId !== runId) continue;
      const id = incoming ? link.sourceRunId : link.targetRunId;
      const relation =
        link.relation === "replay"
          ? incoming
            ? "replayed_from"
            : "replay"
          : incoming
            ? "parent"
            : "child";
      refs.set(`${relation}:${id}`, { id, relation });
    }
    if (parent?.childRunId === runId) {
      refs.set(`parent:${parent.parentRunId}`, { id: parent.parentRunId, relation: "parent" });
    }
    for (const child of children) {
      if (child.parentRunId !== runId) continue;
      refs.set(`child:${child.childRunId}`, { id: child.childRunId, relation: "child" });
    }
    const existing = await Promise.all(
      [...refs.values()].map(async (ref) => {
        if (ref.id === runId) return;
        const related = await deps.runs.find(principal.businessId, ref.id);
        return related?.businessId === principal.businessId ? ref : undefined;
      })
    );
    return existing.filter((ref) => ref !== undefined);
  }

  return {
    async get(principal, runId) {
      const run = await deps.runs.find(principal.businessId, runId);
      if (!run || run.businessId !== principal.businessId) return;
      const [chat, authoring, related] = await Promise.all([
        sourceChat(principal, run),
        authoringContext(principal, run),
        relatedRuns(principal, runId),
      ]);
      return {
        ...(chat ? { sourceChat: chat } : {}),
        ...authoring,
        relatedRuns: related,
      };
    },
  };
}
