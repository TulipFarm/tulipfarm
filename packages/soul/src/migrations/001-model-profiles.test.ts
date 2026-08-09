import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { normalizeLlmConfig } from "./001-model-profiles";

const TMP = join(import.meta.dirname, "__model_profile_migration_tmp__");

const TIERS = {
  quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
  standard: {
    providers: [
      { provider: "anthropic", model: "claude-sonnet-4-6", api_key_ref: "anthropic-key" },
      { provider: "azure", model: "gpt-4o", api_key_ref: "azure-key", resource_name: "main" },
    ],
  },
  complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
};

async function writeManifest(manifest: Record<string, unknown>) {
  await writeFile(join(TMP, "soul.yaml"), stringifyYaml(manifest), "utf8");
}

async function readManifest(): Promise<Record<string, unknown>> {
  return parseYaml(await readFile(join(TMP, "soul.yaml"), "utf8"));
}

beforeEach(() => mkdir(TMP, { recursive: true }));
afterEach(() => rm(TMP, { recursive: true, force: true }));

describe("normalizeLlmConfig", () => {
  it("keeps all model configuration in soul.yaml and never creates models files", async () => {
    await writeManifest({ llm: { tiers: TIERS } });

    await normalizeLlmConfig(TMP);

    await expect(readdir(join(TMP, "models"))).rejects.toMatchObject({ code: "ENOENT" });
    const llm = (await readManifest()).llm as Record<string, unknown>;
    expect(llm).toHaveProperty("tiers");
  });

  it("hoists credentials into Provider Connections", async () => {
    await writeManifest({ llm: { tiers: TIERS } });
    await normalizeLlmConfig(TMP);

    const llm = (await readManifest()).llm as {
      connections: Record<string, { provider: string; api_key_ref?: string }>;
    };
    expect(llm.connections.azure).toEqual({
      provider: "azure",
      api_key_ref: "azure-key",
      resource_name: "main",
    });
  });

  it("writes Effort Presets whose targets are derived from configured chains", async () => {
    await writeManifest({ llm: { tiers: TIERS } });
    await normalizeLlmConfig(TMP);

    const llm = (await readManifest()).llm as { presets: Record<string, string> };
    expect(llm.presets).toEqual({
      default: "balanced",
      fast: "fast",
      balanced: "balanced",
      thorough: "thorough",
    });
  });

  it("preserves Effort Presets an operator already configured", async () => {
    await writeManifest({ llm: { tiers: TIERS, presets: { default: "thorough" } } });
    await normalizeLlmConfig(TMP);

    const llm = (await readManifest()).llm as { presets: Record<string, string> };
    expect(llm.presets.default).toBe("thorough");
  });

  it("is byte-idempotent", async () => {
    await writeManifest({ llm: { tiers: TIERS } });
    await normalizeLlmConfig(TMP);
    const first = await readFile(join(TMP, "soul.yaml"), "utf8");

    await normalizeLlmConfig(TMP);

    expect(await readFile(join(TMP, "soul.yaml"), "utf8")).toBe(first);
  });

  it("no-ops when the manifest or LLM config is absent", async () => {
    await normalizeLlmConfig(TMP);
    await expect(readFile(join(TMP, "soul.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeManifest({ businessName: "Acme" });
    const before = await readFile(join(TMP, "soul.yaml"), "utf8");
    await normalizeLlmConfig(TMP);
    expect(await readFile(join(TMP, "soul.yaml"), "utf8")).toBe(before);
  });
});
