import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TulipFarmValidationError } from "./error";
import { validateLegacyIntegrationManifest } from "./integration-manifest";

const INTEGRATIONS_DIR = join(import.meta.dirname, "../../../integrations");

// Enumerated, never hardcoded: a hardcoded list lets a newly added integration pass by simply
// never being tested, which is the failure this suite exists to prevent.
// An OIM package declares itself in `oim.yml` and is validated by the OIM suite instead, so the
// filter is on what a directory declares rather than on a list a new integration could dodge.
const FIXTURES = readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((slug) => existsSync(join(INTEGRATIONS_DIR, slug, "manifest.yml")))
  .sort();

function fixtureManifest(slug: string): unknown {
  return parse(readFileSync(join(INTEGRATIONS_DIR, slug, "manifest.yml"), "utf8"));
}

describe("validateLegacyIntegrationManifest", () => {
  it("finds the shipped integrations to validate", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  it.each(FIXTURES)("accepts the %s fixture manifest", (slug) => {
    expect(validateLegacyIntegrationManifest(fixtureManifest(slug))).toMatchObject({
      name: slug,
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
