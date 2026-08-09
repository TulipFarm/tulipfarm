import { type LlmConfig, MODEL_PROFILE_DEFINITION, SchemaRegistry } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  derivedModelProfileId,
  isGeneratedModelProfile,
  modelProfileDocuments,
} from "./model-profile-documents";

const config = {
  tiers: {
    quick: { providers: [{ provider: "openai", model: "gpt-fast" }] },
    standard: {
      providers: [
        { provider: "openai", model: "gpt-balanced" },
        { provider: "anthropic", model: "claude-balanced" },
      ],
    },
    complex: { providers: [{ provider: "openai", model: "gpt-thorough" }] },
  },
} satisfies LlmConfig;

describe("modelProfileDocuments", () => {
  it("synthesizes schema-valid deterministic bundle documents with the full fallback chain", () => {
    const registry = new SchemaRegistry([MODEL_PROFILE_DEFINITION]);
    const first = modelProfileDocuments(config);
    const second = modelProfileDocuments(config);

    expect(second).toEqual(first);
    expect(first.map((document) => document.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: derivedModelProfileId("balanced"), slug: "balanced" }),
      ])
    );
    expect(
      first.find(
        (document) =>
          (document.metadata as Record<string, unknown> | undefined)?.slug === "balanced"
      )?.spec
    ).toMatchObject({
      fallbacks: ["balanced-fallback-1"],
    });
    for (const document of first) expect(() => registry.validate(document)).not.toThrow();
  });

  it("recognizes only the exact metadata fingerprint of retired generated files", () => {
    const published = modelProfileDocuments(config)[0];
    if (published === undefined) throw new Error("expected profile");
    const generated = structuredClone(published);
    (generated.metadata as Record<string, unknown>).lifecycle = "draft";

    const genMeta = generated.metadata as Record<string, unknown>;
    const pubMeta = published.metadata as Record<string, unknown>;
    expect(isGeneratedModelProfile(generated, genMeta.slug as string)).toBe(true);
    expect(isGeneratedModelProfile(published, pubMeta.slug as string)).toBe(false);
    expect(isGeneratedModelProfile(generated, "different-slug")).toBe(false);
  });
});
