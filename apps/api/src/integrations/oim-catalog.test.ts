import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SoulIntegration } from "@tulipfarm/soul";
import { afterEach, describe, expect, it } from "vitest";
import {
  activatedOimIntegrations,
  loadBundledOimCatalog,
  unifiedOimPackageCatalog,
} from "./oim-catalog";

const root = join(process.cwd(), ".oim-catalog-test");

afterEach(() => rm(root, { recursive: true, force: true }));

async function writePackage(directory: string, id = directory): Promise<void> {
  const packageRoot = join(root, directory);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "oim.yml"),
    `oimVersion: "1.0"
kind: Integration
metadata:
  id: ${id}
  name: Test
  version: 1.0.0
  description: Read test data.
  license: Apache-2.0
profiles:
  core: "1.0"
operations:
  - id: read
    name: test_read
    description: Read test data.
    effect: read
    identityMode: shared_only
    source:
      type: http
      method: GET
      baseUrl: https://api.example.test
      path: /read
    response:
      schema: { type: object }
      maxBytes: 4096
`,
    "utf8"
  );
}

describe("loadBundledOimCatalog", () => {
  it("loads exact validated packages in stable key order", async () => {
    await writePackage("zeta");
    await writePackage("alpha");
    await mkdir(join(root, "legacy"), { recursive: true });
    await writeFile(join(root, "legacy", "manifest.yml"), "name: legacy\n", "utf8");

    const catalog = await loadBundledOimCatalog(root);

    expect(catalog.map((entry) => entry.key)).toEqual(["alpha", "zeta"]);
    expect(catalog[0]?.packageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog[0]?.integration).toMatchObject({
      slug: "alpha",
      sourceIntegration: "alpha",
      oimManifest: { metadata: { id: "alpha" } },
    });
  });

  describe("activatedOimIntegrations", () => {
    it("excludes untrusted Soul OIM packages while preserving legacy and trusted packages", async () => {
      await writePackage("bundled");
      const bundled = await loadBundledOimCatalog(root);
      const legacy = { slug: "legacy" } as SoulIntegration;
      const untrusted = {
        slug: "untrusted",
        oimManifest: bundled[0]?.manifest,
      } as SoulIntegration;
      const trusted = {
        slug: "trusted",
        oimManifest: {
          ...bundled[0]?.manifest,
          metadata: { ...bundled[0]?.manifest.metadata, id: "trusted" },
        },
      } as SoulIntegration;

      const activated = activatedOimIntegrations(
        bundled,
        new Map([
          ["legacy", legacy],
          ["untrusted", untrusted],
        ]),
        new Map([["trusted", trusted]])
      );

      expect([...activated.keys()]).toEqual(["bundled", "legacy", "trusted"]);
      expect(activated.get("trusted")).toBe(trusted);
    });

    it("adds a trusted installed release to the package catalog", async () => {
      await writePackage("weather");
      const bundled = await loadBundledOimCatalog(root);
      const installed = {
        ...bundled[0]?.integration,
        slug: "weather-v2",
        oimManifest: {
          ...bundled[0]?.manifest,
          metadata: { ...bundled[0]?.manifest.metadata, version: "2.0.0" },
        },
      } as SoulIntegration;

      const unified = unifiedOimPackageCatalog(bundled, new Map([["weather-v2", installed]]));

      expect(unified).toHaveLength(2);
      expect(unified[1]).toMatchObject({
        key: "weather-v2",
        manifest: { metadata: { version: "2.0.0" } },
        packageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });

    it("rejects a trusted package that claims a bundled Integration identity at another slug", async () => {
      await writePackage("weather");
      const [bundled] = await loadBundledOimCatalog(root);
      if (bundled === undefined) throw new Error("missing bundled fixture");
      const installed = {
        ...bundled.integration,
        slug: "community-weather",
      };

      expect(() =>
        unifiedOimPackageCatalog([bundled], new Map([["community-weather", installed]]))
      ).toThrow('duplicate OIM package identity weather@1: "weather" and "community-weather"');
    });
  });

  it("rejects a package whose directory can impersonate another catalog key", async () => {
    await writePackage("expected", "different");

    await expect(loadBundledOimCatalog(root)).rejects.toThrow(
      "bundled OIM directory expected does not match different"
    );
  });

  it("can expose only packages with provider verification", async () => {
    await writePackage("unverified");

    await expect(loadBundledOimCatalog(root, { requireVerification: true })).resolves.toEqual([]);
  });

  it("publishes only the bundled packages with grounded provider verification", async () => {
    const catalog = await loadBundledOimCatalog(join(process.cwd(), "../../integrations"), {
      requireVerification: true,
    });

    expect(catalog.map((entry) => entry.key)).toEqual([
      "asana",
      "clickup",
      "confluence",
      "discord",
      "facebook",
      "google-workspace",
      "instagram",
      "jira",
      "linear",
      "linkedin",
      "mailchimp",
      "notion",
      "openweather",
      "reddit",
      "slack-oim",
      "telegram",
      "trello",
      "twilio",
      "x",
      "zendesk",
    ]);
    expect(
      catalog.every(
        (entry) =>
          entry.integration.oimManifest === entry.manifest &&
          entry.integration.sourceIntegration === entry.manifest.metadata.id
      )
    ).toBe(true);
  });
});
