import { agentIdOf } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { SlackHomeProjectionService } from "./slack-home-projection";

function conversation(id: string, title: string) {
  return {
    _id: id,
    userId: "user-1",
    title,
    starred: false,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-07T00:00:00.000Z"),
  };
}

describe("SlackHomeProjectionService", () => {
  it("uses principal-scoped seams and bounds every personalized section", async () => {
    const conversations = Array.from({ length: 7 }, (_, index) =>
      conversation(`conversation-${index}`, `Chat ${index}`)
    );
    const service = new SlackHomeProjectionService({
      webOrigin: "https://tulipfarm.example",
      toolApprovals: {
        listPendingFor: vi.fn().mockResolvedValue([
          {
            approvalId: "approval-1",
            toolCallId: "call-1",
            toolName: "send_email",
            args: {},
            expiresAt: "2026-09-08T00:00:00.000Z",
            createdAt: "2026-09-07T00:00:00.000Z",
          },
        ]),
      },
      routineApprovals: {
        listPendingFor: vi.fn().mockResolvedValue([
          {
            id: "approval-2",
            kind: "routine_state",
            status: "pending",
            payload: { routineSlug: "daily-review", stateName: "Approve report" },
            createdAt: new Date("2026-09-07T00:00:00.000Z"),
            expiresAt: new Date("2026-09-08T00:00:00.000Z"),
          },
        ]),
      },
      tasks: {
        listForPrincipal: vi.fn().mockResolvedValue(
          Array.from({ length: 6 }, (_, index) => ({
            id: `task-${index}`,
            businessId: "business-1",
            assigneeKind: "user",
            assigneeId: "user-1",
            dedupeKey: `task-${index}`,
            title: `Task ${index}`,
            action: { kind: "ack" },
            blocking: false,
            priority: 0,
            status: "open",
            createdAt: new Date(),
            updatedAt: new Date(),
          }))
        ),
      },
      conversations: { list: vi.fn().mockResolvedValue(conversations) },
      conversationTurns: {
        findLatestTurn: vi.fn(async (_businessId, conversationId) => ({
          id: `turn-${conversationId}`,
          runId: `run-${conversationId}`,
          status: conversationId.endsWith("0") ? ("running" as const) : ("succeeded" as const),
        })),
      },
      agents: {
        list: () =>
          Array.from({ length: 7 }, (_, index) => ({
            name: `agent-${index}`,
            id: agentIdOf(`agent-${index}`, {}),
            frontmatter: { label: `Agent ${index}` },
            body: "",
          })),
        mayInvoke: vi.fn(async (_agent, principal) => principal.id === "user-1"),
      },
    });

    const result = await service.load({
      businessId: "business-1",
      principalId: "user-1",
      principalRef: "user:user-1",
      roles: ["member"],
    });

    expect(result.askUrl).toBe("https://tulipfarm.example/chats");
    expect(result.needsYou).toEqual([
      "Approval: send_email",
      "Approval: daily-review — Approve report",
      "Task: Task 0",
      "Task: Task 1",
      "Task: Task 2",
    ]);
    expect(result.runningNow).toEqual([
      "<https://tulipfarm.example/runs/run-conversation-0|Chat 0>",
    ]);
    expect(result.agents).toEqual([
      "<https://tulipfarm.example/agents/agent-0|Agent 0>",
      "<https://tulipfarm.example/agents/agent-1|Agent 1>",
      "<https://tulipfarm.example/agents/agent-2|Agent 2>",
      "<https://tulipfarm.example/agents/agent-3|Agent 3>",
      "<https://tulipfarm.example/agents/agent-4|Agent 4>",
    ]);
    expect(result.recentWork).toEqual([
      "<https://tulipfarm.example/chat/conversation-1|Chat 1>",
      "<https://tulipfarm.example/chat/conversation-2|Chat 2>",
      "<https://tulipfarm.example/chat/conversation-3|Chat 3>",
      "<https://tulipfarm.example/chat/conversation-4|Chat 4>",
      "<https://tulipfarm.example/chat/conversation-5|Chat 5>",
    ]);
  });

  it("returns explicit empty sections when optional safe read seams are unavailable", async () => {
    const service = new SlackHomeProjectionService({
      webOrigin: "https://tulipfarm.example",
      conversations: { list: async () => [] },
      conversationTurns: { findLatestTurn: async () => undefined },
      agents: { list: () => [], mayInvoke: async () => false },
    });

    await expect(
      service.load({
        businessId: "business-1",
        principalId: "user-1",
        principalRef: "user:user-1",
        roles: ["member"],
      })
    ).resolves.toEqual({
      askUrl: "https://tulipfarm.example/chats",
      needsYou: [],
      runningNow: [],
      agents: [],
      recentWork: [],
    });
  });
});
