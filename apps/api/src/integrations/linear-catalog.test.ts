import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type OimManifest, oimManifestIssues, parseOimManifest } from "@tulipfarm/schema";
import { bundledIntegrationsDir } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createBundledOimBundleContributionProvider } from "./oim-bundle-contributions";
import { loadBundledOimCatalog } from "./oim-catalog";

describe("Linear production activation gate", () => {
  it("keeps the real catalog and compiled bundle closed until provider verification is supported", async () => {
    const root = bundledIntegrationsDir();
    const registry = parseYaml(await readFile(join(root, "registry.yml"), "utf8"));
    const catalog = await loadBundledOimCatalog(root, { requireVerification: true });
    const contributions = await createBundledOimBundleContributionProvider(root)();

    expect(catalog.some(({ key }) => key === "linear")).toBe(false);
    expect(
      contributions
        .flatMap(({ files }) => files ?? [])
        .some(({ path }) => path.startsWith("integrations/linear/"))
    ).toBe(false);
    expect(
      registry.integrations.find(({ name }: { name: string }) => name === "linear").availability
    ).toBe("coming_soon");
  });

  it("identifies the exact shared contract blocking the real fixed Viewer query", async () => {
    const manifest = parseOimManifest(
      await readFile(join(bundledIntegrationsDir(), "linear/oim.yml"), "utf8")
    );
    expect(manifest.auth?.healthCheckOperationId).toBe("viewer");
    if (manifest.auth === undefined) throw new Error("missing Linear auth");
    const candidate: OimManifest = {
      ...manifest,
      auth: {
        ...manifest.auth,
        verification: {
          issuer: { source: "package", value: "https://api.linear.app" },
          checks: [
            {
              id: "viewer",
              operationId: "viewer",
              credentialSlots: ["api_key"],
              success: [{ kind: "present", path: "/data/viewer/id" }],
            },
          ],
          evidence: {
            assurance: "identified",
            subject: {
              kind: "human",
              checkId: "viewer",
              path: "/data/viewer/id",
              namespace: "issuer",
            },
          },
        },
      },
    };
    expect(oimManifestIssues(candidate)).toContain(
      "auth: verification check viewer operation must be a read-only HTTP GET"
    );
  });

  it("loads all digest-checked Linear companions in authoring mode without granting activation", async () => {
    const catalog = await loadBundledOimCatalog(bundledIntegrationsDir());
    const entry = catalog.find(({ key }) => key === "linear");
    expect(entry?.integration.oimDocuments).toHaveProperty("operations/list-team-states.graphql");
    expect(entry?.integration.oimDocuments).toHaveProperty("operations/list-team-members.graphql");
    expect(entry?.integration.setupGuide).toContain("Coming soon");
  });
});
