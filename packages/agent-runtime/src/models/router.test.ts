import { describe, expect, it } from "vitest";
import type { ModelInvocationRequest, ModelInvocationResult, ModelPort } from "../ports";
import type { ModelProfileCatalog, ModelRequirements, RoutableModelProfile } from "./profile";
import { ModelRouter, ModelRoutingError } from "./router";
import type { ModelUsageEvent, ModelUsageSink } from "./usage";

function profile(overrides: Partial<RoutableModelProfile> = {}): RoutableModelProfile {
  return {
    profileId: "primary",
    provider: "acme",
    model: "acme-1",
    reasoning: "high",
    supports: { tools: true, structuredOutput: true, contextWindowTokens: 100_000 },
    constraints: { dataRetention: "zero_retention", residency: "eu" },
    fallbacks: [],
    allowCaching: false,
    ...overrides,
  };
}

function catalog(...profiles: readonly RoutableModelProfile[]): ModelProfileCatalog {
  const byId = new Map(profiles.map((entry) => [entry.profileId, entry]));
  return { get: (id) => byId.get(id) };
}

const requirements: ModelRequirements = {
  needsTools: true,
  needsStructuredOutput: true,
  estimatedContextTokens: 10,
  sensitive: false,
  residency: "eu",
  dataRetention: "zero_retention",
};

const request: ModelInvocationRequest = {
  requestId: "req-1",
  modelProfileId: "primary",
  messages: [{ role: "user", content: "the private transcript" }],
};

function recordingSink(): ModelUsageSink & { events: ModelUsageEvent[] } {
  const events: ModelUsageEvent[] = [];
  return {
    events,
    record: async (event) => {
      events.push(event);
    },
  };
}

function port(result: Partial<ModelInvocationResult> = {}): ModelPort {
  return {
    invoke: async (input) => ({
      requestId: input.requestId,
      output: { kind: "text", text: "confidential-answer-body" },
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      ...result,
    }),
  };
}

function router(options: {
  readonly providers: Readonly<Record<string, ModelPort>>;
  readonly catalog: ModelProfileCatalog;
  readonly sink: ModelUsageSink;
  readonly latencies?: readonly number[];
}) {
  const ticks = [...(options.latencies ?? [])];
  let now = 0;
  return new ModelRouter({
    catalog: options.catalog,
    providers: options.providers,
    usage: options.sink,
    now: () => {
      const value = now;
      now += ticks.shift() ?? 0;
      return new Date(value);
    },
  });
}

describe("ModelRouter", () => {
  it("invokes the selected provider and persists usage, cost, and latency evidence", async () => {
    const sink = recordingSink();
    const result = await router({
      providers: { acme: port() },
      catalog: catalog(profile()),
      sink,
      latencies: [120],
    }).invoke(request, requirements, { businessId: "biz-1", runId: "run-1", stateId: "state-1" });

    expect(result.output).toEqual({ kind: "text", text: "confidential-answer-body" });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      businessId: "biz-1",
      runId: "run-1",
      stateId: "state-1",
      profileId: "primary",
      provider: "acme",
      model: "acme-1",
      attempt: 1,
      outcome: "succeeded",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      latencyMs: 120,
      cacheAllowed: false,
    });
  });

  it("never records prompt, message, or output content in usage evidence", async () => {
    const sink = recordingSink();
    await router({
      providers: { acme: port() },
      catalog: catalog(profile()),
      sink,
    }).invoke(request, requirements, { businessId: "biz-1", runId: "run-1", stateId: "state-1" });

    expect(JSON.stringify(sink.events)).not.toContain("the private transcript");
    expect(JSON.stringify(sink.events)).not.toContain("confidential-answer-body");
  });

  it("routes a local OpenAI-compatible provider through the same interface", async () => {
    const sink = recordingSink();
    const result = await router({
      providers: { openai_compatible: port() },
      catalog: catalog(profile({ provider: "openai_compatible", model: "local-llama" })),
      sink,
    }).invoke(request, requirements, { businessId: "biz-1", runId: "run-1", stateId: "state-1" });

    expect(result.output).toEqual({ kind: "text", text: "confidential-answer-body" });
    expect(sink.events[0]).toMatchObject({ provider: "openai_compatible", model: "local-llama" });
  });

  it("falls back only to a constraint-equivalent profile and records both attempts", async () => {
    const sink = recordingSink();
    const failing: ModelPort = {
      invoke: async () => {
        throw new Error("provider outage");
      },
    };
    const result = await router({
      providers: { acme: failing, local: port() },
      catalog: catalog(
        profile({ fallbacks: ["peer", "weak"] }),
        profile({ profileId: "peer", provider: "local", model: "local-1" }),
        profile({
          profileId: "weak",
          provider: "local",
          supports: { tools: false, structuredOutput: true, contextWindowTokens: 10 },
        })
      ),
      sink,
    }).invoke(request, requirements, { businessId: "biz-1", runId: "run-1", stateId: "state-1" });

    expect(result.output).toEqual({ kind: "text", text: "confidential-answer-body" });
    expect(sink.events.map((event) => [event.profileId, event.outcome])).toEqual([
      ["primary", "provider_error"],
      ["peer", "succeeded"],
    ]);
  });

  it("denies when the profile fails a constraint instead of routing anyway", async () => {
    const sink = recordingSink();
    await expect(
      router({
        providers: { acme: port() },
        catalog: catalog(profile({ constraints: { residency: "us" } })),
        sink,
      }).invoke(request, requirements, {
        businessId: "biz-1",
        runId: "run-1",
        stateId: "state-1",
      })
    ).rejects.toThrow(new ModelRoutingError("residency_violation"));
    expect(sink.events).toEqual([]);
  });

  it("denies when no adapter is registered for the profile's provider", async () => {
    const sink = recordingSink();
    await expect(
      router({ providers: {}, catalog: catalog(profile()), sink }).invoke(request, requirements, {
        businessId: "biz-1",
        runId: "run-1",
        stateId: "state-1",
      })
    ).rejects.toThrow(new ModelRoutingError("provider_unavailable"));
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ profileId: "primary", outcome: "provider_unavailable" });
  });

  it("fails closed when actual usage exceeds the profile budget", async () => {
    const sink = recordingSink();
    await expect(
      router({
        providers: {
          acme: port({ usage: { inputTokens: 10, outputTokens: 5, costUsd: 9.5 } }),
        },
        catalog: catalog(
          profile({
            constraints: { dataRetention: "zero_retention", residency: "eu", maxCostUsd: 1 },
          })
        ),
        sink,
      }).invoke(request, requirements, {
        businessId: "biz-1",
        runId: "run-1",
        stateId: "state-1",
      })
    ).rejects.toThrow(new ModelRoutingError("budget_exceeded"));
    expect(sink.events.at(-1)).toMatchObject({ outcome: "budget_exceeded", costUsd: 9.5 });
  });

  it("exhausts the chain rather than retrying a denied profile", async () => {
    const sink = recordingSink();
    const failing: ModelPort = {
      invoke: async () => {
        throw new Error("provider outage");
      },
    };
    await expect(
      router({ providers: { acme: failing }, catalog: catalog(profile()), sink }).invoke(
        request,
        requirements,
        { businessId: "biz-1", runId: "run-1", stateId: "state-1" }
      )
    ).rejects.toThrow(new ModelRoutingError("fallback_exhausted"));
    expect(sink.events).toHaveLength(1);
  });
});
