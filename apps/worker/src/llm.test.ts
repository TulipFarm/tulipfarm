import type { ModelInvocationRequest, ModelRequirements } from "@tulipfarm/agent-runtime";
import type { FallbackCallGate } from "@tulipfarm/llm";
import {
  AmbiguousModelError,
  LlmConfigValidationError,
  LlmNotConfiguredError,
  textContent,
} from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoulLlm } from "./llm";
import { LlmModelPort } from "./model";
import type { WorkerSpendSink } from "./observability";

afterEach(() => vi.unstubAllGlobals());

/** The undemanding request: any configured profile can serve it. */
const ANY: ModelRequirements = {
  needsTools: false,
  needsStructuredOutput: false,
  estimatedContextTokens: 100,
  sensitive: false,
};

/** A Soul that publishes nothing: `init` is a no-op, so no provider credential is ever needed. */
const UNCONFIGURED = null;

function soul(options: {
  sources: unknown[];
  secrets?: (attempt: number) => Promise<SecretsService>;
  pricingOverrides?: () => Promise<Record<string, { in: number; out: number }>>;
}): {
  llm: SoulLlm;
  reads: () => number;
  opens: () => number;
} {
  let reads = 0;
  let opens = 0;
  return {
    llm: new SoulLlm({
      source: async () => options.sources[Math.min(reads++, options.sources.length - 1)],
      secrets: async () => {
        opens += 1;
        if (options.secrets) return options.secrets(opens);
        return {} as SecretsService;
      },
      ...(options.pricingOverrides === undefined
        ? {}
        : { pricingOverrides: options.pricingOverrides }),
    }),
    reads: () => reads,
    opens: () => opens,
  };
}

describe("SoulLlm", () => {
  beforeEach(() => {
    // `init` announces an unconfigured Soul on every build; the assertions below are about calls.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("re-reads the configuration each call but rebuilds only when it changed", async () => {
    // An operator editing soul.yaml#llm must not have to restart every worker — and an unchanged
    // Soul must not cost a provider rebuild per turn.
    const { llm, reads, opens } = soul({ sources: [UNCONFIGURED] });

    await expect(llm.model("claude-opus-5", ANY)).rejects.toBeInstanceOf(LlmNotConfiguredError);
    await expect(llm.model("claude-opus-5", ANY)).rejects.toBeInstanceOf(LlmNotConfiguredError);

    expect(reads()).toBe(2);
    expect(opens()).toBe(1);
  });

  it("applies a republished configuration without a restart", async () => {
    const { llm } = soul({ sources: [UNCONFIGURED, { tiers: "not a tier map" }] });

    await expect(llm.model("claude-opus-5", ANY)).rejects.toBeInstanceOf(LlmNotConfiguredError);
    await expect(llm.model("claude-opus-5", ANY)).rejects.toBeInstanceOf(LlmConfigValidationError);
  });

  it("shares one rebuild across turns that start together", async () => {
    // Two `init` calls racing on the same service would publish provider maps over each other, and
    // the loser's turn would run against a half-replaced set.
    const { llm, reads, opens } = soul({ sources: [UNCONFIGURED] });

    await Promise.allSettled([llm.model("claude-opus-5", ANY), llm.model("claude-opus-5", ANY)]);

    expect(reads()).toBe(1);
    expect(opens()).toBe(1);
  });

  it("retries a secret store that was not ready, rather than failing every later turn", async () => {
    // The API provisions the DEK. A worker that started first must recover on its own.
    const { llm, opens } = soul({
      sources: [UNCONFIGURED],
      secrets: async (attempt) => {
        if (attempt === 1) throw new Error("no active env-wrapped DEK exists");
        return {} as SecretsService;
      },
    });

    await expect(llm.model("claude-opus-5", ANY)).rejects.toThrow(
      "no active env-wrapped DEK exists"
    );
    await expect(llm.model("claude-opus-5", ANY)).rejects.toBeInstanceOf(LlmNotConfiguredError);

    expect(opens()).toBe(2);
  });
});

