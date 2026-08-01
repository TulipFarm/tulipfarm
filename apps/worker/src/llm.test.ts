import { LlmConfigValidationError, LlmNotConfiguredError } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SoulLlm } from "./llm";

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
    // An operator editing llm.config.yaml must not have to restart every worker — and an unchanged
    // Soul must not cost a provider rebuild per turn.
    const { llm, reads, opens } = soul({ sources: [UNCONFIGURED] });

    await expect(llm.model("claude-opus-5")).rejects.toBeInstanceOf(LlmNotConfiguredError);
    await expect(llm.model("claude-opus-5")).rejects.toBeInstanceOf(LlmNotConfiguredError);

    expect(reads()).toBe(2);
    expect(opens()).toBe(1);
  });

  it("applies a republished configuration without a restart", async () => {
    const { llm } = soul({ sources: [UNCONFIGURED, { tiers: "not a tier map" }] });

    await expect(llm.model("claude-opus-5")).rejects.toBeInstanceOf(LlmNotConfiguredError);
    await expect(llm.model("claude-opus-5")).rejects.toBeInstanceOf(LlmConfigValidationError);
  });

  it("shares one rebuild across turns that start together", async () => {
    // Two `init` calls racing on the same service would publish provider maps over each other, and
    // the loser's turn would run against a half-replaced set.
    const { llm, reads, opens } = soul({ sources: [UNCONFIGURED] });

    await Promise.allSettled([llm.model("claude-opus-5"), llm.model("claude-opus-5")]);

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

    await expect(llm.model("claude-opus-5")).rejects.toThrow("no active env-wrapped DEK exists");
    await expect(llm.model("claude-opus-5")).rejects.toBeInstanceOf(LlmNotConfiguredError);

    expect(opens()).toBe(2);
  });
});
