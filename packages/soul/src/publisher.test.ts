import { generateKeyPairSync } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { definitionPath, type VersionedSchemaDocument } from "@tulipfarm/schema";
import { InMemorySoulPublicationStore } from "@tulipfarm/storage";
import simpleGit from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { InMemoryBundleStore } from "./bundle";
import type { CommitActor } from "./commit-signing";
import { type BundleCompileRequest, compileExecutionBundle } from "./compiler";
import { GitSyncService } from "./git-sync";
import {
  SoulPublicationCoordinator,
  type SoulPublishRequest,
  type SoulTreeReader,
} from "./publication";
import { SoulPublisher } from "./publisher";
import {
  type BundleSigner,
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
} from "./signatures";
import { GitSoulTreeReader } from "./tree-reader";
import type { Logger } from "./types";

const BUSINESS = "business-1";
const COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const KEY_ID = "bundle-key-1";
const ACTOR: CommitActor = {
  principalId: "user:test",
  name: "Test User",
  email: "test@example.com",
};
const TMP = join(import.meta.dirname, "__publisher_tmp__");

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function routine(slug = "daily-briefing"): VersionedSchemaDocument {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "11111111-1111-4111-8111-111111111111",
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      owner: "ops",
      start: "waitForTimer",
      states: [
        {
          name: "waitForTimer",
          type: "wait",
          waitFor: { kind: "timer", durationMs: 1 },
          end: true,
        },
      ],
    },
  } as VersionedSchemaDocument;
}

function role(slug = "ops-reviewer"): VersionedSchemaDocument {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Role",
    metadata: {
      id: "66666666-6666-4666-8666-666666666666",
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      principalTypes: ["user"],
      grants: [],
    },
  } as VersionedSchemaDocument;
}

function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    signer: createEd25519BundleSigner(
      KEY_ID,
      privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    ),
    verifier: createEd25519BundleVerifier([
      { keyId: KEY_ID, publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() },
    ]),
    untrustedVerifier: createEd25519BundleVerifier([
      {
        keyId: "another-key",
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
    ]),
  };
}

