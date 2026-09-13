import type { AssetAccessProjection } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { RoutineCatalogItem, SoulLoader } from "@tulipfarm/soul";
import type {
  PersistedChildLink,
  PersistedRun,
  PersistedState,
  RunLineage,
} from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { ConversationRepo } from "../chat/conversations";
import type { PgConversationStore } from "../conversations/store.pg";
import type { RequestPrincipal } from "../identity/principal";
import { createRunContextReader } from "./run-context";

const principal: RequestPrincipal = {
  id: "user-1",
  kind: "user",
  businessId: DEPLOYMENT_BUSINESS_ID,
  credential: "session",
  authMethods: ["password"],
  authenticatedAt: new Date(),
  role: "admin",
};

const run: PersistedRun = {
  id: "run-1",
  businessId: DEPLOYMENT_BUSINESS_ID,
  source: "chat",
  bundle: {
    digest: "published:agent:agent-1",
    routineId: "chat",
    routineVersion: "published:agent:agent-1",
  },
  identity: {
    initiator: { kind: "user", id: principal.id },
    effectiveSubject: { kind: "user", id: principal.id },
    guardrailContextRef: "guardrails",
  },
  status: "succeeded",
  version: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
  startedAt: "2026-09-01T00:00:01.000Z",
  finishedAt: "2026-09-01T00:00:02.000Z",
  resultArtifactId: "artifact-only-not-a-result",
  errorEvidenceRef: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  leaseGeneration: 1,
};

