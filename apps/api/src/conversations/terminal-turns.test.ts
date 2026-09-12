import type { PersistedRun, PersistedRunEvent } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { PersistedTurn, TerminalTurnStore } from "./service";
import { TerminalTurnSettler } from "./terminal-turns";

const TURN: PersistedTurn = {
  id: "turn-1",
  businessId: "business-1",
  conversationId: "conversation-1",
  idempotencyKey: "key-1",
  requestMessageId: "message-1",
  status: "running",
  attempt: 2,
  runId: "run-2",
  cursor: 0,
  supersededRunIds: ["run-1"],
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:01.000Z"),
};

function run(status: PersistedRun["status"], id = "run-2"): PersistedRun {
  return {
    id,
    businessId: "business-1",
    source: "chat",
    bundle: { digest: "sha256:bundle", routineId: "chat", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "user", id: "user-1" },
      guardrailContextRef: "sha256:guardrail",
    },
    status,
    version: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
    resultArtifactId: null,
    errorEvidenceRef: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseGeneration: 1,
  };
}

function harness(
  status: PersistedRun["status"],
  foundTurn: PersistedTurn | null = TURN,
  runEvents: readonly PersistedRunEvent[] = []
) {
  const resolvedTurn = foundTurn ?? undefined;
  const appendAssistantMessage = vi.fn<TerminalTurnStore["appendAssistantMessage"]>(
    async ({ message }) => ({
      status: "recorded" as const,
      messageId: message.id,
    })
  );
  const settleTerminalTurn = vi.fn<TerminalTurnStore["settleTerminalTurn"]>(async () => ({
    completionInserted: true,
    status: "recorded",
  }));
  const turns = {
    appendAssistantMessage,
    findAttemptMessage: vi.fn(async () => undefined),
    findTurnByRunId: vi.fn(async () => resolvedTurn),
    findLatestTurn: vi.fn(async () => resolvedTurn),
    findTurn: vi.fn(async () => resolvedTurn),
    settleTerminalTurn,
  } satisfies TerminalTurnStore;
  const settler = new TerminalTurnSettler({
    turns,
    runs: { find: async () => run(status) },
    events: {
      latestSequence: async () => 12,
      list: async (_businessId, _runId, options) =>
        runEvents.filter(
          (event) => event.sequence > options.after && event.audience === "participant"
        ),
    },
    now: () => new Date("2026-01-01T00:00:03.000Z"),
  });
  return { settler, appendAssistantMessage, settleTerminalTurn };
}

describe("TerminalTurnSettler", () => {
  it("settles a cancelled Run from durable state with the current attempt fence", async () => {
    const { settler, settleTerminalTurn } = harness("cancelled");

    await expect(settler.reconcileRun("business-1", "run-2")).resolves.toBe(true);
    expect(settleTerminalTurn).toHaveBeenCalledWith({
      businessId: "business-1",
      turnId: "turn-1",
      runId: "run-2",
      attempt: 2,
      status: "failed",
      cursor: 12,
      reason: "run_cancelled",
      createdAt: new Date("2026-01-01T00:00:03.000Z"),
      historyOutcome: "cancelled",
    });
  });

  it("does not let an old terminal Run reach a newer retry", async () => {
    const { settler, settleTerminalTurn } = harness("failed", null);

    await expect(settler.reconcileRun("business-1", "run-1")).resolves.toBe(false);
    expect(settleTerminalTurn).not.toHaveBeenCalled();
  });

  it("settles a terminal Run found while reopening a Conversation", async () => {
    const { settler, settleTerminalTurn } = harness("failed");

    await settler.reconcileConversation("business-1", "conversation-1");

    expect(settleTerminalTurn).toHaveBeenCalledOnce();
  });

  it("recovers participant-safe history before settling an exhausted Run", async () => {
    const events: PersistedRunEvent[] = [
      {
        businessId: "business-1",
        runId: "run-2",
        sequence: 1,
        eventType: "text.delta",
        audience: "participant",
        payload: { text: "Safe answer", index: 0 },
        occurredAt: "2026-01-01T00:00:01.000Z",
      },
      {
        businessId: "business-1",
        runId: "run-2",
        sequence: 2,
        eventType: "tool.call",
        audience: "participant",
        payload: {
          callId: "call-1",
          name: "records_list",
          argsDigest: "sha256:safe",
          argsPreview: { json: '{"query":"[redacted]"}' },
        },
        occurredAt: "2026-01-01T00:00:01.100Z",
      },
      {
        businessId: "business-1",
        runId: "run-2",
        sequence: 3,
        eventType: "model.request",
        audience: "operator",
        payload: { rawPrompt: "never persist this" },
        occurredAt: "2026-01-01T00:00:01.200Z",
      },
    ];
    const { settler, appendAssistantMessage } = harness("failed", TURN, events);

    await settler.reconcileRun("business-1", "run-2");

    expect(appendAssistantMessage).toHaveBeenCalledOnce();
    const saved = appendAssistantMessage.mock.calls[0]?.[0].message;
    expect(saved?.content).toEqual([{ type: "text", text: "Safe answer" }]);
    expect(saved?.metadata).toMatchObject({
      toolCalls: [
        {
          callId: "call-1",
          name: "records_list",
          argsDigest: "sha256:safe",
          argsPreview: { json: '{"query":"[redacted]"}' },
        },
      ],
      turnAttempt: {
        runId: "run-2",
        attempt: 2,
        cursor: 12,
        outcome: "failed",
        complete: true,
      },
    });
    expect(JSON.stringify(saved)).not.toContain("never persist this");
  });
});