/**
 * A Soul configured with a two-provider tier, credentials read from the environment so no secret
 * store is involved. This is the shape every unmigrated deployment actually has.
 */
const TWO_PROVIDER_SOUL = {
  tiers: {
    quick: {
      providers: [{ provider: "anthropic", model: "haiku", api_key_ref: "env://TEST_KEY" }],
    },
    standard: {
      providers: [
        { provider: "anthropic", model: "sonnet", api_key_ref: "env://TEST_KEY" },
        { provider: "openai", model: "gpt-4o", api_key_ref: "env://TEST_KEY" },
      ],
    },
    complex: {
      providers: [{ provider: "anthropic", model: "opus", api_key_ref: "env://TEST_KEY" }],
    },
  },
};

const DUPLICATE_MODEL_SOUL = {
  tiers: {
    ...TWO_PROVIDER_SOUL.tiers,
    standard: {
      providers: [
        {
          provider: "openai-compatible",
          model: "house-model",
          api_key_ref: "env://TEST_KEY_A",
          base_url: "https://one.example/v1",
          spec: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
        },
        {
          provider: "azure",
          model: "house-model",
          api_key_ref: "env://TEST_KEY_B",
          base_url: "https://two.example",
          resource_name: "test-resource",
          spec: { input_cost_per_token: 0.000007, output_cost_per_token: 0.000009 },
        },
      ],
    },
  },
};

describe("SoulLlm — governance", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.TEST_KEY = "sk-test";
  });

  function soulWithConstraints(constraints?: Record<string, unknown>) {
    return {
      tiers: {
        ...TWO_PROVIDER_SOUL.tiers,
        standard: {
          providers: [
            {
              provider: "openai",
              model: "gpt-4o",
              api_key_ref: "env://TEST_KEY",
              ...(constraints === undefined ? {} : { constraints }),
            },
          ],
        },
      },
    };
  }

  it("denies a model whose declared residency does not match what the turn requires", async () => {
    const { llm } = soul({ sources: [soulWithConstraints({ residency: "us" })] });

    const resolution = await llm.resolveModel("balanced", { ...ANY, residency: "eu" });

    expect(resolution.kind).toBe("denied");
    expect(resolution.routing).toMatchObject({ outcome: "denied", reason: "residency_violation" });
  });

  it("denies a model that declares no residency at all when the turn requires one", async () => {
    // Undeclared is unverifiable, not permissive. Nothing derived `constraints` from authored
    // config before, so every model read as undeclared and this denial could never fire.
    const { llm } = soul({ sources: [soulWithConstraints()] });

    const resolution = await llm.resolveModel("balanced", { ...ANY, residency: "eu" });

    expect(resolution.kind).toBe("denied");
    expect(resolution.routing).toMatchObject({ outcome: "denied", reason: "residency_violation" });
  });

  it("serves a model whose declared residency matches", async () => {
    const { llm } = soul({ sources: [soulWithConstraints({ residency: "eu" })] });

    const resolution = await llm.resolveModel("balanced", { ...ANY, residency: "eu" });

    expect(resolution.kind).toBe("available");
  });

  it("leaves a turn that demands nothing unaffected by an undeclared posture", async () => {
    const { llm } = soul({ sources: [soulWithConstraints()] });

    const resolution = await llm.resolveModel("balanced", ANY);

    expect(resolution.kind).toBe("available");
  });
});

