import type { LlmConfig } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { agentDocumentFromLegacy, defaultModelProfile } from "./agent-documents";

function specOf(content: string): Record<string, unknown> {
  const document = agentDocumentFromLegacy("joke-bot", content, "balanced", "AGENT.md");
  if (document === undefined) throw new Error("expected a projected Agent document");
  return document.spec as Record<string, unknown>;
}

describe("agentDocumentFromLegacy", () => {
  it("carries the body as the personality a Routine Agent State puts before the model", () => {
    expect(specOf("---\nlabel: Joke Bot\n---\nPost one short joke.\n")).toMatchObject({
      personality: "Post one short joke.",
      instructions: { path: "AGENT.md" },
    });
  });

  it("maps every Chat autonomy onto the canonical ceiling it means", () => {
    const ceiling = (autonomy: string) =>
      specOf(`---\nautonomy: ${autonomy}\n---\nbody\n`).autonomy;

    expect(ceiling("full")).toBe("execute_policy_authorized");
    expect(ceiling("supervised")).toBe("execute_low_risk");
    expect(ceiling("approval-required")).toBe("propose_actions");
    expect(ceiling("manual")).toBe("answer_only");
  });

  it("names a ceiling even when the Agent declares no autonomy", () => {
    expect(specOf("no frontmatter at all\n").autonomy).toBe("execute_low_risk");
  });

  it("keeps the authored model policy, which governs what may serve the turn", () => {
    const content = "---\nmodelPolicy:\n  dataRetention: none\n---\nbody\n";

    expect(specOf(content).modelPolicy).toEqual({ dataRetention: "none" });
  });

  it("omits personality rather than claiming an empty persona", () => {
    expect(specOf("---\nlabel: Joke Bot\n---\n\n")).not.toHaveProperty("personality");
  });

  // A projection that cannot validate must not fail the publication of the whole tree.
  it("declines a slug the definition envelope cannot carry", () => {
    expect(agentDocumentFromLegacy("Not A Slug", "body\n", "balanced", "AGENT.md")).toBeUndefined();
  });
});

type Providers = NonNullable<LlmConfig["tiers"]>["quick"]["providers"];

/** `LlmConfig` requires every tier; only the `quick` tier's providers vary across these Cases. */
function tiers(quick: Providers): NonNullable<LlmConfig["tiers"]> {
  return { quick: { providers: quick }, standard: { providers: [] }, complex: { providers: [] } };
}

describe("defaultModelProfile", () => {
  // `spec.modelProfile` is required, so a Soul with no derived profile must project no Agent at
  // all — naming one anyway would make every Agent an unresolved reference and fail publication of
  // the whole tree, which is the state a freshly scaffolded Soul is in.
  it("names no profile when the Soul configures no LLM", () => {
    expect(defaultModelProfile(undefined)).toBeUndefined();
    expect(defaultModelProfile({})).toBeUndefined();
    expect(defaultModelProfile({ tiers: tiers([]) })).toBeUndefined();
  });

  it("uses the Soul's own default Effort Preset when its tier is configured", () => {
    const profile = defaultModelProfile({
      tiers: tiers([{ provider: "anthropic", model: "claude-opus-5" }]),
      presets: { default: "fast" },
    });

    expect(profile).toBe("fast");
  });
});
