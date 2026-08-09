import type { ModelRequirements } from "@tulipfarm/agent-runtime";
import { LlmConfigValidationError, LlmNotConfiguredError } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SoulLlm } from "./llm";

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