describe("SoulLlm — cost ceilings and pricing", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.TEST_KEY = "sk-test";
    process.env.TEST_KEY_A = "sk-test-a";
    process.env.TEST_KEY_B = "sk-test-b";
  });

  /** `sonnet` is not a priceable id; `gpt-4o` is in the built-in table. */
  function soulWithCeiling(model: string) {
    return {
      tiers: {
        ...TWO_PROVIDER_SOUL.tiers,
        standard: {
          providers: [
            {
              provider: "openai",
              model,
              api_key_ref: "env://TEST_KEY",
              budgets: { max_cost_usd: 5 },
            },
          ],
        },
      },
    };
  }

  it("refuses a chain it cannot price when the profile declares a cost ceiling", async () => {
    // A ceiling that cannot be charged is not a ceiling. Serving the call anyway would make the
    // limit strictest on the models we can price and absent on the ones we cannot.
    const { llm } = soul({ sources: [soulWithCeiling("sonnet")] });

    const resolution = await llm.resolveModel("balanced", ANY);

    expect(resolution.kind).toBe("denied");
    expect(resolution.routing).toMatchObject({ outcome: "denied", reason: "cost_unpriceable" });
  });

  it("serves the same unpriceable chain when no cost ceiling was declared", async () => {
    // Denying here would fail Runs that never asked for a limit. The earlier attempt at this fix
    // probed pricability with a zero-amount budget charge, which the ledger rejects outright, and
    // so hard-failed every Run regardless of whether it had a ceiling at all.
    const { llm } = soul({ sources: [TWO_PROVIDER_SOUL] });

    const resolution = await llm.resolveModel("balanced", ANY);

    expect(resolution.kind).toBe("available");
  });

  it("refuses an unpriceable Routine chain when its resolved Run limits include cost", async () => {
    const { llm } = soul({ sources: [TWO_PROVIDER_SOUL] });

    const resolution = await llm.resolveChain(
      ["sonnet"],
      {
        outcome: "selected",
        selector: "fast",
        resolution: "profile_ref",
        profileId: "fast",
        chain: [{ profileId: "fast", modelId: "sonnet" }],
        cacheAllowed: false,
        rejectedFallbacks: [],
      },
      undefined,
      undefined,
      { costMicros: { value: 5_000_000, scope: "model" } }
    );

    expect(resolution.kind).toBe("denied");
    expect(resolution.routing).toMatchObject({
      outcome: "denied",
      profileId: "fast",
      reason: "cost_unpriceable",
    });
  });

  it("serves a priceable chain under a declared ceiling", async () => {
    const { llm } = soul({ sources: [soulWithCeiling("gpt-4o")] });

    const resolution = await llm.resolveModel("balanced", ANY);

    expect(resolution.kind).toBe("available");
  });

  it("prices a served call, and reports an unpriceable one as unpriced rather than free", async () => {
    const { llm } = soul({ sources: [TWO_PROVIDER_SOUL] });
    const resolution = await llm.resolveModel("gpt-4o", ANY);

    if (resolution.kind !== "available") throw new Error("expected an available resolution");
    expect(resolution.price(1_000_000, 0)).toEqual({
      kind: "priced",
      costUsd: 2.5,
      source: "table",
    });

    const unpriceable = await llm.resolveModel("sonnet", ANY);
    if (unpriceable.kind !== "available") throw new Error("expected an available resolution");
    expect(unpriceable.price(1_000_000, 0)).toEqual({ kind: "unpriced" });
  });

  it("reserves enough priced cost for every fallback link that one call may attempt", async () => {
    const { llm } = soul({ sources: [DUPLICATE_MODEL_SOUL] });
    const resolution = await llm.resolveModel("balanced", ANY);

    if (resolution.kind !== "available") throw new Error("expected an available resolution");
    expect(resolution.reservationPrice?.(100, 50)).toEqual({
      kind: "priced",
      costUsd: 0.00135,
      source: "table",
    });
  });

  it("applies an operator price correction on the branch that charges the budget", async () => {
    // The override used to reach only the reporting side, so enforcement ran on the stale price.
    const { llm } = soul({
      sources: [TWO_PROVIDER_SOUL],
      pricingOverrides: async () => ({ sonnet: { in: 7, out: 9 } }),
    });

    const resolution = await llm.resolveModel("sonnet", ANY);

    if (resolution.kind !== "available") throw new Error("expected an available resolution");
    expect(resolution.price(1_000_000, 0)).toMatchObject({ costUsd: 7, source: "override" });
  });

  it("treats a subscription seat as unmetered instead of billing published API rates", async () => {
    // The seat is already paid for; charging it list price fails Runs that had budget left.
    const { llm } = soul({
      sources: [
        {
          tiers: {
            ...TWO_PROVIDER_SOUL.tiers,
            standard: {
              providers: [
                { provider: "claude-code", model: "sonnet", api_key_ref: "env://TEST_KEY" },
              ],
            },
          },
        },
      ],
    });

    const resolution = await llm.resolveModel("balanced", ANY);

    if (resolution.kind !== "available") throw new Error("expected an available resolution");
    expect(resolution.price(1_000_000, 1_000_000)).toEqual({ kind: "subscription" });

    const routine = await llm.resolveChain(
      ["sonnet"],
      {
        outcome: "selected",
        selector: "fast",
        resolution: "profile_ref",
        profileId: "fast",
        chain: [{ profileId: "fast", modelId: "sonnet" }],
        cacheAllowed: false,
        rejectedFallbacks: [],
      },
      undefined,
      undefined,
      { costMicros: { value: 1, scope: "model" } }
    );
    expect(routine.kind).toBe("available");
  });
});

