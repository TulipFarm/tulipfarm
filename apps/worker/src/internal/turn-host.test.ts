import { describe, expect, it } from "vitest";
import { InternalApiClient, InternalApiError } from "./client";
import { HttpTurnHost } from "./turn-host";

function host(handler: (url: string, init?: RequestInit) => Response): {
  turns: HttpTurnHost;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return handler(String(input), init);
  }) as typeof globalThis.fetch;
  return {
    turns: new HttpTurnHost(
      new InternalApiClient({ baseUrl: "http://api:4010", credential: "tfc_a.b", fetch })
    ),
    urls,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const REF = { businessId: "business-1", runId: "run-1", turnId: "turn-1", attempt: 2 };

describe("HttpTurnHost", () => {
  it("names the Turn a Run answers", async () => {
    const { turns } = host(() =>
      json({ turnId: "turn-1", conversationId: "conversation-1", attempt: 2 })
    );

    await expect(turns.findTurn("run-1")).resolves.toEqual({
      turnId: "turn-1",
      conversationId: "conversation-1",
      attempt: 2,
    });
  });

  it("reads a superseded or reclaimed Run as naming no Turn, rather than as a fault", async () => {
    for (const status of [404, 409]) {
      const { turns } = host(() => json({ error: "gone" }, status));
      await expect(turns.findTurn("run-1")).resolves.toBeUndefined();
    }
  });

  it("still raises anything else, so a broken host is never read as an absent Turn", async () => {
    const { turns } = host(() => json({ error: "boom" }, 500));

    await expect(turns.findTurn("run-1")).rejects.toBeInstanceOf(InternalApiError);
  });

  it("re-attaches the callId to a dispatch result the host answered without it", async () => {
    const { turns, urls } = host(() => json({ status: "succeeded", output: { rows: 2 } }));

    await expect(
      turns.dispatch({
        businessId: "business-1",
        runId: "run-1",
        stateId: "invoke",
        callId: "call-9",
        name: "list_tasks",
        arguments: { limit: 2 },
      })
    ).resolves.toEqual({ status: "succeeded", callId: "call-9", output: { rows: 2 } });
    expect(urls[0]).toBe("http://api:4010/api/v1/internal/turns/run-1/tools");
  });

  it("keeps the variant of a refusal, rather than flattening it to a failure", async () => {
    const { turns } = host(() => json({ status: "denied", reason: "policy" }));

    await expect(
      turns.dispatch({
        businessId: "business-1",
        runId: "run-1",
        stateId: "invoke",
        callId: "call-9",
        name: "delete_everything",
        arguments: {},
      })
    ).resolves.toEqual({ status: "denied", callId: "call-9", reason: "policy" });
  });

  it("reads only 204 as an unfinished attempt — a missing Run still raises", async () => {
    const empty = host(() => new Response(null, { status: 204 }));
    await expect(empty.turns.findCompletion(REF)).resolves.toBeUndefined();
    expect(empty.urls[0]).toBe("http://api:4010/api/v1/internal/turns/run-1/completion?attempt=2");

    // Reading this as "not finished yet" is how a redelivered job posts a second answer.
    const missing = host(() => json({ error: "run_not_found" }, 404));
    await expect(missing.turns.findCompletion(REF)).rejects.toBeInstanceOf(InternalApiError);
  });

  it("says when the Soul publishes no LLM configuration", async () => {
    const absent = host(() => new Response(null, { status: 204 }));
    await expect(absent.turns.llmConfig()).resolves.toBeUndefined();

    const published = host(() => json({ tiers: {} }));
    await expect(published.turns.llmConfig()).resolves.toEqual({ tiers: {} });
  });

  it("states the Run on every write, so authority is never claimed by this process", async () => {
    const bodies: string[] = [];
    const { turns } = host((_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return json({ messageId: "message-1" });
    });

    await turns.appendAssistantMessage({ ...REF, content: "hello" });
    await turns.completeTurn({ ...REF, status: "succeeded", cursor: 7, messageId: "message-1" });

    expect(JSON.parse(bodies[0] as string)).toEqual({ attempt: 2, content: "hello" });
    expect(JSON.parse(bodies[1] as string)).toEqual({
      attempt: 2,
      status: "succeeded",
      cursor: 7,
      messageId: "message-1",
    });
  });

  it("forwards the failure reason and model diagnostic on a failed completion", async () => {
    const bodies: string[] = [];
    const { turns } = host((_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return json({});
    });

    await turns.completeTurn({
      ...REF,
      status: "failed",
      cursor: 7,
      messageId: null,
      reason: "model_rate_limited",
      modelFailure: { requestId: "req-1", modelId: "gpt-x" },
    });

    expect(JSON.parse(bodies[0] as string)).toEqual({
      attempt: 2,
      status: "failed",
      cursor: 7,
      messageId: null,
      reason: "model_rate_limited",
      modelFailure: { requestId: "req-1", modelId: "gpt-x" },
    });
  });

  it("omits reason and modelFailure from the completion body when absent", async () => {
    const bodies: string[] = [];
    const { turns } = host((_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return json({});
    });

    await turns.completeTurn({ ...REF, status: "failed", cursor: 7, messageId: null });

    const body = JSON.parse(bodies[0] as string);
    expect(body).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("modelFailure");
  });
});
