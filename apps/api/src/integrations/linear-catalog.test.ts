import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type OimManifest, oimManifestIssues, parseOimManifest } from "@tulipfarm/schema";
import { bundledIntegrationsDir } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createBundledOimBundleContributionProvider } from "./oim-bundle-contributions";
import { loadBundledOimCatalog, unifiedOimPackageCatalog } from "./oim-catalog";

describe("Linear production activation gate", () => {
  it("activates the real verification-required catalog and compiled bundle", async () => {
    const root = bundledIntegrationsDir();
    const registry = parseYaml(await readFile(join(root, "registry.yml"), "utf8"));
    const catalog = await loadBundledOimCatalog(root, { requireVerification: true });
    const contributions = await createBundledOimBundleContributionProvider(root)();

    expect(catalog.some(({ key }) => key === "linear")).toBe(true);
    expect(
      contributions
        .flatMap(({ files }) => files ?? [])
        .some(({ path }) => path.startsWith("integrations/linear/"))
    ).toBe(true);
    expect(
      registry.integrations.find(({ name }: { name: string }) => name === "linear").availability
    ).toBe("available");
  });

  it("accepts the grounded fixed Viewer query for identity verification", async () => {
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
    expect(oimManifestIssues(candidate)).toEqual([]);
  });

  it("loads all digest-checked Linear companions", async () => {
    const catalog = await loadBundledOimCatalog(bundledIntegrationsDir());
    const entry = catalog.find(({ key }) => key === "linear");
    expect(entry?.integration.oimDocuments).toHaveProperty("operations/list-team-states.graphql");
    expect(entry?.integration.oimDocuments).toHaveProperty("operations/list-team-members.graphql");
    expect(entry?.integration.setupGuide).toContain("API key");
    if (entry === undefined) throw new Error("missing Linear");
    const installedCatalog = unifiedOimPackageCatalog([], new Map([["linear", entry.integration]]));
    expect(installedCatalog[0]?.documents).toEqual(entry.documents);
    expect(installedCatalog[0]?.packageDigest).toEqual(entry.packageDigest);
  });
});
