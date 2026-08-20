import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { llmProbe, probeHealth } from "./health";
import { modelReachability } from "./model-reachability";

/**
 * The `llm` row is the only health check whose verdict comes from a third party, and it was
 * reported both ways: `down` while chat was answering, then `ok` with the provider unplugged.
 * These run the real probe, the real service and a real HTTP provider, because every wrong verdict
 * so far came from the wiring between them rather than from any one of them.
 */

const secrets = {} as unknown as SecretsService;
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let server: Server | undefined;

async function listen(respond: (res: import("node:http").ServerResponse) => void): Promise<string> {
  const created = createServer((_request, response) => respond(response));
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  server = created;
  return `http://127.0.0.1:${(created.address() as AddressInfo).port}/v1`;
}

function json(status: number, body: unknown, delayMs = 0) {
  return (response: import("node:http").ServerResponse) => {
    const send = () => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  };
}

const ANSWER = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "test-balanced",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

async function serviceFor(baseUrl: string): Promise<LlmService> {
  process.env.HEALTH_PROBE_TEST_KEY = "not-a-real-key";
  const entry = (model: string) => ({
    provider: "openai-compatible",
    model,
    api_key_ref: "env://HEALTH_PROBE_TEST_KEY",
    base_url: baseUrl,
  });
  const service = new LlmService();
  await service.init(
    {
      tiers: {
        quick: { providers: [entry("test-fast")] },
        standard: { providers: [entry("test-balanced")] },
        complex: { providers: [entry("test-thorough")] },
      },
    },
    secrets,
    silent
  );
  return service;
}

async function settledStatus(baseUrl: string) {
  const service = await serviceFor(baseUrl);
  const probe = llmProbe(service, { reachability: modelReachability(service) });
  await probeHealth([probe]);
  return vi.waitFor(
    async () => {
      const [component] = await probeHealth([probe]);
      expect(component.detail ?? "").not.toContain("pending");
      return component;
    },
    { timeout: 15_000, interval: 100 }
  );
}

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

describe("the llm health probe against a real provider", () => {
  it("reports ok for a provider that answers, however slowly it starts", async () => {
    const baseUrl = await listen(json(200, ANSWER, 2_500));

    const component = await settledStatus(baseUrl);

    expect(component.status).toBe("ok");
  }, 30_000);

  it("reports down when the provider cannot be reached at all", async () => {
    const baseUrl = await listen(json(200, ANSWER));
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve) => closing?.close(() => resolve()));

    const component = await settledStatus(baseUrl);

    expect(component.status).toBe("down");
    expect(component.detail).toContain("no answer from the provider");
  }, 30_000);

  it("degrades, and says what to do, when the provider refuses the credential", async () => {
    const baseUrl = await listen(
      json(401, { error: { message: "bad key", type: "invalid_request_error" } })
    );

    const component = await settledStatus(baseUrl);

    expect(component.status).toBe("degraded");
    expect(component.detail).toContain("Business → Models");
    expect(component.detail).not.toContain("not-a-real-key");
  }, 30_000);

  it("blames the check, not the provider, when the provider refuses its request", async () => {
    const baseUrl = await listen(
      json(400, { error: { message: "unsupported parameter", type: "invalid_request_error" } })
    );

    const component = await settledStatus(baseUrl);

    expect(component.status).toBe("degraded");
    expect(component.detail).toContain("the provider itself is reachable");
  }, 30_000);
});
