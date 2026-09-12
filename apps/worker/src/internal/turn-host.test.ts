import { RunInterruptedError } from "@tulipfarm/run-kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InternalApiClient, InternalApiError } from "./client";
import { HttpTurnHost } from "./turn-host";

function host(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
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

const REF = {
  businessId: "business-1",
  runId: "run-1",
  turnId: "turn-1",
  attempt: 2,
  leaseGeneration: 3,
};

function useFakeAbortTimeout(): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("The operation timed out", "TimeoutError")),
      delay
    );
    return controller.signal;
  });
}

function delayedResponse(delayMs: number, response: Response) {
  return (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response), delayMs);
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true }
      );
    });
}

describe("HttpTurnHost", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks the API to settle a terminal Run without trusting callback payload state", async () => {
    const { turns, urls } = host(() => json({ settled: true }));

    await expect(turns.settleTerminal("run-1")).resolves.toBe(true);
    expect(urls[0]).toContain("/api/v1/internal/turns/run-1/terminal");
  });

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

  it.each([75_000, 120_000])("lets a valid Tool response finish after %i ms", async (delayMs) => {
    vi.useFakeTimers();
    useFakeAbortTimeout();
    const { turns } = host(
      delayedResponse(delayMs, json({ status: "succeeded", output: { ok: true } }))
    );

    const result = turns.dispatch({
      businessId: "business-1",
      runId: "run-1",
      stateId: "invoke",
      callId: "call-9",
      name: "skill_install",
      arguments: {},
    });
    const expectation = expect(result).resolves.toEqual({
      status: "succeeded",
      callId: "call-9",
      output: { ok: true },
    });
    await vi.advanceTimersByTimeAsync(delayMs);

    await expectation;
  });

  it("still times out a stuck Tool request at the bounded Tool HTTP deadline", async () => {
    vi.useFakeTimers();
    useFakeAbortTimeout();
    const { turns } = host(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );

    const result = turns.dispatch({
      businessId: "business-1",
      runId: "run-1",
      stateId: "invoke",
      callId: "call-9",
      name: "skill_install",
      arguments: {},
    });
    const expectation = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(135_000);

    await expectation;
  });

  it("keeps ordinary control-plane requests on the 60 second deadline", async () => {
    vi.useFakeTimers();
    useFakeAbortTimeout();
    const { turns } = host(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );

    const result = turns.findTurn("run-1");
    const expectation = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(60_000);

    await expectation;
  });

  it("lets Run interruption abort a Tool request before its HTTP deadline", async () => {
    vi.useFakeTimers();
    useFakeAbortTimeout();
    const interruption = new RunInterruptedError();
    const stop = new AbortController();
    const { turns } = host(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );

    const result = turns.dispatch({
      businessId: "business-1",
      runId: "run-1",
      stateId: "invoke",
      callId: "call-9",
      name: "skill_install",
      arguments: {},
      signal: stop.signal,
    });
    const expectation = expect(result).rejects.toBe(interruption);
    await vi.advanceTimersByTimeAsync(1_000);
    stop.abort(interruption);

    await expectation;
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

  it("reads the boot-validated Observability Config without resolving its Secret ref", async () => {
    const config = {
      enabled: true,
      retentionDays: 30,
      captureContent: false,
      spendAlertUsd: null,
      otlp: {
        endpoint: "https://otlp.example.test/otlp",
        instanceId: "123",
        token: "secret://grafana-otlp-token",
      },
      pricingOverrides: {},
    };
    const published = host(() => json(config));

    await expect(published.turns.observabilityConfig()).resolves.toEqual(config);
  });

  it("states the Run on every write, so authority is never claimed by this process", async () => {
    const bodies: string[] = [];
    const { turns } = host((_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return json({ status: "recorded", messageId: "message-1" });
    });

    await turns.appendAssistantMessage({ ...REF, content: "hello" });
    await turns.completeTurn({ ...REF, status: "succeeded", cursor: 7, messageId: "message-1" });

    expect(JSON.parse(bodies[0] as string)).toEqual({
      attempt: 2,
      leaseGeneration: 3,
      content: "hello",
    });
    expect(JSON.parse(bodies[1] as string)).toEqual({
      attempt: 2,
      leaseGeneration: 3,
      status: "succeeded",
      cursor: 7,
      messageId: "message-1",
    });
  });

  it("preserves stale writes so the executor treats a lost retry race as superseded", async () => {
    const { turns } = host((url) =>
      url.endsWith("/messages")
        ? json({ status: "stale", messageId: null })
        : json({ status: "stale" })
    );

    await expect(turns.appendAssistantMessage({ ...REF, content: "late" })).resolves.toEqual({
      status: "stale",
      messageId: null,
    });

    await expect(
      turns.completeTurn({ ...REF, status: "succeeded", cursor: 7, messageId: null })
    ).resolves.toEqual({ status: "stale" });
  });

  it("maps a Run ownership conflict on a write to interruption", async () => {
    const { turns } = host(() => json({ error: "run_not_running" }, 409));

    await expect(turns.appendAssistantMessage({ ...REF, content: "late" })).rejects.toBeInstanceOf(
      RunInterruptedError
    );
    await expect(
      turns.completeTurn({ ...REF, status: "succeeded", cursor: 7, messageId: null })
    ).rejects.toBeInstanceOf(RunInterruptedError);
  });

  it("forwards the failure reason and model diagnostic on a failed completion", async () => {
    const bodies: string[] = [];
    const { turns } = host((_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return json({ status: "recorded" });
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
      leaseGeneration: 3,
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
      return json({ status: "recorded" });
    });

    await turns.completeTurn({ ...REF, status: "failed", cursor: 7, messageId: null });

    const body = JSON.parse(bodies[0] as string);
    expect(body).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("modelFailure");
  });
});
