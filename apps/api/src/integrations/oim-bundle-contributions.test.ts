import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { parseOimManifest } from "@tulipfarm/schema";
import {
  compileExecutionBundle,
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
  InMemoryBundleStore,
  SoulPublicationCoordinator,
  SoulPublisher,
} from "@tulipfarm/soul";
import { InMemorySoulPublicationStore } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { createBundledOimBundleContributionProvider } from "./oim-bundle-contributions";

const BUSINESS_ID = "business-1";
const COMMIT_SHA = "a".repeat(40);
const ACTOR = {
  principalId: "system:test",
  name: "TulipFarm Test",
  email: "test@tulipfarm.dev",
};

describe("bundled OIM bundle contributions", () => {
  it("publishes verified packages, companions, and ToolContracts into a fresh Soul bundle", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signer = createEd25519BundleSigner(
      "test-key",
      privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    );
    const verifier = createEd25519BundleVerifier([
      {
        keyId: "test-key",
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
    ]);
    const publications = new SoulPublicationCoordinator(
      new InMemorySoulPublicationStore(),
      new InMemoryBundleStore(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    );
    const publisher = new SoulPublisher({
      treeReader: {
        readDefinitions: vi.fn(async () => []),
        readFiles: vi.fn(async () => []),
      },
      compiler: compileExecutionBundle,
      signer,
      coordinator: publications,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      businessId: BUSINESS_ID,
      contributions: createBundledOimBundleContributionProvider(
        resolve(process.cwd(), "../../integrations")
      ),
    });

    await publisher.publishCommittedTree({ commitSha: COMMIT_SHA, actor: ACTOR });

    const bundle = await publications.activeBundle(BUSINESS_ID, verifier);
    expect(bundle).toBeDefined();
    for (const slug of ["confluence", "telegram"]) {
      const owner = `Integration:${slug}`;
      const manifestAsset = bundle?.asset(owner, "oim.yml");
      expect(manifestAsset?.content).toContain(`id: ${slug}`);
      const manifest = parseOimManifest(manifestAsset?.content ?? "");
      for (const file of manifest.files ?? []) {
        expect(bundle?.asset(owner, file.path)?.digest).toBe(file.sha256);
      }
      expect(
        bundle?.definitions.some(
          (definition) =>
            definition.kind === "ToolContract" && definition.slug.startsWith(`${slug}-`)
        )
      ).toBe(true);
    }
  });
});
