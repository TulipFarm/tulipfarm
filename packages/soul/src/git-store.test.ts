import { createHash } from "node:crypto";
import { canonicalHash, canonicalize } from "@tulipfarm/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

vi.mock("simple-git", () => ({ default: vi.fn() }));
vi.mock("node:fs", () => ({
  mkdtempSync: vi.fn(() => "/soul/.git/tulipfarm-changesets/changeset-xyz"),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  rmdirSync: vi.fn(),
}));

import { rmSync, writeFileSync } from "node:fs";
import simpleGit from "simple-git";
import type { SoulFileChange, ValidatedSoulChangeset } from "./changeset";
import type { CommitSigner } from "./commit-signing";
import { SoulGitStore, SoulGitStoreError } from "./git-store";

const mockSimpleGit = vi.mocked(simpleGit);
const mockRmSync = vi.mocked(rmSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

const BASE = "base0000";
const SOUL = "/soul";

interface MockGitOptions {
  headSha?: string | null;
  updateRefRejects?: boolean;
  restoreRejects?: boolean;
  branchRef?: string;
}

function makeMockGit(opts: MockGitOptions = {}) {
  const headSha = opts.headSha === undefined ? BASE : opts.headSha;
  const rawCalls: string[][] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test mock surface
  const git: Record<string, any> = {
    env: vi.fn(() => git),
    reset: vi.fn().mockResolvedValue(undefined),
    revparse: vi.fn((args: string[]) => {
      if (args[0] === "HEAD") {
        return headSha === null
          ? Promise.reject(new Error("unknown revision HEAD"))
          : Promise.resolve(`${headSha}\n`);
      }
      return Promise.resolve("");
    }),
    raw: vi.fn((args: string[]) => {
      rawCalls.push(args);
      switch (args[0]) {
        // The publish target is resolved from HEAD rather than assumed, so the mock must answer
        // it — a repo created without `init.defaultBranch` is on `master`, not `main`.
        case "symbolic-ref":
          return Promise.resolve(`${opts.branchRef ?? "refs/heads/main"}\n`);
        case "hash-object":
          return Promise.resolve("blob1111\n");
        case "write-tree":
          return Promise.resolve("tree2222\n");
        case "commit-tree":
          return Promise.resolve("commit3333\n");
        case "update-ref":
          return opts.updateRefRejects
            ? Promise.reject(new Error("cannot lock ref: is at other but expected"))
            : Promise.resolve("");
        case "restore":
          return opts.restoreRejects
            ? Promise.reject(new Error("restore failed"))
            : Promise.resolve("");
        default:
          return Promise.resolve("");
      }
    }),
  };
  return { git, rawCalls };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeSigner(overrides: Partial<CommitSigner> = {}): CommitSigner {
  return { keyId: "key-1", sign: vi.fn(() => "sigvalue"), ...overrides };
}

const AGENT_DOCUMENT = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Agent",
  metadata: {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "ada",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "draft",
  },
  spec: {
    owner: "prin_1",
    instructions: { path: "instructions.md" },
    modelProfile: "sol-high",
    autonomy: "answer_only",
    trustTier: "first_party",
  },
};

const UPSERT: SoulFileChange = {
  operation: "upsert",
  path: "agents/ada/agent.yaml",
  content: stringify(AGENT_DOCUMENT),
};
const DELETE: SoulFileChange = { operation: "delete", path: "routines/old/routine.yaml" };

function makeValidated(overrides: Partial<ValidatedSoulChangeset> = {}): ValidatedSoulChangeset {
  return {
    id: "cs_1",
    businessId: "biz_1",
    principalId: "prin_1",
    source: "agent",
    expectedBaseCommit: BASE,
    files: [
      {
        operation: "upsert",
        path: UPSERT.path,
        hash: canonicalHash(AGENT_DOCUMENT),
        apiVersion: "tulipfarm.ai/v1",
        kind: "Agent",
      },
      {
        operation: "delete",
        path: DELETE.path,
        hash: createHash("sha256").update(`delete\0${DELETE.path}`).digest("hex"),
      },
    ],
    evidence: { outcome: "validated", fileCount: 2 },
    ...overrides,
  };
}

const ACTOR = { principalId: "prin_1", name: "Ada", email: "ada@example.com" };

function names(calls: string[][]): string[] {
  return calls.map((c) => c[0]);
}

describe("SoulGitStore.commitChangeset", () => {
  let mock: ReturnType<typeof makeMockGit>;
  let logger: ReturnType<typeof makeLogger>;

  function build(opts?: MockGitOptions) {
    mock = makeMockGit(opts);
    // biome-ignore lint/suspicious/noExplicitAny: mock
    mockSimpleGit.mockReturnValue(mock.git as any);
    logger = makeLogger();
  }

  beforeEach(() => build());
  afterEach(() => vi.clearAllMocks());

  it("atomically writes the tree and CAS-updates the ref, returning signed evidence", async () => {
    const signer = makeSigner();
    const store = new SoulGitStore(SOUL, signer, logger);
    const result = await store.commitChangeset({
      changeset: makeValidated(),
      files: [UPSERT, DELETE],
      actor: ACTOR,
    });

    expect(result).toEqual({
      commitSha: "commit3333",
      treeSha: "tree2222",
      parentSha: BASE,
      filesChanged: 2,
      signature: { keyId: "key-1", value: "sigvalue" },
    });

    // seeded the private index from the base, staged the upsert, removed the delete
    expect(mock.rawCalls).toContainEqual(["read-tree", BASE]);
    expect(mock.rawCalls).toContainEqual([
      "update-index",
      "--add",
      "--cacheinfo",
      "100644,blob1111,agents/ada/agent.yaml",
    ]);
    expect(mock.rawCalls).toContainEqual([
      "update-index",
      "--force-remove",
      "routines/old/routine.yaml",
    ]);

    // commit-tree parents off the base and carries signed metadata trailers
    const commitTree = mock.rawCalls.find((c) => c[0] === "commit-tree");
    expect(commitTree).toBeDefined();
    expect(commitTree).toContain("-p");
    expect(commitTree).toContain(BASE);
    const message = commitTree?.[commitTree.indexOf("-m") + 1] ?? "";
    expect(message).toContain("Soul-Changeset: cs_1");
    expect(message).toContain("Soul-Signature: key-1:sigvalue");

    // CAS ref update guarded by the expected base, then only touched paths are materialized
    expect(mock.rawCalls).toContainEqual(["update-ref", "refs/heads/main", "commit3333", BASE]);
    expect(mock.rawCalls).toContainEqual([
      "restore",
      "--source",
      "commit3333",
      "--staged",
      "--worktree",
      "--",
      "agents/ada/agent.yaml",
    ]);
    expect(mock.rawCalls).toContainEqual([
      "rm",
      "-f",
      "--ignore-unmatch",
      "--",
      "routines/old/routine.yaml",
    ]);
    expect(mock.git.reset).not.toHaveBeenCalled();
    expect(mockRmSync).toHaveBeenCalled();
  });

  it("handles an initial commit with no base (unborn branch)", async () => {
    build({ headSha: null });
    const store = new SoulGitStore(SOUL, makeSigner(), logger);
    const result = await store.commitChangeset({
      changeset: makeValidated({ expectedBaseCommit: "" }),
      files: [UPSERT, DELETE],
      actor: ACTOR,
    });

    expect(result.parentSha).toBeNull();
    expect(mock.rawCalls.some((c) => c[0] === "read-tree")).toBe(false);
    const commitTree = mock.rawCalls.find((c) => c[0] === "commit-tree");
    expect(commitTree).not.toContain("-p");
    // all-zero old value makes creation compare-and-swap: the ref must still not exist
    expect(mock.rawCalls).toContainEqual([
      "update-ref",
      "refs/heads/main",
      "commit3333",
      "0000000000000000000000000000000000000000",
    ]);
  });

  it("rejects a stale base before touching the ref", async () => {
    build({ headSha: "moved999" });
    const store = new SoulGitStore(SOUL, makeSigner(), logger);
    await expect(
      store.commitChangeset({ changeset: makeValidated(), files: [UPSERT, DELETE], actor: ACTOR })
    ).rejects.toMatchObject({ code: "BASE_MISMATCH" });

    expect(names(mock.rawCalls)).not.toContain("commit-tree");
    expect(names(mock.rawCalls)).not.toContain("update-ref");
    expect(mock.git.reset).not.toHaveBeenCalled();
  });

  it("rejects content that does not match the validated changeset", async () => {
    const store = new SoulGitStore(SOUL, makeSigner(), logger);
    await expect(
      store.commitChangeset({ changeset: makeValidated(), files: [UPSERT], actor: ACTOR })
    ).rejects.toMatchObject({ code: "CONTENT_MISMATCH" });
    expect(mock.git.revparse).not.toHaveBeenCalled();
  });

  it("rejects content changed after validation even when operation and path still match", async () => {
    const changed = {
      ...UPSERT,
      content: UPSERT.content.replace("answer_only", "propose_actions"),
    };
    const store = new SoulGitStore(SOUL, makeSigner(), logger);

    await expect(
      store.commitChangeset({
        changeset: makeValidated(),
        files: [changed, DELETE],
        actor: ACTOR,
      })
    ).rejects.toMatchObject({ code: "CONTENT_MISMATCH" });

    expect(mock.git.revparse).not.toHaveBeenCalled();
  });

  it("writes definitions in deterministic canonical form", async () => {
    const store = new SoulGitStore(SOUL, makeSigner(), logger);
    await store.commitChangeset({
      changeset: makeValidated(),
      files: [UPSERT, DELETE],
      actor: ACTOR,
    });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/soul/.git/tulipfarm-changesets/changeset-xyz/blob",
      `${canonicalize(AGENT_DOCUMENT)}\n`
    );
  });

  it("rejects an actor that differs from the validated principal", async () => {
    const store = new SoulGitStore(SOUL, makeSigner(), logger);
    await expect(
      store.commitChangeset({
        changeset: makeValidated(),
        files: [UPSERT, DELETE],
        actor: { ...ACTOR, principalId: "other-principal" },
      })
    ).rejects.toMatchObject({ code: "ACTOR_MISMATCH" });

    expect(mock.git.revparse).not.toHaveBeenCalled();
  });

  it("aborts on a signing failure before any ref moves", async () => {
    const signer = makeSigner({
      sign: vi.fn(() => {
        throw new Error("kms unavailable");
      }),
    });
    const store = new SoulGitStore(SOUL, signer, logger);
    await expect(
      store.commitChangeset({ changeset: makeValidated(), files: [UPSERT, DELETE], actor: ACTOR })
    ).rejects.toMatchObject({ code: "SIGNING_FAILED" });

    expect(names(mock.rawCalls)).not.toContain("commit-tree");
    expect(names(mock.rawCalls)).not.toContain("update-ref");
    expect(mock.git.reset).not.toHaveBeenCalled();
    expect(mockRmSync).toHaveBeenCalled();
  });

  it("targets the branch HEAD points at, not an assumed main", async () => {
    // `git init` produces `master` unless the host sets `init.defaultBranch`, so hardcoding
    // `refs/heads/main` made the compare-and-swap target a ref that does not exist on a fresh
    // container — reported as a conflict, whose advertised remedy is an unwinnable retry.
    build({ branchRef: "refs/heads/master" });
    const store = new SoulGitStore(SOUL, makeSigner(), logger);
    await store.commitChangeset({
      changeset: makeValidated(),
      files: [UPSERT, DELETE],
      actor: ACTOR,
    });

    expect(mock.rawCalls).toContainEqual(["update-ref", "refs/heads/master", "commit3333", BASE]);
  });

  it("does not materialize the working tree when the CAS ref update loses the race", async () => {
    build({ updateRefRejects: true });
    const store = new SoulGitStore(SOUL, makeSigner(), logger);
    await expect(
      store.commitChangeset({ changeset: makeValidated(), files: [UPSERT, DELETE], actor: ACTOR })
    ).rejects.toMatchObject({ code: "REF_UPDATE_FAILED" });

    expect(mock.git.reset).not.toHaveBeenCalled();
    expect(mockRmSync).toHaveBeenCalled();
  });

  it("distinguishes a post-commit materialization failure from a failed commit", async () => {
    build({ restoreRejects: true });
    const store = new SoulGitStore(SOUL, makeSigner(), logger);

    await expect(
      store.commitChangeset({ changeset: makeValidated(), files: [UPSERT, DELETE], actor: ACTOR })
    ).rejects.toMatchObject({ code: "POST_COMMIT_CLEANUP_FAILED" });

    expect(mock.rawCalls).toContainEqual(["update-ref", "refs/heads/main", "commit3333", BASE]);
  });

  it("wraps a tree-write failure and cleans up the throwaway index", async () => {
    build();
    mock.git.raw.mockImplementation((args: string[]) => {
      if (args[0] === "write-tree") return Promise.reject(new Error("index corrupt"));
      return Promise.resolve("");
    });
    const store = new SoulGitStore(SOUL, makeSigner(), logger);
    await expect(
      store.commitChangeset({ changeset: makeValidated(), files: [UPSERT, DELETE], actor: ACTOR })
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(mockRmSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("throws SoulGitStoreError (not a raw error) for boundary evidence", async () => {
    build({ headSha: "moved999" });
    const store = new SoulGitStore(SOUL, makeSigner(), logger);
    await expect(
      store.commitChangeset({ changeset: makeValidated(), files: [UPSERT, DELETE], actor: ACTOR })
    ).rejects.toBeInstanceOf(SoulGitStoreError);
  });
});
