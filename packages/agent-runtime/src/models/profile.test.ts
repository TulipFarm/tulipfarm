import { describe, expect, it } from "vitest";
import {
  type ModelProfileCatalog,
  type ModelRequirements,
  type RoutableModelProfile,
  selectModelProfile,
} from "./profile";

function profile(overrides: Partial<RoutableModelProfile> = {}): RoutableModelProfile {
  return {
    profileId: "primary",
    provider: "acme",
    model: "acme-1",
    reasoning: "high",
    supports: { tools: true, structuredOutput: true, contextWindowTokens: 100_000 },
    constraints: {
      dataRetention: "zero_retention",
      allowTraining: false,
      residency: "eu",
      maxCostUsd: 1,
      maxTokens: 50_000,
      maxLatencyMs: 5_000,
    },
    fallbacks: [],
    allowCaching: true,
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
  estimatedContextTokens: 10_000,
  estimatedCostUsd: 0.5,
  sensitive: false,
  allowTraining: false,
  residency: "eu",
  dataRetention: "zero_retention",
};

describe("selectModelProfile", () => {
  it("selects a profile that meets every capability, data, residency, and budget constraint", () => {
    const selection = selectModelProfile("primary", requirements, catalog(profile()));

    expect(selection).toMatchObject({
      outcome: "selected",
      profileId: "primary",
      cacheAllowed: true,
    });
    if (selection.outcome !== "selected") throw new Error("expected selection");
    expect(selection.chain.map((entry) => entry.profileId)).toEqual(["primary"]);
  });

  it("denies an unknown profile instead of inventing a default", () => {
    expect(selectModelProfile("missing", requirements, catalog())).toEqual({
      outcome: "denied",
      profileId: "missing",
      reason: "unknown_profile",
      attempts: [{ profileId: "missing", reason: "unknown_profile" }],
    });
  });

  it.each([
    [
      "tool support",
      profile({ supports: { tools: false, structuredOutput: true, contextWindowTokens: 100_000 } }),
      "tools_unsupported",
    ],
    [
      "structured output",
      profile({ supports: { tools: true, structuredOutput: false, contextWindowTokens: 100_000 } }),
      "structured_output_unsupported",
    ],
    [
      "context window",
      profile({ supports: { tools: true, structuredOutput: true, contextWindowTokens: 1_000 } }),
      "context_window_exceeded",
    ],
    [
      "residency",
      profile({ constraints: { residency: "us", dataRetention: "zero_retention" } }),
      "residency_violation",
    ],
    [
      "data retention",
      profile({ constraints: { residency: "eu", dataRetention: "provider_default" } }),
      "data_retention_violation",
    ],
    [
      "training",
      profile({
        constraints: { residency: "eu", dataRetention: "zero_retention", allowTraining: true },
      }),
      "training_not_permitted",
    ],
    [
      "cost budget",
      profile({
        constraints: { residency: "eu", dataRetention: "zero_retention", maxCostUsd: 0.1 },
      }),
      "cost_budget_exceeded",
    ],
    [
      "token budget",
      profile({
        constraints: { residency: "eu", dataRetention: "zero_retention", maxTokens: 100 },
      }),
      "token_budget_exceeded",
    ],
  ])("denies on %s without falling back to a weaker profile", (_label, candidate, reason) => {
    const selection = selectModelProfile("primary", requirements, catalog(candidate));

    expect(selection).toMatchObject({ outcome: "denied", reason });
  });

  it("denies a latency ceiling above the requested maximum", () => {
    const selection = selectModelProfile(
      "primary",
      { ...requirements, maxLatencyMs: 1_000 },
      catalog(profile())
    );

    expect(selection).toMatchObject({ outcome: "denied", reason: "latency_budget_exceeded" });
  });

  it("denies a capability class the requester did not ask for", () => {
    const selection = selectModelProfile(
      "primary",
      { ...requirements, requiredCapabilityClass: "vision" },
      catalog(profile({ capabilityClass: "text" }))
    );

    expect(selection).toMatchObject({ outcome: "denied", reason: "capability_class_mismatch" });
  });

  it("keeps caching off for sensitive work even when the profile permits it", () => {
    const selection = selectModelProfile(
      "primary",
      { ...requirements, sensitive: true },
      catalog(profile({ allowCaching: true }))
    );

    expect(selection).toMatchObject({ outcome: "selected", cacheAllowed: false });
  });

  it("keeps only fallbacks that satisfy the same constraints, in declared order", () => {
    const selection = selectModelProfile(
      "primary",
      requirements,
      catalog(
        profile({ fallbacks: ["weak", "peer"] }),
        profile({
          profileId: "weak",
          supports: { tools: false, structuredOutput: true, contextWindowTokens: 100_000 },
        }),
        profile({ profileId: "peer", provider: "local", model: "llama" })
      )
    );

    if (selection.outcome !== "selected") throw new Error("expected selection");
    expect(selection.chain.map((entry) => entry.profileId)).toEqual(["primary", "peer"]);
    expect(selection.rejectedFallbacks).toEqual([
      { profileId: "weak", reason: "tools_unsupported" },
    ]);
  });

  it("stops a fallback cycle instead of looping", () => {
    const selection = selectModelProfile(
      "primary",
      requirements,
      catalog(
        profile({ fallbacks: ["peer"] }),
        profile({ profileId: "peer", fallbacks: ["primary"] })
      )
    );

    if (selection.outcome !== "selected") throw new Error("expected selection");
    expect(selection.chain.map((entry) => entry.profileId)).toEqual(["primary", "peer"]);
  });

  it("denies a fallback the catalog does not publish", () => {
    const selection = selectModelProfile(
      "primary",
      requirements,
      catalog(profile({ fallbacks: ["ghost"] }))
    );

    if (selection.outcome !== "selected") throw new Error("expected selection");
    expect(selection.rejectedFallbacks).toEqual([
      { profileId: "ghost", reason: "unknown_profile" },
    ]);
  });
});
