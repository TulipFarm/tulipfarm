import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOimOpenApiOperations,
} from "@tulipfarm/integrations";
import {
  type OimManifest,
  oimPackageIssues,
  parseOimFixtureSuite,
  parseOimManifest,
} from "@tulipfarm/schema";
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

interface LegacyEntry {
  readonly slug: string;
  readonly manifest: IntegrationManifest;
  readonly spec?: unknown;
  readonly env: string[];
}

interface OimEntry {
  readonly slug: string;
  readonly manifest: OimManifest;
  readonly companions: ReadonlyMap<string, string>;
}

/** Compile every shipped Integration manifest so missing operations and invalid auth fail here. */
describe("bundled integrations", () => {
  let packages: { slug: string; entrypoints: string[] }[];
  let legacyEntries: LegacyEntry[];
  let oimEntries: OimEntry[];

  beforeAll(async () => {
    const dir = bundledIntegrationsDir();
    packages = await Promise.all(
      (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => ({
          slug: entry.name,
          entrypoints: await readdir(join(dir, entry.name)),
        }))
    );
    packages.sort((left, right) => left.slug.localeCompare(right.slug));

    for (const { slug, entrypoints } of packages) {
      if (!entrypoints.includes("manifest.yml") && !entrypoints.includes("oim.yml")) {
        throw new Error(`${slug} has no supported integration entrypoint`);
      }
    }

    legacyEntries = await Promise.all(
      packages
        .filter(({ entrypoints }) => entrypoints.includes("manifest.yml"))
        .map(async ({ slug }) => {
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

    oimEntries = await Promise.all(
      packages
        .filter(({ entrypoints }) => entrypoints.includes("oim.yml"))
        .map(async ({ slug }) => {
          const manifest = parseOimManifest(await readFile(join(dir, slug, "oim.yml"), "utf8"));
          const companions = new Map<string, string>();
          for (const file of manifest.files ?? []) {
            companions.set(file.path, await readFile(join(dir, slug, file.path), "utf8"));
          }
          return { slug, manifest, companions };
        })
    );
  });

  it("finds the integrations that ship in this repo", () => {
    expect(packages.length).toBeGreaterThan(0);
    expect(legacyEntries.length).toBeGreaterThan(0);
    expect(oimEntries.length).toBeGreaterThan(0);
  });

  it("declares a connect flow the loader accepts", () => {
    for (const { slug, manifest } of legacyEntries) {
      expect(validateAuthSteps(manifest), slug).toEqual([]);
      expect(validateIngressContextEnv(manifest), slug).toEqual([]);
    }
  });

  it("compiles every declared operation, with connection env the flow actually collects", () => {
    for (const entry of legacyEntries) {
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

  it("validates and compiles every OIM package", () => {
    for (const { slug, manifest, companions } of oimEntries) {
      expect(manifest.metadata.id, slug).toBe(slug);
      expect(oimPackageIssues(manifest, companions), slug).toEqual([]);
      for (const file of manifest.files ?? []) {
        if (file.role === "fixture") {
          expect(() => parseOimFixtureSuite(companions.get(file.path) ?? ""), slug).not.toThrow();
        }
      }

      const documents = new Map<string, unknown>();
      for (const file of (manifest.files ?? []).filter(
        (candidate) => candidate.role === "openapi"
      )) {
        const source = companions.get(file.path);
        if (source !== undefined) documents.set(file.path, parseYaml(source));
      }
      const compiled = [
        ...compileOimHttpOperations(manifest, {}, { deferConfiguration: true }),
        ...compileOimGraphqlOperations(manifest, companions, {}, { deferConfiguration: true }),
        ...compileOimOpenApiOperations(manifest, documents, {}, { deferConfiguration: true }),
      ];
      expect(compiled.length, slug).toBe(manifest.operations.length);
      expect(compiled.map((tool) => tool.operation.id).sort(), slug).toEqual(
        manifest.operations.map((operation) => operation.id).sort()
      );
    }
  });

  it("names every published Tool for what it does, not for the endpoint it calls", () => {
    for (const entry of legacyEntries) {
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
    for (const { slug, manifest } of legacyEntries) {
      if (manifest.setup_guide_path === undefined) continue;
      await expect(
        readFile(join(dir, slug, manifest.setup_guide_path), "utf8"),
        slug
      ).resolves.toBeTruthy();
    }
    for (const { slug, manifest, companions } of oimEntries) {
      for (const file of (manifest.files ?? []).filter((candidate) => candidate.role === "guide")) {
        expect(companions.get(file.path), `${slug}/${file.path}`).toBeTruthy();
      }
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
