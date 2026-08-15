import { describe, expect, it } from "vitest";
import type { LlmConfig, ProviderEntry } from "./llm";
import {
  asEffortPreset,
  deriveModelProfiles,
  hoistProviderConnections,
  isDeprecatedTierAlias,
  resolveEffortPreset,
} from "./model-catalog";

function entry(model: string, spec?: ProviderEntry["spec"]): ProviderEntry {
  return { provider: "acme", model, ...(spec === undefined ? {} : { spec }) };
}

function config(tiers: Partial<NonNullable<LlmConfig["tiers"]>>): LlmConfig {
  return {
    tiers: {
      quick: { providers: [entry("q-1")] },
      standard: { providers: [entry("s-1")] },
      complex: { providers: [entry("c-1")] },
      ...tiers,
    },
  } as LlmConfig;
}

describe("asEffortPreset", () => {
  it("maps retired tier names onto effort presets", () => {
    expect(asEffortPreset("quick")).toBe("fast");
    expect(asEffortPreset("standard")).toBe("balanced");
    expect(asEffortPreset("complex")).toBe("thorough");
  });

  it("passes effort presets through unchanged", () => {
    expect(asEffortPreset("auto")).toBe("auto");
    expect(asEffortPreset("thorough")).toBe("thorough");
  });

  it("returns undefined for a raw model id or profile ref", () => {
    expect(asEffortPreset("claude-sonnet-4")).toBeUndefined();
    expect(asEffortPreset(undefined)).toBeUndefined();
  });

  it("identifies retired tier names for deprecation logging", () => {
    expect(isDeprecatedTierAlias("quick")).toBe(true);
    expect(isDeprecatedTierAlias("fast")).toBe(false);
  });
});

describe("deriveModelProfiles — authored budgets", () => {
  it("derives a per-model cost ceiling an operator authored", () => {
    // `ModelProfileSpec.budgets` was consumed by the Run budget resolver but derived from nothing,
    // so no operator could declare a ceiling and the enforcement path was unreachable in production.
    const profiles = deriveModelProfiles(
      config({
        standard: {
          providers: [
            {
              provider: "anthropic",
              model: "sonnet",
              api_key_ref: "env://KEY",
              budgets: { max_cost_usd: 2.5, max_tokens: 100_000 },
            },
          ],
        },
      })
    );

    // The `standard` tier derives to the `balanced` effort preset.
    const balanced = profiles.find((profile) => profile.model === "sonnet");
    expect(balanced?.budgets).toEqual({ maxCostUsd: 2.5, maxTokens: 100_000 });
  });

  it("leaves a profile with no authored ceiling unbounded rather than inventing one", () => {
    const profiles = deriveModelProfiles(config({}));
    for (const profile of profiles) expect(profile.budgets).toBeUndefined();
  });
});

describe("deriveModelProfiles — authored governance", () => {
  it("derives the governance posture an operator authored", () => {
    // `ModelProfileSpec.constraints` gated residency, retention and training in
    // `selectModelProfile`, but nothing derived it, so every profile read as undeclared and none
    // of those denials could fire.
    const profiles = deriveModelProfiles(
      config({
        standard: {
          providers: [
            {
              provider: "anthropic",
              model: "sonnet",
              api_key_ref: "env://KEY",
              constraints: {
                residency: "eu",
                data_retention: "zero_retention",
                allow_training: false,
                max_latency_ms: 2_000,
              },
            },
          ],
        },
      })
    );

    const balanced = profiles.find((profile) => profile.model === "sonnet");
    expect(balanced?.constraints).toEqual({
      residency: "eu",
      dataRetention: "zero_retention",
      allowTraining: false,
      maxLatencyMs: 2_000,
    });
  });

  it("leaves an unauthored posture undeclared rather than inventing a permissive one", () => {
    const profiles = deriveModelProfiles(config({}));
    for (const profile of profiles) expect(profile.constraints).toBeUndefined();
  });
});

describe("deriveModelProfiles", () => {
  it("derives one profile per tier, named for its effort preset", () => {
    const profiles = deriveModelProfiles(config({}));

    expect(profiles.map((p) => p.profileId)).toEqual(["fast", "balanced", "thorough"]);
  });

  it("keeps every configured provider in the chain, not just the head", () => {
    // The tier runtime built a FallbackModel over all three but only ever shipped the head across
    // the process boundary, leaving the backups inert. The whole chain must survive derivation.
    const profiles = deriveModelProfiles(
      config({ standard: { providers: [entry("s-1"), entry("s-2"), entry("s-3")] } })
    );

    const head = profiles.find((p) => p.profileId === "balanced");
    expect(head?.fallbacks).toEqual(["balanced-fallback-1", "balanced-fallback-2"]);
    expect(profiles.map((p) => p.model)).toContain("s-2");
    expect(profiles.map((p) => p.model)).toContain("s-3");
  });

  it("reads capability from the pinned spec rather than guessing", () => {
    const profiles = deriveModelProfiles(
      config({
        standard: {
          providers: [
            entry("s-1", {
              supports_vision: true,
              supports_function_calling: true,
              max_input_tokens: 200_000,
              supports_prompt_caching: true,
            }),
          ],
        },
      })
    );

    const balanced = profiles.find((p) => p.profileId === "balanced");
    expect(balanced?.supports.inputModalities).toEqual(["text", "image"]);
    expect(balanced?.supports.contextWindowTokens).toBe(200_000);
    expect(balanced?.allowCaching).toBe(true);
  });

  it("treats an unpinned spec as text-only but still tool-capable", () => {
    // Conservative on modality (an image must never reach a model that would drop it), permissive
    // on tools (the tier runtime never gated on them, so migration cannot start denying turns).
    const balanced = deriveModelProfiles(config({})).find((p) => p.profileId === "balanced");

    expect(balanced?.supports.inputModalities).toEqual(["text"]);
    expect(balanced?.supports.tools).toBe(true);
  });

  it("skips a tier with no providers instead of inventing one", () => {
    const profiles = deriveModelProfiles(config({ quick: { providers: [] } }));

    expect(profiles.map((p) => p.profileId)).not.toContain("fast");
  });

  it("returns nothing for a config carrying no tiers", () => {
    expect(deriveModelProfiles({} as LlmConfig)).toEqual([]);
  });
});