async function writeFixture(path: string, content: string): Promise<void> {
  const fullPath = join(TMP, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

afterEach(() => rm(TMP, { recursive: true, force: true }));

/** Coordinator double whose publication settles to `active`, as an inline settle does. */
function settledCoordinator() {
  return { publish: vi.fn(async () => {}), settle: vi.fn(async () => "active" as const) };
}

describe("SoulPublisher", () => {
  it("reads, compiles, signs, and publishes the committed tree with its actor", async () => {
    const { signer } = ed25519();
    const treeReader: SoulTreeReader = {
      readDefinitions: vi.fn(async () => [routine()]),
      readFiles: vi.fn(async () => []),
    };
    const compiler = vi.fn((request: BundleCompileRequest) => compileExecutionBundle(request));
    const coordinator = settledCoordinator();
    const publisher = new SoulPublisher({
      treeReader,
      compiler,
      signer,
      coordinator,
      logger: logger(),
      businessId: BUSINESS,
    });

    await publisher.publishCommittedTree({ commitSha: COMMIT_SHA, actor: ACTOR });

    expect(treeReader.readDefinitions).toHaveBeenCalledWith(COMMIT_SHA);
    expect(treeReader.readFiles).toHaveBeenCalledWith(COMMIT_SHA);
    expect(compiler).toHaveBeenCalledWith({
      businessId: BUSINESS,
      changesetId: COMMIT_SHA,
      commitSha: COMMIT_SHA,
      documents: [routine()],
      files: [],
    });
    expect(coordinator.publish).toHaveBeenCalledWith({
      bundle: expect.objectContaining({
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        bundle: expect.objectContaining({
          businessId: BUSINESS,
          changesetId: COMMIT_SHA,
          commitSha: COMMIT_SHA,
        }),
        signature: expect.objectContaining({ keyId: KEY_ID }),
      }),
      actor: ACTOR,
    });
  });

  it("omits files when the tree reader has no readFiles method", async () => {
    const { signer } = ed25519();
    const compiler = vi.fn((request: BundleCompileRequest) => compileExecutionBundle(request));
    const publisher = new SoulPublisher({
      treeReader: { readDefinitions: vi.fn(async () => [routine()]) },
      compiler,
      signer,
      coordinator: settledCoordinator(),
      logger: logger(),
      businessId: BUSINESS,
    });

    await publisher.publishCommittedTree({ commitSha: COMMIT_SHA, actor: ACTOR });

    expect("files" in compiler.mock.calls[0][0]).toBe(false);
  });

  it("propagates tree reader, compiler, and signer failures", async () => {
    const { signer } = ed25519();
    const base = {
      compiler: (request: BundleCompileRequest) => compileExecutionBundle(request),
      signer,
      coordinator: settledCoordinator(),
      logger: logger(),
      businessId: BUSINESS,
    };

    await expect(
      new SoulPublisher({
        ...base,
        treeReader: {
          readDefinitions: vi.fn(async () => {
            throw new Error("tree unavailable");
          }),
        },
      }).publishCommittedTree({ commitSha: COMMIT_SHA, actor: ACTOR })
    ).rejects.toThrow("tree unavailable");

    await expect(
      new SoulPublisher({
        ...base,
        treeReader: { readDefinitions: vi.fn(async () => [routine()]) },
        compiler: () => {
          throw new Error("compile failed");
        },
      }).publishCommittedTree({ commitSha: COMMIT_SHA, actor: ACTOR })
    ).rejects.toThrow("compile failed");

    const failingSigner: BundleSigner = {
      keyId: KEY_ID,
      sign: () => {
        throw new Error("sign failed");
      },
    };
    await expect(
      new SoulPublisher({
        ...base,
        treeReader: { readDefinitions: vi.fn(async () => [routine()]) },
        signer: failingSigner,
      }).publishCommittedTree({ commitSha: COMMIT_SHA, actor: ACTOR })
    ).rejects.toThrow("sign failed");
  });

  it("publishes a Soul commit, drains it active, and verifies through the public key only", async () => {
    const { signer, verifier, untrustedVerifier } = ed25519();
    const publicationStore = new InMemorySoulPublicationStore();
    const bundleStore = new InMemoryBundleStore();
    const log = logger();
    const publications = new SoulPublicationCoordinator(publicationStore, bundleStore, log);
    await mkdir(TMP, { recursive: true });
    const publisher = new SoulPublisher({
      treeReader: new GitSoulTreeReader(TMP),
      compiler: compileExecutionBundle,
      signer,
      coordinator: publications,
      logger: log,
      businessId: BUSINESS,
    });
    const git = simpleGit(TMP);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@tulipfarm.dev");
    await git.addConfig("user.name", "TulipFarm Test");
    await writeFile(join(TMP, "soul.yaml"), "{}\n", "utf8");
    await git.add("-A");
    await git.commit("initial");

    await writeFixture(definitionPath("Routine", "daily-briefing"), stringifyYaml(routine()));
    await writeFixture(definitionPath("Role", "ops-reviewer"), stringifyYaml(role()));
    const gitSync = new GitSyncService(TMP, undefined, async () => undefined, log, {
      committedTreePublisher: publisher,
    });

    const commit = await gitSync.commitPaths(
      "soul: publish routine and role",
      [definitionPath("Routine", "daily-briefing"), definitionPath("Role", "ops-reviewer")],
      ACTOR
    );
    expect(log.error).not.toHaveBeenCalled();
    await publications.drain("test");

    const active = await publications.activeBundle(BUSINESS, verifier);
    expect(active?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(active?.changesetId).toBe(commit.sha);
    expect(active?.commitSha).toBe(commit.sha);
    expect(active?.get("Routine", "daily-briefing")?.id).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(active?.get("Role", "ops-reviewer")?.id).toBe("66666666-6666-4666-8666-666666666666");
    const stored = active === undefined ? undefined : await bundleStore.get(active.digest);
    expect(stored?.digest).toBe(active?.digest);
    expect(stored?.signature.keyId).toBe(KEY_ID);
    await expect(publications.activeBundle(BUSINESS, untrustedVerifier)).rejects.toThrow(
      "is not trusted"
    );
  }, 15_000);

  it("activates the publication before returning, so no drain is needed to see the write", async () => {
    const { signer, verifier } = ed25519();
    const log = logger();
    const publications = new SoulPublicationCoordinator(
      new InMemorySoulPublicationStore(),
      new InMemoryBundleStore(),
      log
    );
    const publisher = new SoulPublisher({
      treeReader: { readDefinitions: vi.fn(async () => [routine()]) },
      compiler: compileExecutionBundle,
      signer,
      coordinator: publications,
      logger: log,
      businessId: BUSINESS,
    });

    await publisher.publishCommittedTree({ commitSha: COMMIT_SHA, actor: ACTOR });

    const active = await publications.activeBundle(BUSINESS, verifier);
    expect(active?.get("Routine", "daily-briefing")?.slug).toBe("daily-briefing");
    expect(await publications.drain("test")).toEqual([]);
  });

  it("fails the publish when the publication stops short of active", async () => {
    const { signer } = ed25519();
    const publisher = new SoulPublisher({
      treeReader: { readDefinitions: vi.fn(async () => [routine()]) },
      compiler: compileExecutionBundle,
      signer,
      coordinator: {
        publish: vi.fn(async () => {}),
        settle: vi.fn(async () => "projected" as const),
      },
      logger: logger(),
      businessId: BUSINESS,
    });

    await expect(
      publisher.publishCommittedTree({ commitSha: COMMIT_SHA, actor: ACTOR })
    ).rejects.toThrow("stopped at stage projected");
  });
});

describe("SoulPublisher.reconcile", () => {
  function withFakes(opts: { head?: string; active?: string; hasCommit?: boolean }) {
    const { signer } = ed25519();
    const publish = vi.fn(async (_req: SoulPublishRequest) => {});
    const log = logger();
    const publisher = new SoulPublisher({
      treeReader: {
        readDefinitions: vi.fn(async () => [routine()]),
        readFiles: vi.fn(async () => []),
      },
      compiler: compileExecutionBundle,
      signer,
      coordinator: { ...settledCoordinator(), publish },
      logger: log,
      businessId: BUSINESS,
      gitState: {
        headSha: vi.fn(async () => opts.head),
        hasCommit: vi.fn(async () => opts.hasCommit ?? true),
      },
      activeCommitSha: vi.fn(async () => opts.active),
    });
    return { publisher, publish, log };
  }

  const OLDER_SHA = "1111111111111111111111111111111111111111";

  it("publishes HEAD when nothing is active", async () => {
    const { publisher, publish } = withFakes({ head: COMMIT_SHA, active: undefined });
    await publisher.reconcile(BUSINESS, ACTOR);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].bundle.bundle.commitSha).toBe(COMMIT_SHA);
    expect(publish.mock.calls[0][0].actor).toBe(ACTOR);
  });

  it("does nothing when the active bundle already pins HEAD", async () => {
    const { publisher, publish } = withFakes({ head: COMMIT_SHA, active: COMMIT_SHA });
    await publisher.reconcile(BUSINESS, ACTOR);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes HEAD when the active bundle pins an older, still-present commit", async () => {
    const { publisher, publish, log } = withFakes({
      head: COMMIT_SHA,
      active: OLDER_SHA,
      hasCommit: true,
    });
    await publisher.reconcile(BUSINESS, ACTOR);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].bundle.bundle.commitSha).toBe(COMMIT_SHA);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs loudly and republishes when the active commit is gone from the repo", async () => {
    const { publisher, publish, log } = withFakes({
      head: COMMIT_SHA,
      active: OLDER_SHA,
      hasCommit: false,
    });
    await publisher.reconcile(BUSINESS, ACTOR);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("absent from the repo"));
  });

  it("skips when the repo has no commits yet", async () => {
    const { publisher, publish, log } = withFakes({ head: undefined });
    await publisher.reconcile(BUSINESS, ACTOR);
    expect(publish).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("no commits"));
  });

  it("throws when no gitState port is configured", async () => {
    const { signer } = ed25519();
    const publisher = new SoulPublisher({
      treeReader: { readDefinitions: vi.fn(async () => [routine()]) },
      compiler: compileExecutionBundle,
      signer,
      coordinator: settledCoordinator(),
      logger: logger(),
      businessId: BUSINESS,
    });
    await expect(publisher.reconcile(BUSINESS, ACTOR)).rejects.toThrow("requires a gitState");
  });

  it("brings an empty active bundle to HEAD, then follows HEAD when it moves", async () => {
    const { signer, verifier } = ed25519();
    const log = logger();
    const publications = new SoulPublicationCoordinator(
      new InMemorySoulPublicationStore(),
      new InMemoryBundleStore(),
      log
    );
    await mkdir(TMP, { recursive: true });
    const git = simpleGit(TMP);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.email", "test@tulipfarm.dev");
    await git.addConfig("user.name", "TulipFarm Test");
    await writeFile(join(TMP, "soul.yaml"), "{}\n", "utf8");
    await writeFixture(definitionPath("Routine", "daily-briefing"), stringifyYaml(routine()));
    await git.add("-A");
    await git.commit("initial soul");
    const firstHead = (await git.revparse(["HEAD"])).trim();

    const gitSync = new GitSyncService(TMP, undefined, async () => undefined, log);
    const publisher = new SoulPublisher({
      treeReader: new GitSoulTreeReader(TMP),
      compiler: compileExecutionBundle,
      signer,
      coordinator: publications,
      logger: log,
      businessId: BUSINESS,
      gitState: {
        headSha: () => gitSync.headSha(),
        hasCommit: (sha) => gitSync.hasCommit(sha),
      },
      activeCommitSha: async (businessId) =>
        (await publications.activeBundle(businessId, verifier))?.commitSha,
    });

    // An unpublished deployment: git has commits, but soul_active_bundles is empty.
    expect(await publications.activeDigest(BUSINESS)).toBeUndefined();

    await publisher.reconcile(BUSINESS, ACTOR);
    await publications.drain("test");
    expect((await publications.activeBundle(BUSINESS, verifier))?.commitSha).toBe(firstHead);

    // A remote-authored commit moves HEAD without firing the local commit hook.
    await writeFixture(definitionPath("Role", "ops-reviewer"), stringifyYaml(role()));
    await git.add("-A");
    await git.commit("remote: add ops-reviewer role");
    const secondHead = (await git.revparse(["HEAD"])).trim();
    expect(secondHead).not.toBe(firstHead);

    await publisher.reconcile(BUSINESS, ACTOR);
    await publications.drain("test");
    expect((await publications.activeBundle(BUSINESS, verifier))?.commitSha).toBe(secondHead);
  }, 20_000);
});
