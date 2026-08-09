import { describe, expect, it, vi } from "vitest";
import {
  fetchLiteLlmCatalog,
  type LiteLlmCatalog,
  resolveModelSpec,
  resolveModelSpecCandidate,
} from "./model-spec";

const FETCHED = "2026-06-28";

const CATALOG: LiteLlmCatalog = {
  sample_spec: { input_cost_per_token: 0 },
  "gpt-4o": {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    max_input_tokens: 128000,
    max_output_tokens: 16384,
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_prompt_caching: true,
  },
  "azure_ai/kimi-k2.5": {
    input_cost_per_token: 0.00000057,
    output_cost_per_token: 0.0000023,
    max_input_tokens: 256000,
    mode: "chat",
    supports_function_calling: true,
  },
  "xai/grok-4-1-fast": {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
    mode: "chat",
  },
  "openrouter/moonshotai/kimi-k2.5": {
    input_cost_per_token: 0.0000006,
    output_cost_per_token: 0.0000025,
  },
  // A non-chat / cost-less entry: a confident match requires pricing, so this routes to candidates.
  "text-embedding-3-small": { mode: "embedding", max_input_tokens: 8191 },
};

describe("resolveModelSpec", () => {
  it("matches a bare openai model id", () => {
    const r = resolveModelSpec("openai", "gpt-4o", CATALOG, FETCHED);
    expect(r.matchedKey).toBe("gpt-4o");
    expect(r.spec).toMatchObject({
      litellm_key: "gpt-4o",
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.00001,
      max_input_tokens: 128000,
      supports_vision: true,
      fetched_at: FETCHED,
    });
  });

  it("matches an azure model via the azure_ai/ prefix", () => {
    const r = resolveModelSpec("azure", "kimi-k2.5", CATALOG, FETCHED);
    expect(r.matchedKey).toBe("azure_ai/kimi-k2.5");
    expect(r.spec?.input_cost_per_token).toBe(0.00000057);
  });

  it("matches an openai-compatible model by suffix when there's a single bare-id match", () => {
    const r = resolveModelSpec("openai-compatible", "grok-4-1-fast", CATALOG, FETCHED);
    expect(r.matchedKey).toBe("xai/grok-4-1-fast");
  });

  it("returns candidates (no confident match) when the bare id is ambiguous", () => {
    // both `azure_ai/kimi-k2.5` and `openrouter/moonshotai/kimi-k2.5` end in `kimi-k2.5`
    const r = resolveModelSpec("openai-compatible", "kimi-k2.5", CATALOG, FETCHED);
    expect(r.spec).toBeNull();
    expect(r.candidates).toContain("azure_ai/kimi-k2.5");
    expect(r.candidates).toContain("openrouter/moonshotai/kimi-k2.5");
  });

  it("pins the explicit candidate without changing the provider model id", () => {
    const resolution = resolveModelSpecCandidate("azure_ai/kimi-k2.5", CATALOG, FETCHED);

    expect(resolution).toMatchObject({
      matchedKey: "azure_ai/kimi-k2.5",
      candidates: [],
      spec: { max_input_tokens: 256000, litellm_key: "azure_ai/kimi-k2.5" },
    });
  });

  it("returns no match + loose candidates for an unknown model", () => {
    const r = resolveModelSpec("openai", "totally-made-up-model", CATALOG, FETCHED);
    expect(r.matchedKey).toBeNull();
    expect(r.spec).toBeNull();
  });

  it("does not confidently match a cost-less (non-chat) entry; offers it as a candidate", () => {
    const r = resolveModelSpec("openai", "text-embedding-3-small", CATALOG, FETCHED);
    expect(r.spec).toBeNull();
    expect(r.matchedKey).toBeNull();
    expect(r.candidates).toContain("text-embedding-3-small");
  });
});

describe("fetchLiteLlmCatalog", () => {
  it("returns the parsed catalog", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => CATALOG }) as unknown as Response
    );
    const cat = await fetchLiteLlmCatalog({ fetchImpl: fetchMock as unknown as typeof fetch });
    expect(cat?.["gpt-4o"]).toBeDefined();
  });

  it("returns null on failure (caller degrades to no spec)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(
      await fetchLiteLlmCatalog({ fetchImpl: fetchMock as unknown as typeof fetch })
    ).toBeNull();
  });
});