function fixture(currentRun = run) {
  const find = vi.fn(async (businessId: string, id: string) =>
    businessId === currentRun.businessId && id === currentRun.id ? currentRun : null
  );
  const findState = vi.fn(
    async (): Promise<PersistedState | null> => ({
      businessId: currentRun.businessId,
      runId: currentRun.id,
      key: "invoke",
      definitionRef: "published:agent:agent-1",
      resolvedInput: {},
      status: "succeeded",
      version: 1,
      createdAt: currentRun.createdAt,
      startedAt: currentRun.startedAt,
      finishedAt: currentRun.finishedAt,
      resultArtifactId: null,
      errorEvidenceRef: null,
      output: null,
    })
  );
  const listRelatedLineage = vi.fn(async (): Promise<readonly RunLineage[]> => []);
  const findTurnByAttemptRunId = vi.fn<PgConversationStore["findTurnByAttemptRunId"]>(async () => ({
    id: "turn-1",
    businessId: currentRun.businessId,
    conversationId: "chat-1",
    idempotencyKey: "key",
    requestMessageId: "message-1",
    status: "succeeded" as const,
    attempt: 2,
    runId: "newer-run",
    supersededRunIds: [currentRun.id],
    cursor: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const findById = vi.fn<ConversationRepo["findById"]>(async () => ({
    _id: "chat-1",
    userId: principal.id,
    agentId: "a-different-current-agent",
    title: "Customer research",
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const access = vi.fn(
    async (): Promise<AssetAccessProjection> => ({
      levels: ["view"],
      canManageOwnership: false,
      evidence: [],
    })
  );
  const listByIds = vi.fn(async (): Promise<RoutineCatalogItem[]> => []);
  const deps = {
    runs: { find, findState, listRelatedLineage },
    turns: { findTurnByAttemptRunId },
    conversations: { findById },
    ancestry: {
      parentLink: vi.fn(async (): Promise<PersistedChildLink | null> => null),
    },
    children: {
      listChildren: vi.fn(async (): Promise<readonly PersistedChildLink[]> => []),
    },
    soul: {
      agents: new Map([
        ["researcher", { id: "agent-1", name: "researcher", frontmatter: {}, body: "Research" }],
      ]),
    } as unknown as SoulLoader,
    routines: { list: vi.fn(async () => []), listByIds, get: vi.fn(async () => undefined) },
    teamAssets: { access },
    authorizationCheck: vi.fn(async () => true),
  };
  const reader = createRunContextReader(deps);
  return { reader, deps };
}

describe("Run detail context", () => {
  it("links the owned Chat and the persisted authoring Agent, not the Chat's current Agent", async () => {
    const { reader, deps } = fixture();
    await expect(reader.get(principal, run.id)).resolves.toEqual({
      sourceChat: { id: "chat-1", title: "Customer research" },
      agent: { id: "agent-1", name: "researcher" },
      relatedRuns: [],
    });
    expect(deps.turns.findTurnByAttemptRunId).toHaveBeenCalledWith(DEPLOYMENT_BUSINESS_ID, run.id);
    expect(deps.routines.listByIds).not.toHaveBeenCalled();
  });

  it("omits another user's source Chat even for an operational administrator", async () => {
    const { reader, deps } = fixture();
    deps.conversations.findById.mockResolvedValue({
      _id: "secret-chat",
      userId: "someone-else",
      agentId: "agent-1",
      title: "Private customer details",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const context = await reader.get(principal, run.id);
    expect(context).not.toHaveProperty("sourceChat");
    expect(JSON.stringify(context)).not.toContain("secret-chat");
    expect(JSON.stringify(context)).not.toContain("Private customer details");
  });

  it("does not resolve a source Chat for a service principal with the same id", async () => {
    const { reader, deps } = fixture();
    const context = await reader.get({ ...principal, kind: "service" }, run.id);
    expect(context).not.toHaveProperty("sourceChat");
    expect(deps.turns.findTurnByAttemptRunId).not.toHaveBeenCalled();
  });

  it("omits a missing Turn or deleted Chat rather than guessing a destination", async () => {
    const { reader, deps } = fixture();
    deps.conversations.findById.mockResolvedValue(null);
    expect(await reader.get(principal, run.id)).not.toHaveProperty("sourceChat");
    deps.conversations.findById.mockClear();
    deps.turns.findTurnByAttemptRunId.mockResolvedValue(undefined);
    expect(await reader.get(principal, run.id)).not.toHaveProperty("sourceChat");
    expect(deps.conversations.findById).not.toHaveBeenCalled();
  });

  it("does not read related objects for a Run in another business or an unknown Run", async () => {
    const { reader, deps } = fixture();
    await expect(
      reader.get({ ...principal, businessId: "another-business" }, run.id)
    ).resolves.toBeUndefined();
    await expect(reader.get(principal, "missing-run")).resolves.toBeUndefined();
    expect(deps.turns.findTurnByAttemptRunId).not.toHaveBeenCalled();
    expect(deps.runs.listRelatedLineage).not.toHaveBeenCalled();
  });

  it("omits missing and forbidden assets rather than linking guessed destinations", async () => {
    const { reader, deps } = fixture();
    deps.teamAssets.access.mockResolvedValue({
      levels: [],
      canManageOwnership: false,
      evidence: [],
    });
    expect(await reader.get(principal, run.id)).not.toHaveProperty("agent");
    deps.soul.agents.clear();
    expect(await reader.get(principal, run.id)).not.toHaveProperty("agent");
  });

  it("never infers links from State input, output, evidence, or the synthetic chat Routine", async () => {
    const { reader, deps } = fixture();
    deps.runs.findState.mockResolvedValue({
      definitionRef: "published:channel:slack",
      resolvedInput: {
        agentId: "agent-1",
        conversationId: "invented-chat",
        recordId: "invented-record",
        sourceRunId: "invented-parent",
      },
      output: { routineId: "invented-routine" },
    } as unknown as PersistedState);
    const context = await reader.get(principal, run.id);
    expect(context).toEqual({
      sourceChat: { id: "chat-1", title: "Customer research" },
      relatedRuns: [],
    });
    expect(deps.routines.listByIds).not.toHaveBeenCalled();
  });

  it("resolves a Routine by its canonical id and checks its destination's read access", async () => {
    const { reader, deps } = fixture({
      ...run,
      source: "routine",
      bundle: { digest: "bundle", routineId: "routine-id", routineVersion: "1" },
    });
    deps.routines.listByIds.mockResolvedValue([
      {
        id: "routine-id",
        slug: "daily-review",
        displayName: "Daily review",
        authoredVersion: 1,
        triggers: [],
        summary: {
          owner: null,
          stateCount: 1,
          stateTypes: ["compute"],
          effects: [],
          toolAbilities: [],
          maxRiskClass: null,
          requiresApproval: false,
          concurrencyPolicy: null,
          compensationPolicy: null,
        },
      },
    ]);
    expect((await reader.get(principal, run.id))?.routine).toEqual({
      id: "routine-id",
      name: "daily-review",
    });
    expect(deps.runs.findState).not.toHaveBeenCalled();
    deps.authorizationCheck.mockResolvedValue(false);
    expect(await reader.get(principal, run.id)).not.toHaveProperty("routine");
  });

  it("includes durable child links and deduplicates links also present in Run lineage", async () => {
    const { reader, deps } = fixture();
    const link = {
      parentRunId: run.id,
      childRunId: "child-run",
      authority: {
        parentRunId: run.id,
        childRunId: "child-run",
        inherited: {},
      },
      authorityBinding: "lineage",
      resume: null,
      callId: "call-1",
      detachedAt: null,
      createdAt: run.createdAt,
    } as unknown as PersistedChildLink;
    deps.children.listChildren.mockResolvedValue([link]);
    deps.ancestry.parentLink.mockResolvedValue({
      ...link,
      parentRunId: "parent-run",
      childRunId: run.id,
    });
    deps.runs.listRelatedLineage.mockResolvedValue([
      {
        businessId: run.businessId,
        sourceRunId: run.id,
        targetRunId: "child-run",
        relation: "child",
        createdAt: run.createdAt,
      },
    ]);
    deps.runs.find.mockImplementation(async (_businessId, id) => ({ ...run, id }));
    expect((await reader.get(principal, run.id))?.relatedRuns).toEqual([
      { id: "child-run", relation: "child" },
      { id: "parent-run", relation: "parent" },
    ]);
  });

  it("maps child and replay direction and omits missing or foreign related Runs", async () => {
    const { reader, deps } = fixture();
    const edge = (
      sourceRunId: string,
      targetRunId: string,
      relation: RunLineage["relation"],
      businessId = DEPLOYMENT_BUSINESS_ID
    ): RunLineage => ({
      businessId,
      sourceRunId,
      targetRunId,
      relation,
      createdAt: run.createdAt,
    });
    deps.runs.listRelatedLineage.mockResolvedValue([
      edge("parent-run", run.id, "child"),
      edge(run.id, "child-run", "child"),
      edge("original-run", run.id, "replay"),
      edge(run.id, "replayed-run", "replay"),
      edge(run.id, "missing-run", "child"),
      edge(run.id, "foreign-run", "child", "another-business"),
      edge("unrelated", "also-unrelated", "child"),
    ]);
    deps.runs.find.mockImplementation(async (businessId, id) =>
      businessId === run.businessId &&
      [run.id, "parent-run", "child-run", "original-run", "replayed-run"].includes(id)
        ? { ...run, id }
        : null
    );
    expect((await reader.get(principal, run.id))?.relatedRuns).toEqual([
      { id: "parent-run", relation: "parent" },
      { id: "child-run", relation: "child" },
      { id: "original-run", relation: "replayed_from" },
      { id: "replayed-run", relation: "replay" },
    ]);
  });
});
