import { describe, expect, it } from "vitest";
import { decidePromptCache, type PromptCacheInput } from "./prompt-cache";

/** A prefix comfortably over Anthropic's 1024-token minimum at the pessimistic 5 chars/token. */
const LONG_PREFIX = 1024 * 5;

const input = (overrides: Partial<PromptCacheInput> = {}): PromptCacheInput => ({
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  cacheAllowed: true,
  prefixChars: LONG_PREFIX,
  ...overrides,
});

describe("decidePromptCache", () => {
  it("asks an explicit provider to cache a long enough allowed prefix", () => {
    expect(decidePromptCache(input())).toEqual({
      kind: "annotate",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("honours routing's refusal, which is how a sensitive prompt stays out of a cache", () => {
    expect(decidePromptCache(input({ cacheAllowed: false }))).toEqual({
      kind: "skip",
      reason: "routing_withheld",
    });
  });

  it("fails closed when no profile decided, because nothing then checked sensitivity", () => {
    expect(decidePromptCache(input({ cacheAllowed: undefined }))).toEqual({
      kind: "skip",
      reason: "routing_unknown",
    });
  });

  it("leaves implicitly-caching providers alone rather than sending an inert option", () => {
    for (const provider of ["openai", "azure", "claude-code", "codex"]) {
      expect(decidePromptCache(input({ provider }))).toEqual({
        kind: "skip",
        reason: "provider_implicit",
      });
    }
  });

  it("refuses to guess a wire format for a provider with no known contract", () => {
    for (const provider of ["openai-compatible", "something-new", undefined]) {
      expect(decidePromptCache(input({ provider }))).toEqual({
        kind: "skip",
        reason: "provider_unknown",
      });
    }
  });

  it("will not pay the cache-write premium on a prefix too short to be cached", () => {
    expect(decidePromptCache(input({ prefixChars: LONG_PREFIX - 1 }))).toEqual({
      kind: "skip",
      reason: "prefix_too_short",
    });
  });

  it("applies Haiku's doubled minimum, so a Sonnet-sized prefix is not annotated for it", () => {
    expect(decidePromptCache(input({ modelId: "claude-haiku-4-5" }))).toEqual({
      kind: "skip",
      reason: "prefix_too_short",
    });
    expect(
      decidePromptCache(input({ modelId: "claude-haiku-4-5", prefixChars: 2048 * 5 }))
    ).toEqual({
      kind: "annotate",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("checks the allowance before the provider, so a refusal cannot be routed around", () => {
    expect(decidePromptCache(input({ cacheAllowed: false, provider: "openai" }))).toEqual({
      kind: "skip",
      reason: "routing_withheld",
    });
  });
});