describe("resolveEffortPreset", () => {
  const all = () => true;

  it("resolves auto to the declared default", () => {
    expect(resolveEffortPreset("auto", { presets: { default: "thorough" } }, all)).toBe("thorough");
  });

  it("falls back to balanced when auto has no declared default", () => {
    expect(resolveEffortPreset("auto", {}, all)).toBe("balanced");
  });

  it("prefers an explicitly mapped profile over the preset name", () => {
    expect(resolveEffortPreset("fast", { presets: { fast: "custom-fast" } }, all)).toBe(
      "custom-fast"
    );
  });

  it("skips a mapped profile the catalog does not publish", () => {
    const available = (id: string) => id === "fast";

    expect(resolveEffortPreset("fast", { presets: { fast: "missing" } }, available)).toBe("fast");
  });

  it("returns undefined when nothing resolves rather than inventing a model", () => {
    expect(resolveEffortPreset("thorough", {}, () => false)).toBeUndefined();
  });

  it("is deterministic across repeated calls", () => {
    const once = resolveEffortPreset("auto", { presets: { default: "balanced" } }, all);
    const twice = resolveEffortPreset("auto", { presets: { default: "balanced" } }, all);

    expect(once).toBe(twice);
  });
});

describe("hoistProviderConnections", () => {
  it("gives the sole connection for a provider the bare provider name", () => {
    const { connections, nameFor } = hoistProviderConnections(config({}));

    expect(Object.keys(connections)).toEqual(["acme"]);
    expect(nameFor(entry("q-1"))).toBe("acme");
  });

  it("carries credentials across so the connection is usable on its own", () => {
    const azure: ProviderEntry = {
      provider: "azure",
      model: "gpt-4o",
      api_key_ref: "azure-key",
      base_url: "https://one.example",
      resource_name: "one",
    };
    const { connections } = hoistProviderConnections(config({ quick: { providers: [azure] } }));

    expect(connections.azure).toEqual({
      provider: "azure",
      api_key_ref: "azure-key",
      base_url: "https://one.example",
      resource_name: "one",
    });
  });

  it("keeps two accounts on one provider apart instead of collapsing them", () => {
    // Collapsing these would repoint the second account's traffic at the first account's key.
    const first: ProviderEntry = { provider: "azure", model: "gpt-4o", api_key_ref: "key-a" };
    const second: ProviderEntry = { provider: "azure", model: "gpt-4o-mini", api_key_ref: "key-b" };
    const { connections, nameFor } = hoistProviderConnections(
      config({ quick: { providers: [first, second] } })
    );

    expect(nameFor(first)).toBe("azure");
    expect(nameFor(second)).toBe("azure-2");
    expect(connections.azure?.api_key_ref).toBe("key-a");
    expect(connections["azure-2"]?.api_key_ref).toBe("key-b");
  });

  it("reuses one connection when the same credentials appear in several tiers", () => {
    const shared: ProviderEntry = { provider: "acme", model: "m", api_key_ref: "shared" };
    const { connections, nameFor } = hoistProviderConnections(
      config({
        quick: { providers: [shared] },
        standard: { providers: [{ ...shared, model: "other" }] },
        complex: { providers: [{ ...shared, model: "third" }] },
      })
    );

    expect(Object.keys(connections)).toEqual(["acme"]);
    expect(nameFor({ ...shared, model: "other" })).toBe("acme");
  });

  it("yields no connections for a config that has already migrated off tiers", () => {
    expect(hoistProviderConnections({}).connections).toEqual({});
  });
});

describe("deriveModelProfiles — connections", () => {
  it("points every derived profile at the connection holding its credentials", () => {
    const first: ProviderEntry = { provider: "azure", model: "gpt-4o", api_key_ref: "key-a" };
    const second: ProviderEntry = { provider: "azure", model: "gpt-4o-mini", api_key_ref: "key-b" };
    const derived = deriveModelProfiles(config({ quick: { providers: [first, second] } }));

    expect(derived.find((p) => p.profileId === "fast")?.connection).toBe("azure");
    expect(derived.find((p) => p.profileId === "fast-fallback-1")?.connection).toBe("azure-2");
  });
});
