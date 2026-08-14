import { describe, expect, it } from "vitest";
import { cliModelIds, cliModelSpec, isSubscriptionProvider } from "./specs";

/** Every provider in the spec table. Listing them here means adding one updates each test. */
const SUBSCRIPTION_PROVIDERS = ["claude-code", "codex"] as const;

describe("cliModelSpec", () => {
  it("resolves an exact alias", () => {
    expect(cliModelSpec("claude-code", "sonnet")?.max_output_tokens).toBe(64_000);
  });

  it("resolves a versioned model id back to its family alias", () => {
    // `validateRoutingCapacity` hard-rejects any entry without a verified max_input_tokens, so an
    // operator typing the full model id must not fall off the table into a rejected config.
    expect(cliModelSpec("claude-code", "claude-sonnet-4-6")).toEqual(
      cliModelSpec("claude-code", "sonnet")
    );
    expect(cliModelSpec("claude-code", "Claude-Opus-4-1")).toEqual(
      cliModelSpec("claude-code", "opus")
    );
  });

  it("never carries a per-token price", () => {
    // A subscription turn has no per-token cost; pinning the API-equivalent number here would
    // corrupt cost budgets and llm_cost_usd_total.
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      for (const model of cliModelIds(provider)) {
        const spec = cliModelSpec(provider, model) as Record<string, unknown>;
        expect(spec.input_cost_per_token).toBeUndefined();
        expect(spec.output_cost_per_token).toBeUndefined();
      }
    }
  });

  it("declares every model a chat model that can call tools", () => {
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      for (const model of cliModelIds(provider)) {
        const spec = cliModelSpec(provider, model);
        expect(spec?.mode).toBe("chat");
        expect(spec?.supports_function_calling).toBe(true);
      }
    }
  });

  it("returns undefined for an unknown provider or model", () => {
    expect(cliModelSpec("anthropic", "sonnet")).toBeUndefined();
    expect(cliModelSpec("claude-code", "gpt-4o")).toBeUndefined();
    expect(cliModelSpec("codex", "sonnet")).toBeUndefined();
  });

  it("resolves every codex model the picker offers", () => {
    for (const model of cliModelIds("codex")) {
      expect(cliModelSpec("codex", model)?.max_input_tokens).toBe(272_000);
    }
  });
});

describe("cliModelIds", () => {
  it("lists the picker options for a subscription provider", () => {
    expect(cliModelIds("claude-code")).toEqual(["opus", "sonnet", "haiku"]);
    expect(cliModelIds("codex")).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("returns nothing for an API-key provider", () => {
    expect(cliModelIds("anthropic")).toEqual([]);
  });
});

describe("isSubscriptionProvider", () => {
  it("recognises a subscription provider", () => {
    expect(isSubscriptionProvider("claude-code")).toBe(true);
    expect(isSubscriptionProvider("codex")).toBe(true);
  });

  it.each([
    "anthropic",
    "openai",
    "azure",
    "openai-compatible",
  ])("does not treat %s as one", (provider) => {
    expect(isSubscriptionProvider(provider)).toBe(false);
  });

  it("stays in step with the spec table, so a new provider is unpriced by construction", () => {
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      expect(isSubscriptionProvider(provider)).toBe(cliModelIds(provider).length > 0);
    }
  });
});
