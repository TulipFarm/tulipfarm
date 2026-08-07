import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { RetrievalRequest, RetrievalResult } from "@tulipfarm/knowledge";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../tools/types";
import { buildSearchSlackConversationsTool } from "./tools";

const { retrieve } = vi.hoisted(() => ({
  retrieve: vi.fn<(deps: unknown, request: RetrievalRequest) => Promise<RetrievalResult>>(),
}));

vi.mock("@tulipfarm/knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tulipfarm/knowledge")>();
  return { ...actual, retrieve };
});

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return { userId: "user-1", ...overrides };
}

function result(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return { candidates: [], exclusions: [], cacheKey: "key-1", fromCache: false, ...overrides };
}

describe("buildSearchSlackConversationsTool", () => {
  const tool = buildSearchSlackConversationsTool({
    sources: { list: vi.fn(), get: vi.fn() },
    index: { search: vi.fn() },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  beforeEach(() => {
    retrieve.mockReset();
  });

  it("rejects a missing query with validation_error", async () => {
    const outcome = await tool.execute({}, ctx());
    expect(outcome).toEqual({
      success: false,
      error: { code: "validation_error", message: expect.any(String) },
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("rejects a blank query with validation_error", async () => {
    const outcome = await tool.execute({ query: "" }, ctx());
    expect(outcome.success).toBe(false);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("derives businessId/principals/epochs from RequestContext and calls retrieve", async () => {
    retrieve.mockResolvedValue(result());

    await tool.execute(
      { query: "deploy status", limit: 5 },
      ctx({
        guardrailRevision: "gr-3",
        runId: "run-1",
        conversationId: "conv-1",
        agentId: "agent-1",
      })
    );

    expect(retrieve).toHaveBeenCalledTimes(1);
    const [, request] = retrieve.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: "user-1",
      principals: [{ kind: "user", id: "user-1" }],
      query: "deploy status",
      limit: 5,
      guardrailEpoch: "gr-3",
      contextEpoch: "run-1",
      agentId: "agent-1",
      runId: "run-1",
    });
  });

  it("falls back to conversationId for contextEpoch and 'none' when neither is set", async () => {
    retrieve.mockResolvedValue(result());

    await tool.execute({ query: "x" }, ctx({ conversationId: "conv-1" }));
    let [, request] = retrieve.mock.calls[0] ?? [];
    expect(request?.contextEpoch).toBe("conv-1");
    expect(request?.guardrailEpoch).toBe("none");

    retrieve.mockClear();
    await tool.execute({ query: "x" }, ctx());
    [, request] = retrieve.mock.calls[0] ?? [];
    expect(request?.contextEpoch).toBe("none");
  });

  it("clamps limit into [1, 50] and defaults to 10", async () => {
    retrieve.mockResolvedValue(result());

    await tool.execute({ query: "x" }, ctx());
    expect(retrieve.mock.calls[0]?.[1]?.limit).toBe(10);

    retrieve.mockClear();
    await tool.execute({ query: "x", limit: 500 }, ctx());
    expect(retrieve.mock.calls[0]?.[1]?.limit).toBe(50);

    retrieve.mockClear();
    await tool.execute({ query: "x", limit: 0 }, ctx());
    expect(retrieve.mock.calls[0]?.[1]?.limit).toBe(1);
  });

  it("maps candidates to plain-text results and sums excluded counts", async () => {
    retrieve.mockResolvedValue(
      result({
        candidates: [
          {
            sourceId: "slack:T1:C1",
            chunkId: "slack:T1:C1#1.0",
            revision: "1.0",
            score: 0.9,
            classification: ["internal"],
            digest: "d1",
            snippet: "hello there",
            citation: { sourceId: "slack:T1:C1", revision: "1.0", aclRevision: "1.0" },
          },
        ],
        exclusions: [
          { reason: "principal_not_permitted", count: 2 },
          { reason: "live_check_unavailable", count: 3 },
        ],
      })
    );

    const outcome = await tool.execute({ query: "x" }, ctx());

    expect(outcome).toEqual({
      success: true,
      data: {
        results: [
          {
            sourceId: "slack:T1:C1",
            chunkId: "slack:T1:C1#1.0",
            text: "hello there",
            score: 0.9,
            classification: ["internal"],
          },
        ],
        excludedCount: 5,
      },
    });
  });

  it("returns internal_error rather than throwing when retrieve rejects", async () => {
    retrieve.mockRejectedValue(new Error("index unavailable"));

    const outcome = await tool.execute({ query: "x" }, ctx());

    expect(outcome).toEqual({
      success: false,
      error: { code: "internal_error", message: "index unavailable" },
    });
  });
});
