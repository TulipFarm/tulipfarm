import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationManifest, SoulIntegration } from "@tulipfarm/soul";
import {
  bundledIntegrationsDir,
  validateAuthSteps,
  validateIngressContextEnv,
} from "@tulipfarm/soul";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildDeclarativeTools } from "./tools";

/** Compile every shipped Integration manifest so missing operations and invalid auth fail here. */
describe("bundled integrations", () => {
  let entries: { slug: string; manifest: IntegrationManifest; spec?: unknown; env: string[] }[];

  beforeAll(async () => {
    const dir = bundledIntegrationsDir();
    const slugs = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    entries = await Promise.all(
      slugs.map(async (slug) => {
        const manifest = parseYaml(
          await readFile(join(dir, slug, "manifest.yml"), "utf8")
        ) as IntegrationManifest;
        const egress = manifest.egress;
        const spec =
          egress?.type === "openapi"
            ? parseYaml(await readFile(join(dir, slug, egress.spec), "utf8"))
            : undefined;
        return { slug, manifest, spec, env: declaredEnv(manifest) };
      })
    );
  });

  it("finds the integrations that ship in this repo", () => {
    expect(entries.map((entry) => entry.slug)).toEqual([
      "confluence",
      "github",
      "google",
      "google-docs",
      "google-drive",
      "jira",
      "notion",
      "slack",
      "telegram",
    ]);
  });

  it("declares a connect flow the loader accepts", () => {
    for (const { slug, manifest } of entries) {
      expect(validateAuthSteps(manifest), slug).toEqual([]);
      expect(validateIngressContextEnv(manifest), slug).toEqual([]);
    }
  });

  it("compiles every declared operation, with connection env the flow actually collects", () => {
    for (const entry of entries) {
      if (entry.manifest.egress?.type !== "openapi") continue;
      // Placeholder every declared var; uncollected `base_url` vars must fail here.
      const env = Object.fromEntries(entry.env.map((name) => [name, "placeholder"]));
      const { tools, problems } = buildDeclarativeTools(
        [
          {
            slug: entry.slug,
            sourceIntegration: entry.slug,
            manifest: entry.manifest,
            egressSpec: entry.spec,
            connection: { enabled: true, env },
          } as SoulIntegration,
        ],
        {
          businessId: "biz",
          effects: new MemoryEffectStore(),
          secrets: async () => ({}) as SecretsService,
          http: { send: async () => ({ status: 200, headers: {}, body: {} }) },
        }
      );

      expect(problems, entry.slug).toEqual([]);
      expect(tools.length, entry.slug).toBe(entry.manifest.egress.operations?.length ?? 0);
    }
  });

  it("names every published Tool for what it does, not for the endpoint it calls", () => {
    for (const entry of entries) {
      for (const operation of entry.manifest.egress?.type === "openapi"
        ? (entry.manifest.egress.operations ?? [])
        : []) {
        // The model picks Tools by description; empty or one-word descriptions make Tools unused.
        expect(
          operation.description?.length ?? 0,
          `${entry.slug}.${operation.name}`
        ).toBeGreaterThan(40);
      }
    }
  });

  it("ships a setup guide wherever the manifest promises one", async () => {
    const dir = bundledIntegrationsDir();
    for (const { slug, manifest } of entries) {
      if (manifest.setup_guide_path === undefined) continue;
      await expect(
        readFile(join(dir, slug, manifest.setup_guide_path), "utf8"),
        slug
      ).resolves.toBeTruthy();
    }
  });
});

/** Every env var name the connect flow collects, across all step kinds. */
function declaredEnv(manifest: IntegrationManifest): string[] {
  const names = (manifest.required_env ?? []).map((entry) => entry.name);
  for (const step of manifest.auth ?? []) {
    if (step.kind === "fields") names.push(...step.fields.map((field) => field.name));
    if (step.kind === "oauth2") {
      names.push(step.token_env, ...Object.values(step.map ?? {}));
    }
    if (step.kind === "webhook") {
      if (step.secret_env) names.push(step.secret_env);
      names.push(...Object.values(step.map ?? {}));
    }
    if (step.kind === "install") names.push(...Object.values(step.capture ?? {}));
    if (step.kind === "app_manifest") names.push(...Object.values(step.exchange?.map ?? {}));
  }
  return names;
}
