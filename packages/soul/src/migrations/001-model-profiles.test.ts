import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFINITION_REGISTRATIONS, SchemaRegistry } from "@tulipfarm/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { migrateTiersToModelProfiles } from "./001-model-profiles";

const TMP = join(import.meta.dirname, "__model_profile_migration_tmp__");
const registry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

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

async function readProfile(slug: string): Promise<Record<string, unknown>> {
  return parseYaml(await readFile(join(TMP, "models", `${slug}.yaml`), "utf8"));
}

beforeEach(() => mkdir(TMP, { recursive: true }));
afterEach(() => rm(TMP, { recursive: true, force: true }));

describe("migrateTiersToModelProfiles", () => {
  it("writes one ModelProfile per configured model", async () => {
    await writeManifest({ llm: { tiers: TIERS } });
    await migrateTiersToModelProfiles(TMP);

    expect((await readdir(join(TMP, "models"))).sort()).toEqual([
      "balanced-fallback-1.yaml",
      "balanced.yaml",
      "fast.yaml",
      "thorough.yaml",
    ]);
  });

  it("emits profiles the real ModelProfile schema accepts", async () => {
    // The migration is worthless if it writes files the loader then refuses to parse.
    await writeManifest({ llm: { tiers: TIERS } });
    await migrateTiersToModelProfiles(TMP);

    for (const slug of ["fast", "balanced", "balanced-fallback-1", "thorough"]) {
      const source = await readFile(join(TMP, "models", `${slug}.yaml`), "utf8");
      expect(() => registry.validateYaml(source)).not.toThrow();
    }
  });

  it("chains the rest of a tier as fallbacks so no configured provider is inert", async () => {
    await writeManifest({ llm: { tiers: TIERS } });
    await migrateTiersToModelProfiles(TMP);

    const balanced = (await readProfile("balanced")).spec as { fallbacks?: string[] };
    expect(balanced.fallbacks).toEqual(["balanced-fallback-1"]);
  });

  it("hoists credentials into connections and points profiles at them", async () => {
    await writeManifest({ llm: { tiers: TIERS } });
    await migrateTiersToModelProfiles(TMP);

    const llm = (await readManifest()).llm as {
      connections: Record<string, { provider: string; api_key_ref?: string }>;
    };
    expect(llm.connections.azure).toEqual({
      provider: "azure",
      api_key_ref: "azure-key",
      resource_name: "main",
    });

    const fallback = (await readProfile("balanced-fallback-1")).spec as { connection: string };
    expect(fallback.connection).toBe("azure");
  });

  it("writes a preset map whose default points at a profile that exists", async () => {
    await writeManifest({ llm: { tiers: TIERS } });
    await migrateTiersToModelProfiles(TMP);

    const llm = (await readManifest()).llm as { presets: Record<string, string> };
    expect(llm.presets).toEqual({
      default: "balanced",
      fast: "fast",
      balanced: "balanced",
      thorough: "thorough",
    });
  });

  it("leaves tiers in place so a rollback still has its configuration", async () => {
    await writeManifest({ llm: { tiers: TIERS } });
    await migrateTiersToModelProfiles(TMP);

    expect((await readManifest()).llm).toHaveProperty("tiers");
  });

  it("never overwrites presets an operator already authored", async () => {
    await writeManifest({ llm: { tiers: TIERS, presets: { default: "thorough" } } });
    await migrateTiersToModelProfiles(TMP);

    const llm = (await readManifest()).llm as { presets: Record<string, string> };
    expect(llm.presets.default).toBe("thorough");
  });

  it("is idempotent — a second run reproduces byte-identical output", async () => {
    await writeManifest({ llm: { tiers: TIERS } });
    await migrateTiersToModelProfiles(TMP);
    const first = await readFile(join(TMP, "models", "balanced.yaml"), "utf8");
    const firstManifest = await readFile(join(TMP, "soul.yaml"), "utf8");

    await migrateTiersToModelProfiles(TMP);

    expect(await readFile(join(TMP, "models", "balanced.yaml"), "utf8")).toBe(first);
    expect(await readFile(join(TMP, "soul.yaml"), "utf8")).toBe(firstManifest);
  });

  it("no-ops on a Soul that has no llm config at all", async () => {
    await writeManifest({ businessName: "Acme" });
    await migrateTiersToModelProfiles(TMP);

    await expect(readdir(join(TMP, "models"))).rejects.toThrow();
  });

  it("no-ops when soul.yaml is absent rather than creating one", async () => {
    await migrateTiersToModelProfiles(TMP);

    await expect(readFile(join(TMP, "soul.yaml"), "utf8")).rejects.toThrow();
  });
});
