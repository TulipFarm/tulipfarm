import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  ActiveRoutineCatalog,
  type BundleVerifier,
  type CommitSigner,
  compileExecutionBundle,
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
  GitSoulTreeReader,
  hermeticGitEnv,
  InMemoryBundleStore,
  SoulGitStore,
  SoulPublicationCoordinator,
  SoulPublisher,
  SoulWriter,
  scaffoldSoul,
} from "@tulipfarm/soul";
import { InMemorySoulPublicationStore } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PlatformToolContext, routineForgeTool } from "../platform/tools";

/**
 * The Routines surface reads only the verified active bundle, so `routine_forge` succeeding proves
 * nothing on its own: the write must survive commit, publication and activation to become visible.
 * This exercise runs the real Tool, the real write gateway and the real publisher against a Soul
 * scaffolded exactly as `scaffoldSoul` ships one.
 */

const ROUTINE = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "daily-report",
    displayName: "Daily report",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    owner: "operations",
    start: "Decide",
    states: [{ name: "Decide", type: "branch", conditions: [{ condition: "true", end: true }] }],
  },
};

const TRIGGER = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Trigger",
  metadata: {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "daily-report-manual",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    type: "manual",
    routineRef: { name: "daily-report", version: "1" },
    eventType: "routine.manual",
    eventVersion: 1,
    backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
    deduplication: { key: "daily-report-manual" },
  },
};

const commitSigner: CommitSigner = {
  keyId: "test-key",
  sign: (payload) => createHmac("sha256", "soul-test").update(payload).digest("base64"),
};

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const bundleSigner = createEd25519BundleSigner(
  "bundle-key",
  privateKey.export({ format: "pem", type: "pkcs8" }).toString()
);
const bundleVerifier: BundleVerifier = createEd25519BundleVerifier([
  {
    keyId: "bundle-key",
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  },
]);

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("routine_forge → Soul publication → Routines catalog", () => {
  let soulPath: string;
  let coordinator: SoulPublicationCoordinator;
  let catalog: ActiveRoutineCatalog;
  let writer: SoulWriter;

  beforeEach(async () => {
    soulPath = mkdtempSync(join(tmpdir(), "tf-routine-publish-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: soulPath, env: hermeticGitEnv() });
    await scaffoldSoul(soulPath);
    coordinator = new SoulPublicationCoordinator(
      new InMemorySoulPublicationStore(),
      new InMemoryBundleStore(),
      silent
    );
    const publisher = new SoulPublisher({
      treeReader: new GitSoulTreeReader(soulPath),
      compiler: compileExecutionBundle,
      signer: bundleSigner,
      coordinator,
      logger: silent,
      businessId: DEPLOYMENT_BUSINESS_ID,
    });
    writer = new SoulWriter(
      new SoulGitStore(soulPath, commitSigner, silent),
      silent,
      undefined,
      undefined,
      publisher
    );
    catalog = new ActiveRoutineCatalog(() =>
      coordinator.activeBundle(DEPLOYMENT_BUSINESS_ID, bundleVerifier)
    );
  });

  afterEach(() => {
    rmSync(soulPath, { recursive: true, force: true });
  });

  function forge(ctx: PlatformToolContext) {
    return routineForgeTool.handler(
      { name: "daily-report", definition: ROUTINE, triggers: [TRIGGER] },
      { routineCatalog: catalog, ...ctx }
    );
  }

  it("lists a forged Routine on the Routines surface", async () => {
    const result = await forge({ soulWriter: writer });
    expect(result).toMatchObject({ success: true, data: { committed: true } });

    await coordinator.drain("test");

    expect(await catalog.list()).toEqual([
      {
        id: ROUTINE.metadata.id,
        slug: "daily-report",
        displayName: "Daily report",
        authoredVersion: 1,
        triggers: [{ slug: "daily-report-manual", type: "manual", summary: "manual" }],
      },
    ]);
  });

  it("lists a forged Routine as soon as the Tool reports success", async () => {
    const result = await forge({ soulWriter: writer });
    expect(result).toMatchObject({ success: true, data: { committed: true } });

    expect(await catalog.list()).toMatchObject([{ slug: "daily-report" }]);
  });

  it("refuses to report success for a Routine the Routines surface does not list", async () => {
    const result = await forge({
      soulWriter: writer,
      routineCatalog: { list: async () => [] },
    });

    expect(result).toMatchObject({ success: false, error: { code: "internal_error" } });
    expect(JSON.stringify(result)).toContain("does not appear on the Routines surface");
  });

  it("reports a failure instead of success when publication does not land", async () => {
    const unpublishable = new SoulWriter(
      new SoulGitStore(soulPath, commitSigner, silent),
      silent,
      undefined,
      undefined,
      {
        publishCommittedTree: async () => {
          throw new Error("bundle storage unavailable");
        },
      }
    );

    const result = await forge({ soulWriter: unpublishable });

    expect(result).toMatchObject({
      success: false,
      error: { code: "internal_error" },
    });
    expect(JSON.stringify(result)).not.toContain("bundle storage unavailable");
    expect(await catalog.list()).toEqual([]);
  });
});