describe("SoulLlm — profile routing", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.TEST_KEY = "sk-test";
  });

  it("serves an effort preset with every configured provider in the chain", async () => {
    // Regression for the dead fallback chain: selection used to happen in the API and only the
    // chain *head* crossed the process boundary, so this process rebuilt a single model and no
    // configured backup provider was ever tried. The resolved model must carry both.
    const { llm } = soul({ sources: [TWO_PROVIDER_SOUL] });

    const model = await llm.model("balanced", ANY);

    expect(typeof model === "string" ? model : model.modelId).toBe("sonnet|gpt-4o");
  });

  it("routes duplicate model ids through distinct connections and attributes the fallback price", async () => {
    process.env.TEST_KEY_A = "key-a";
    process.env.TEST_KEY_B = "key-b";
    const requests: { credentialHeader: string | undefined; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        requests.push({
          credentialHeader: headers.has("api-key")
            ? "api-key"
            : headers.has("authorization")
              ? "authorization"
              : undefined,
          url,
        });
        if (url.startsWith("https://one.example/")) {
          return new Response(JSON.stringify({ error: { message: "first endpoint down" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            id: "response-2",
            created_at: 1,
            model: "house-model",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
    const gateKeys: string[] = [];
    const gate: FallbackCallGate = {
      acquire: async (key) => {
        gateKeys.push(key);
        return {
          succeeded() {},
          failed() {},
          cancelled() {},
          release() {},
        };
      },
    };
    const { llm } = soul({ sources: [DUPLICATE_MODEL_SOUL] });

    const resolution = await llm.resolveModel("balanced", ANY, undefined, undefined, gate);

    if (resolution.kind !== "available") throw new Error("expected an available resolution");
    if (typeof resolution.model === "string") throw new Error("expected a built model");
    await expect(resolution.model.doGenerate({ prompt: [] })).resolves.toMatchObject({
      finishReason: { unified: "stop" },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      credentialHeader: "authorization",
      url: "https://one.example/v1/chat/completions",
    });
    expect(requests[1]?.credentialHeader).toBe("api-key");
    expect(requests[1]?.url).toMatch(/^https:\/\/two\.example\//);
    expect(gateKeys).toEqual(["openai-compatible:house-model", "azure:house-model"]);
    expect(resolution.providerForModel?.(resolution.attemptedModelId?.())).toBe("azure");
    expect(resolution.attemptedConfiguredModel?.()).toEqual({
      connection: "azure",
      modelId: "house-model",
    });
    expect(resolution.respondingConfiguredModel?.()).toEqual({
      connection: "azure",
      modelId: "house-model",
    });
    expect(resolution.routing).toMatchObject({
      outcome: "selected",
      chain: [
        {
          modelId: "house-model",
          connection: "openai-compatible",
        },
        {
          modelId: "house-model",
          connection: "azure",
        },
      ],
    });
    expect(resolution.price(1_000_000, 0)).toEqual({
      kind: "priced",
      costUsd: 7,
      source: "spec",
    });

    const spend: Parameters<WorkerSpendSink["recordLlmCall"]>[0][] = [];
    const responseModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "done" },
            { type: "text-end", id: "answer" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    });
    const port = new LlmModelPort({
      model: async () => ({ ...resolution, model: responseModel as unknown as LanguageModel }),
      spend: {
        recordLlmCall: (record) => spend.push(record),
        recordTurn: () => undefined,
      },
    });
    const request: ModelInvocationRequest = {
      requestId: "duplicate-connection",
      modelProfileId: "balanced",
      messages: [{ role: "user", content: textContent("hello") }],
      tools: [],
    };

    await port.invoke(request);

    expect(spend).toEqual([
      expect.objectContaining({
        requestId: "duplicate-connection:attempt:0",
        status: "error",
        model: "house-model",
        provider: "openai-compatible",
        connection: "openai-compatible",
      }),
      expect.objectContaining({
        requestId: "duplicate-connection:attempt:1",
        status: "fallback",
        model: "house-model",
        provider: "azure",
        connection: "azure",
        usage: expect.objectContaining({ costUsd: 7 }),
      }),
    ]);
  });

  it("rejects a duplicate raw model id instead of hiding a caller that dropped connection identity", async () => {
    process.env.TEST_KEY_A = "key-a";
    process.env.TEST_KEY_B = "key-b";
    const { llm } = soul({ sources: [DUPLICATE_MODEL_SOUL] });

    await expect(llm.model("house-model", ANY)).rejects.toBeInstanceOf(AmbiguousModelError);
  });

  it("accepts a retired tier name as a deprecated alias for its effort preset", async () => {
    const { llm } = soul({ sources: [TWO_PROVIDER_SOUL] });

    const model = await llm.model("standard", ANY);

    expect(typeof model === "string" ? model : model.modelId).toBe("sonnet|gpt-4o");
  });

  it("still resolves a raw model id, so a Run minted before profiles existed replays", async () => {
    // Request Artifacts are immutable; an old Run's recorded selector must keep resolving.
    const { llm } = soul({ sources: [TWO_PROVIDER_SOUL] });

    const model = await llm.model("gpt-4o", ANY);

    expect(typeof model === "string" ? model : model.modelId).toBe("gpt-4o");
  });

  it("denies rather than silently downgrading when nothing meets the requirements", async () => {
    // A context no configured model can hold must be a denial. Routing to a smaller model would
    // truncate the prompt and answer a question nobody asked.
    const { llm } = soul({ sources: [TWO_PROVIDER_SOUL] });

    await expect(
      llm.model("balanced", { ...ANY, estimatedContextTokens: 100_000_000 })
    ).rejects.toThrow(/denied: context_window_exceeded/);
  });

  it("drops a fallback that cannot meet the same constraints as the primary", async () => {
    // Constraint-equivalent fallback: a link that would satisfy fewer constraints is not a fallback.
    const soulWithNarrowFallback = {
      tiers: {
        ...TWO_PROVIDER_SOUL.tiers,
        standard: {
          providers: [
            {
              provider: "anthropic",
              model: "sonnet",
              api_key_ref: "env://TEST_KEY",
              spec: { max_input_tokens: 200_000 },
            },
            {
              provider: "openai",
              model: "gpt-4o",
              api_key_ref: "env://TEST_KEY",
              spec: { max_input_tokens: 8_000 },
            },
          ],
        },
      },
    };
    const { llm } = soul({ sources: [soulWithNarrowFallback] });

    const model = await llm.model("balanced", { ...ANY, estimatedContextTokens: 50_000 });

    expect(typeof model === "string" ? model : model.modelId).toBe("sonnet");
  });
});
