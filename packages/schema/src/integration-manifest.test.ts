import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TulipFarmValidationError } from "./error";
import { validateLegacyIntegrationManifest } from "./integration-manifest";
import { oimPackageIssues, parseOimFixtureSuite, parseOimManifest } from "./oim";

const INTEGRATIONS_DIR = join(import.meta.dirname, "../../../integrations");
const SUPPORTED_ENTRYPOINTS = ["manifest.yml", "oim.yml"] as const;

// Enumerated, never hardcoded: a hardcoded list lets a newly added integration pass by simply
// never being tested, which is the failure this suite exists to prevent.
const FIXTURES = readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    entrypoints: readdirSync(join(INTEGRATIONS_DIR, entry.name)),
    slug: entry.name,
  }))
  .sort((left, right) => left.slug.localeCompare(right.slug));

const LEGACY_FIXTURES = FIXTURES.filter(({ entrypoints }) => entrypoints.includes("manifest.yml"));
const OIM_FIXTURES = FIXTURES.filter(({ entrypoints }) => entrypoints.includes("oim.yml"));

function hasSupportedEntrypoint(entrypoints: readonly string[]): boolean {
  return SUPPORTED_ENTRYPOINTS.some((entrypoint) => entrypoints.includes(entrypoint));
}

function fixtureManifest(slug: string): unknown {
  return parse(readFileSync(join(INTEGRATIONS_DIR, slug, "manifest.yml"), "utf8"));
}

function validateOimPackage(source: string, readCompanion: (path: string) => string) {
  const manifest = parseOimManifest(source);
  const files = new Map(
    (manifest.files ?? []).map((file) => [file.path, readCompanion(file.path)])
  );
  for (const file of manifest.files ?? []) {
    if (file.role === "fixture") parseOimFixtureSuite(files.get(file.path) ?? "");
  }
  return { manifest, issues: oimPackageIssues(manifest, files) };
}

describe("bundled integration manifests", () => {
  it("finds the shipped integrations to validate", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  it.each(FIXTURES)("finds a supported entry point for $slug", ({ entrypoints }) => {
    expect(hasSupportedEntrypoint(entrypoints)).toBe(true);
  });

  it.each(LEGACY_FIXTURES)("accepts the $slug fixture manifest", ({ slug }) => {
    expect(validateLegacyIntegrationManifest(fixtureManifest(slug))).toMatchObject({
      name: slug,
    });
  });

  it.each(OIM_FIXTURES)("accepts the $slug OIM package", ({ slug }) => {
    const directory = join(INTEGRATIONS_DIR, slug);
    const result = validateOimPackage(readFileSync(join(directory, "oim.yml"), "utf8"), (path) =>
      readFileSync(join(directory, path), "utf8")
    );

    expect(result).toMatchObject({
      manifest: { metadata: { id: slug } },
      issues: [],
    });
  });

  it("recognizes an OIM-only package without accepting an unknown entry point", () => {
    expect(hasSupportedEntrypoint(["oim.yml"])).toBe(true);
    expect(hasSupportedEntrypoint(["README.md"])).toBe(false);
    expect(
      validateOimPackage(
        `
oimVersion: "1.0"
kind: Integration
metadata:
  id: weather
  name: Weather
  version: 1.0.0
  description: Read current weather.
  license: Apache-2.0
profiles: { core: "1.0" }
operations:
  - id: current-weather
    name: current_weather
    description: Read current weather.
    effect: read
    identityMode: shared_only
    source:
      type: http
      method: GET
      baseUrl: https://api.weather.example
      path: /v1/current
    response:
      schema: { type: object }
      maxBytes: 16384
`,
        () => {
          throw new Error("the fixture declares no companion files");
        }
      )
    ).toMatchObject({
      manifest: { metadata: { id: "weather" } },
      issues: [],
    });
  });

  it("accepts a minimal manifest consumed by the loader", () => {
    expect(
      validateLegacyIntegrationManifest({
        name: "github",
        egress: {
          type: "mcp",
          entry: {
            transport: "stdio",
            command: "echo",
          },
        },
      })
    ).toMatchObject({ name: "github", egress: { type: "mcp" } });
  });

  it("accepts only explicit user-configured Knowledge setup", () => {
    expect(
      validateLegacyIntegrationManifest({
        name: "slack",
        egress: { type: "none" },
        knowledge: {
          mode: "user_configured",
          automatic_indexing: false,
          source_tools: ["slack_message_history"],
          write_tools: ["create_knowledge_page"],
        },
      })
    ).toMatchObject({
      knowledge: { mode: "user_configured", automatic_indexing: false },
    });

    expect(() =>
      validateLegacyIntegrationManifest({
        name: "slack",
        egress: { type: "none" },
        knowledge: {
          mode: "user_configured",
          automatic_indexing: true,
          source_tools: ["slack_message_history"],
          write_tools: ["create_knowledge_page"],
        },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects a manifest without the required egress type", () => {
    expect(() =>
      validateLegacyIntegrationManifest({
        name: "github",
        egress: {},
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("reports the malformed field path", () => {
    try {
      validateLegacyIntegrationManifest({
        name: "github",
        egress: {
          type: "openapi",
          spec: 42,
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(TulipFarmValidationError);
      expect((error as TulipFarmValidationError).path).toContain("/egress");
      return;
    }
    throw new Error("expected validation to fail");
  });
});
