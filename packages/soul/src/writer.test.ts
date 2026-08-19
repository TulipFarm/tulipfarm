import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitActor, CommitSigner } from "./commit-signing";
import { SoulGitStore } from "./git-store";
import type { Logger } from "./types";
import { type SoulWrite, SoulWriteError, SoulWriter } from "./writer";

/** Tests use real Git to cover atomicity, base conflicts, path guards, and cleanup. */

const ACTOR: CommitActor = {
  principalId: "principal-1",
  name: "Ada",
  email: "ada@example.com",
};

const signer: CommitSigner = {
  keyId: "test-key",
  sign: (payload) => createHmac("sha256", "secret").update(payload).digest("base64"),
};

function agentDoc(slug: string, personality = "Answers questions."): string {
  return [
    "apiVersion: tulipfarm.ai/v1",
    "kind: Agent",
    "metadata:",
    "  id: 01HQ2X8G3K4M5N6P7Q8R9S0TAB",
    `  slug: ${slug}`,
    "  schemaVersion: 1",
    "  authoredVersion: 1",
    "  lifecycle: draft",
    "spec:",
    "  owner: ada@example.com",
    "  instructions:",
    "    path: instructions.md",
    "  modelProfile: default",
    "  autonomy: answer_only",
    "  trustTier: business_authored",
    `  personality: ${personality}`,
    "",
  ].join("\n");
}

function skillDoc(slug: string): string {
  return [
    "apiVersion: tulipfarm.ai/v1",
    "kind: Skill",
    "metadata:",
    "  id: 01HQ2X8G3K4M5N6P7Q8R9S0TCD",
    `  slug: ${slug}`,
    "  schemaVersion: 1",
    "  authoredVersion: 1",
    "  lifecycle: draft",
    "spec:",
    "  instructions:",
    "    path: SKILL.md",
    "  trustTier: business_authored",
    "",
  ].join("\n");
}

let soulPath: string;
let store: SoulGitStore;
let writer: SoulWriter;
let logger: Logger;
let pushed: number;
let reloaded: number;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: soulPath, encoding: "utf8" });
}

beforeEach(() => {
  soulPath = mkdtempSync(join(tmpdir(), "soul-writer-"));
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "bot@example.com");
  git("config", "user.name", "bot");
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  store = new SoulGitStore(soulPath, signer, logger);
  pushed = 0;
  reloaded = 0;
  writer = new SoulWriter(
    store,
    logger,
    {
      hasRemote: true,
      push: async () => {
        pushed += 1;
      },
    },
    {
      reload: async () => {
        reloaded += 1;
      },
    }
  );
});

afterEach(() => {
  rmSync(soulPath, { recursive: true, force: true });
});

function put(slug: string, content = agentDoc(slug)): SoulWrite {
  return { op: "put", target: { kind: "Agent", slug }, content };
}

async function apply(changes: readonly SoulWrite[], subject = "soul: test") {
  return writer.apply({
    subject,
    source: "api",
    actor: ACTOR,
    businessId: "biz-1",
    changes,
  });
}

async function applyWithBase(changes: readonly SoulWrite[], expectedBaseCommit: string) {
  return writer.apply({
    subject: "soul: test",
    source: "api",
    actor: ACTOR,
    businessId: "biz-1",
    changes,
    expectedBaseCommit,
  });
}

describe("SoulWriter.apply", () => {
  it("writes into an unborn repository, where there is no base commit to build on", async () => {
    const result = await apply([put("triage")]);

    expect(result.paths).toEqual(["agents/triage/agent.yaml"]);
    expect(existsSync(join(soulPath, "agents/triage/agent.yaml"))).toBe(true);
    expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  it("materializes the commit into the working tree the loader reads", async () => {
    await apply([put("triage", agentDoc("triage", "Routes tickets."))]);

    const onDisk = readFileSync(join(soulPath, "agents/triage/agent.yaml"), "utf8");
    expect(onDisk).toContain("Routes tickets.");
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  it("builds paths from the artifact registry rather than from the caller", async () => {
    const result = await writer.apply({
      subject: "soul: add",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [
        { op: "put", target: { kind: "Agent", slug: "a" }, content: agentDoc("a") },
        { op: "put", target: { kind: "Skill", slug: "b" }, content: skillDoc("b") },
      ],
    });

    expect(result.paths).toEqual(["agents/a/agent.yaml", "skills/b/skill.yaml"]);
  });

  it("records commit provenance so a write can be attributed after the fact", async () => {
    await apply([put("triage")], "soul: add agent triage");

    const message = git("log", "-1", "--pretty=%B");
    expect(message).toContain("soul: add agent triage");
    expect(message).toContain(ACTOR.principalId);
    expect(message).toContain("Agent");
  });

  it("pushes and reloads after a committed write", async () => {
    await apply([put("triage")]);

    expect(pushed).toBe(1);
    expect(reloaded).toBe(1);
  });
});

describe("SoulWriter.apply — validation gate", () => {
  it("rejects a definition that does not satisfy its schema", async () => {
    const invalid = ["apiVersion: soul.tulipfarm.dev/v1", "kind: Agent", "metadata: {}", ""].join(
      "\n"
    );

    await expect(apply([put("triage", invalid)])).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("leaves no commit and no file behind when validation rejects the write", async () => {
    await apply([put("good")]);
    const before = git("rev-parse", "HEAD").trim();

    await expect(apply([put("bad", "kind: Agent\n")])).rejects.toBeInstanceOf(SoulWriteError);

    expect(git("rev-parse", "HEAD").trim()).toBe(before);
    expect(existsSync(join(soulPath, "agents/bad"))).toBe(false);
  });

  it("rejects the whole changeset when any one file is invalid", async () => {
    await expect(apply([put("good"), put("bad", "kind: Agent\n")])).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    expect(existsSync(join(soulPath, "agents/good"))).toBe(false);
  });

  it("carries structured issues that name the offending path", async () => {
    const error = await apply([put("bad", "kind: Agent\n")]).catch((e: SoulWriteError) => e);

    expect(error).toBeInstanceOf(SoulWriteError);
    expect((error as SoulWriteError).issues.length).toBeGreaterThan(0);
    expect((error as SoulWriteError).issues[0].path).toBe("agents/bad/agent.yaml");
  });

  it("rejects a path the artifact registry cannot address", async () => {
    await expect(
      apply([{ op: "put", target: { kind: "Agent", slug: "../escape" }, content: agentDoc("x") }])
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
  });

  it("rejects the same path twice in one changeset", async () => {
    await expect(apply([put("dup"), put("dup")])).rejects.toMatchObject({
      code: "INVALID_TARGET",
    });
  });
});

describe("SoulWriter.apply — atomicity", () => {
  it("lands a multi-file artifact as exactly one commit", async () => {
    const result = await writer.apply({
      subject: "soul: install integration",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [
        { op: "put", target: { kind: "Agent", slug: "one" }, content: agentDoc("one") },
        { op: "put", target: { kind: "Agent", slug: "two" }, content: agentDoc("two") },
      ],
    });

    expect(result.filesChanged).toBe(2);
    expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  it("never publishes a partial tree — a rejected multi-file write leaves none of its files", async () => {
    await expect(
      writer.apply({
        subject: "soul: install",
        source: "api",
        actor: ACTOR,
        businessId: "biz-1",
        changes: [
          { op: "put", target: { kind: "Agent", slug: "one" }, content: agentDoc("one") },
          { op: "put", target: { kind: "Agent", slug: "two" }, content: "kind: Agent\n" },
        ],
      })
    ).rejects.toBeInstanceOf(SoulWriteError);

    expect(existsSync(join(soulPath, "agents/one"))).toBe(false);
    expect(existsSync(join(soulPath, "agents/two"))).toBe(false);
  });
});

describe("SoulWriter.apply — conflict detection", () => {
  it("rejects a write whose base moved under it instead of overwriting", async () => {
    await apply([put("first")]);

    // A concurrent writer — a second request, or the periodic down-sync pull — advances the tip
    // after our base was resolved but before our commit lands.
    const slowStore = new SoulGitStore(soulPath, signer, logger);
    const original = slowStore.baseCommit.bind(slowStore);
    vi.spyOn(slowStore, "baseCommit").mockImplementation(async () => {
      const base = await original();
      writeFileSync(join(soulPath, "interloper.txt"), "concurrent\n");
      execFileSync("git", ["add", "-A"], { cwd: soulPath });
      execFileSync("git", ["commit", "--quiet", "-m", "concurrent"], { cwd: soulPath });
      return base;
    });
    const racing = new SoulWriter(slowStore, logger);

    await expect(
      racing.apply({
        subject: "soul: add",
        source: "api",
        actor: ACTOR,
        businessId: "biz-1",
        changes: [put("second")],
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(existsSync(join(soulPath, "agents/second"))).toBe(false);
  });

  it("succeeds again once the caller recomputes against the new base", async () => {
    await apply([put("first")]);
    await apply([put("second")]);

    expect(git("rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(existsSync(join(soulPath, "agents/second/agent.yaml"))).toBe(true);
  });
});

describe("SoulWriter.apply — preconditions and deletes", () => {
  it("refuses to create over an artifact that already exists", async () => {
    await apply([put("triage")]);

    await expect(
      writer.apply({
        subject: "soul: add agent triage",
        source: "api",
        actor: ACTOR,
        businessId: "biz-1",
        changes: [put("triage")],
        preconditions: [{ kind: "Agent", slug: "triage", state: "absent" }],
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("refuses to update an artifact that does not exist", async () => {
    await expect(
      writer.apply({
        subject: "soul: update agent ghost",
        source: "api",
        actor: ACTOR,
        businessId: "biz-1",
        changes: [put("ghost")],
        preconditions: [{ kind: "Agent", slug: "ghost", state: "present" }],
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("removes every file of an artifact, not only its definition", async () => {
    await writer.apply({
      subject: "soul: add agent triage",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [put("triage")],
    });
    writeFileSync(join(soulPath, "agents/triage/notes.md"), "stray\n");
    execFileSync("git", ["add", "-A"], { cwd: soulPath });
    execFileSync("git", ["commit", "--quiet", "-m", "stray"], { cwd: soulPath });

    const result = await apply([{ op: "deleteArtifact", kind: "Agent", slug: "triage" }]);

    expect(result.paths).toEqual(["agents/triage/agent.yaml", "agents/triage/notes.md"]);
    expect(existsSync(join(soulPath, "agents/triage"))).toBe(false);
  });

  it("reports only paths that are actually gone after deleting an artifact", async () => {
    await apply([put("triage")]);
    writeFileSync(join(soulPath, "agents/triage/draft.md"), "not committed yet\n");

    const result = await apply([{ op: "deleteArtifact", kind: "Agent", slug: "triage" }]);

    for (const path of result.paths) {
      expect(existsSync(join(soulPath, path)), path).toBe(false);
    }
    expect(result.paths).toContain("agents/triage/draft.md");
  });

  it("rejects deleting an artifact that is not there", async () => {
    await expect(
      apply([{ op: "deleteArtifact", kind: "Agent", slug: "ghost" }])
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("SoulWriter — reads", () => {
  it("reports existence and content without exposing the repository path", async () => {
    await apply([put("triage", agentDoc("triage", "Routes tickets."))]);

    expect(writer.exists("Agent", "triage")).toBe(true);
    expect(writer.exists("Agent", "absent")).toBe(false);
    expect(writer.read("Agent", "triage")).toContain("Routes tickets.");
    expect(writer.read("Agent", "absent")).toBeNull();
  });

  it("refuses to read outside the Soul tree", () => {
    expect(store.readFile("../../etc/passwd")).toBeNull();
    expect(store.exists("/etc/passwd")).toBe(false);
    expect(store.listFiles("../..")).toEqual([]);
  });

  it("refuses to follow a symlink that escapes the Soul tree", () => {
    const outsideDir = mkdtempSync(join(soulPath, "..", "outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "host secret\n");
    mkdirSync(join(soulPath, "agents", "linked"), { recursive: true });
    symlinkSync(join(outsideDir, "secret.txt"), join(soulPath, "agents", "linked", "agent.yaml"));

    expect(store.readFile("agents/linked/agent.yaml")).toBeNull();
    expect(store.exists("agents/linked/agent.yaml")).toBe(false);
  });
});

describe("SoulWriter — regressions", () => {
  // Every one of these was a live defect the gateway's first real-git run exposed. Each would have
  // reappeared as "Soul writes randomly fail" rather than as an obvious error.

  it("publishes onto whatever branch the repo actually uses, not an assumed main", async () => {
    // `git init` still creates `master` unless the host sets `init.defaultBranch`. The CAS used to
    // target a hardcoded `refs/heads/main`, so on a fresh container every write failed — and was
    // reported as a CONFLICT, telling the caller to retry a permanent fault forever.
    const legacyPath = mkdtempSync(join(tmpdir(), "soul-master-"));
    const legacyGit = (...args: string[]): string =>
      execFileSync("git", args, { cwd: legacyPath, encoding: "utf8" });
    legacyGit("init", "--quiet", "--initial-branch=master");
    legacyGit("config", "user.email", "bot@example.com");
    legacyGit("config", "user.name", "bot");

    const legacyStore = new SoulGitStore(legacyPath, signer, logger);
    const legacyWriter = new SoulWriter(legacyStore, logger);

    const result = await legacyWriter.apply({
      subject: "soul: test",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [put("triage")],
    });

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(legacyGit("rev-parse", "refs/heads/master").trim()).toBe(result.commitSha);
    expect(existsSync(join(legacyPath, "agents", "triage", "agent.yaml"))).toBe(true);
  });

  it("refuses to publish onto a detached HEAD rather than calling it a conflict", async () => {
    await apply([put("triage")]);
    writeFileSync(join(soulPath, ".git", "HEAD"), `${git("rev-parse", "HEAD").trim()}\n`);

    // A detached HEAD is a repository-state fault. Labelling it CONFLICT would tell the caller to
    // re-read and retry, which can never succeed.
    await expect(apply([put("billing")])).rejects.toMatchObject({ code: "COMMIT_FAILED" });
  });

  it("commits even when the environment sets an interactive git program", async () => {
    // `simple-git` refuses to spawn when it sees PAGER/EDITOR/GIT_ASKPASS and friends, so passing
    // the ambient environment through made every signed write fail on a normal developer machine.
    const previous = { PAGER: process.env.PAGER, GIT_ASKPASS: process.env.GIT_ASKPASS };
    process.env.PAGER = "less";
    process.env.GIT_ASKPASS = "";
    try {
      const result = await apply([put("triage")]);
      expect(result.commitSha).toBeTruthy();
    } finally {
      restoreEnv("PAGER", previous.PAGER);
      restoreEnv("GIT_ASKPASS", previous.GIT_ASKPASS);
    }
  });

  it("rejects a stale read-modify-write base instead of committing over a concurrent update", async () => {
    await apply([put("first")]);
    const observedBase = git("rev-parse", "HEAD").trim();
    await apply([put("concurrent")]);

    await expect(applyWithBase([put("second")], observedBase)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(existsSync(join(soulPath, "agents/second/agent.yaml"))).toBe(false);
  });

  it("refuses companion paths that would address a definition file", async () => {
    await expect(
      apply([
        {
          op: "put",
          target: { kind: "Integration", slug: "github", companion: "manifest.yml" },
          content: "name: github\negress:\n  type: none\n",
        },
      ])
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
  });

  // A real Skill is a package: reference material in subdirectories and provenance files beside
  // SKILL.md. Every one of them has to be addressable through the gateway, or installing such a
  // Skill fails as a whole and the only way to land it is the raw-filesystem bypass.
  it("addresses a Skill's whole package — subdirectory and root companions alike", async () => {
    const result = await apply([
      { op: "put", target: { kind: "Skill", slug: "packing" }, content: skillDoc("packing") },
      {
        op: "put",
        target: { kind: "Skill", slug: "packing", companion: "references/bulbs.md" },
        content: "# Bulb handling\n",
      },
      {
        op: "put",
        target: { kind: "Skill", slug: "packing", companion: "scripts/pack.py" },
        content: "print('pack')\n",
      },
      {
        op: "put",
        target: { kind: "Skill", slug: "packing", companion: "LICENSE.txt" },
        content: "MIT\n",
      },
      {
        op: "put",
        target: { kind: "Skill", slug: "packing", companion: "requirements.txt" },
        content: "pandas\n",
      },
    ]);

    expect(result.paths).toEqual([
      "skills/packing/skill.yaml",
      "skills/packing/references/bulbs.md",
      "skills/packing/scripts/pack.py",
      "skills/packing/LICENSE.txt",
      "skills/packing/requirements.txt",
    ]);
    expect(existsSync(join(soulPath, "skills/packing/references/bulbs.md"))).toBe(true);
  });

  it("still refuses a companion that escapes the artifact's own directory", async () => {
    for (const companion of [
      "../escape/notes.md",
      "references/../../escape.md",
      "/etc/passwd",
      "..\\escape.md",
    ]) {
      await expect(
        apply([
          { op: "put", target: { kind: "Skill", slug: "packing", companion }, content: "x\n" },
        ])
      ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    }
  });

  it("does not destroy unrelated uncommitted work when materializing a committed changeset", async () => {
    await apply([put("first")]);
    writeFileSync(join(soulPath, "tracked-notes.md"), "committed baseline\n");
    execFileSync("git", ["add", "-A"], { cwd: soulPath });
    execFileSync("git", ["commit", "--quiet", "-m", "concurrent writer owned file"], {
      cwd: soulPath,
    });
    writeFileSync(join(soulPath, "tracked-notes.md"), "uncommitted concurrent edit\n");

    await apply([put("second")]);

    expect(readFileSync(join(soulPath, "tracked-notes.md"), "utf8")).toBe(
      "uncommitted concurrent edit\n"
    );
  });

  it("commits into a repository whose branch has no commit yet", async () => {
    // A changeset must carry a non-empty base, but an unborn branch has none — so "no base" needs
    // a value that says so rather than an empty string the validator rejects.
    expect(await store.baseCommit()).toBe("0".repeat(40));
    await expect(apply([put("triage")])).resolves.toMatchObject({ filesChanged: 1 });
  });

  it("deletes a file the layout registry does not recognize", async () => {
    // A file can arrive from the remote that this version has no layout for. If the gate refused
    // to delete it, the only way to remove it would be the raw filesystem bypass being eliminated.
    await apply([put("triage")]);
    writeFileSync(join(soulPath, "agents/triage/notes.md"), "from the remote\n");
    execFileSync("git", ["add", "-A"], { cwd: soulPath });
    execFileSync("git", ["commit", "--quiet", "-m", "stray"], { cwd: soulPath });

    const result = await apply([{ op: "deleteArtifact", kind: "Agent", slug: "triage" }]);

    expect(result.paths).toContain("agents/triage/notes.md");
    expect(existsSync(join(soulPath, "agents/triage"))).toBe(false);
  });

  it("still refuses to delete outside the tree", async () => {
    await apply([put("triage")]);

    await expect(
      writer.apply({
        subject: "soul: escape",
        source: "api",
        actor: ACTOR,
        businessId: "biz-1",
        changes: [{ op: "delete", target: { kind: "Agent", slug: "triage", companion: "x" } }],
      })
    ).rejects.toBeInstanceOf(SoulWriteError);
  });

  it("refuses to leave two definitions for one artifact", async () => {
    // A legacy `AGENT.md` beside a canonical `agent.yaml` is an ambiguity the loader could only
    // resolve by guessing. The writer will not silently delete the old one either — its body is
    // authored prose the canonical form splits into `instructions.md`.
    writeLegacyAgent("legacy");

    await expect(apply([put("legacy")])).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("accepts the canonical write once the changeset retires the legacy definition", async () => {
    writeLegacyAgent("legacy");

    const result = await apply([
      put("legacy"),
      {
        op: "put",
        target: { kind: "Agent", slug: "legacy", companion: "instructions.md" },
        content: "Body\n",
      },
      { op: "delete", target: { kind: "Agent", slug: "legacy", companion: "AGENT.md" } },
    ]);

    expect(existsSync(join(soulPath, "agents/legacy/AGENT.md"))).toBe(false);
    expect(existsSync(join(soulPath, "agents/legacy/agent.yaml"))).toBe(true);
    expect(result.filesChanged).toBe(3);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Commit an artifact in the superseded layout, as an older TulipFarm version would have left it. */
function writeLegacyAgent(slug: string): void {
  mkdirSync(join(soulPath, "agents", slug), { recursive: true });
  writeFileSync(join(soulPath, "agents", slug, "AGENT.md"), `---\nname: ${slug}\n---\nBody\n`);
  execFileSync("git", ["add", "-A"], { cwd: soulPath });
  execFileSync("git", ["commit", "--quiet", "-m", "legacy agent"], { cwd: soulPath });
}

describe("SoulWriter — superseded definition mode", () => {
  it("writes the superseded definition when the target names it", async () => {
    await apply([
      {
        op: "put",
        target: { kind: "Agent", slug: "triage", definitionMode: "legacy" },
        content: "---\nlabel: Triage\n---\nBody\n",
      },
    ]);

    expect(existsSync(join(soulPath, "agents/triage/AGENT.md"))).toBe(true);
    expect(existsSync(join(soulPath, "agents/triage/agent.yaml"))).toBe(false);
  });

  it("refuses a superseded write while the canonical definition survives", async () => {
    await apply([put("triage")]);

    await expect(
      apply([
        {
          op: "put",
          target: { kind: "Agent", slug: "triage", definitionMode: "legacy" },
          content: "---\nlabel: Triage\n---\nBody\n",
        },
      ])
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("refuses to address a superseded definition for a kind that has none", async () => {
    await expect(
      apply([
        {
          op: "put",
          target: { kind: "Skill", slug: "triage", definitionMode: "legacy" },
          content: "x",
        },
      ])
    ).rejects.toMatchObject({ code: "INVALID_TARGET" });
  });
});

describe("SoulWriter — degraded dependencies", () => {
  it("keeps a committed write when the remote push fails", async () => {
    const failing = new SoulWriter(store, logger, {
      hasRemote: true,
      push: async () => {
        throw new Error("remote unreachable");
      },
    });

    const result = await failing.apply({
      subject: "soul: add agent triage",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [put("triage")],
    });

    expect(result.pushed).toBe(false);
    expect(result.commitSha).toBeTruthy();
    expect(existsSync(join(soulPath, "agents/triage/agent.yaml"))).toBe(true);
  });

  it("keeps a committed write when the catalog reload fails", async () => {
    const failing = new SoulWriter(store, logger, undefined, {
      reload: async () => {
        throw new Error("loader exploded");
      },
    });

    const result = await failing.apply({
      subject: "soul: add agent triage",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [put("triage")],
    });

    expect(result.commitSha).toBeTruthy();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("reload"));
  });

  it("publishes the committed tree as a bundle so the Runtime sees the write", async () => {
    const publishCommittedTree = vi.fn(async () => undefined);
    const writer = new SoulWriter(store, logger, undefined, undefined, { publishCommittedTree });

    const result = await writer.apply({
      subject: "soul: add agent triage",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [put("triage")],
    });

    expect(publishCommittedTree).toHaveBeenCalledWith({
      commitSha: result.commitSha,
      actor: ACTOR,
    });
  });

  it("keeps a committed write when bundle publication fails", async () => {
    const writer = new SoulWriter(store, logger, undefined, undefined, {
      publishCommittedTree: async () => {
        throw new Error("publisher exploded");
      },
    });

    const result = await writer.apply({
      subject: "soul: add agent triage",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [put("triage")],
    });

    expect(result.commitSha).toBeTruthy();
    expect(existsSync(join(soulPath, "agents/triage/agent.yaml"))).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("bundle publication failed"));
  });

  it("reports an unpublished write so a caller cannot announce it as live", async () => {
    const writer = new SoulWriter(store, logger, undefined, undefined, {
      publishCommittedTree: async () => {
        throw new Error("publisher exploded");
      },
    });

    const result = await writer.apply({
      subject: "soul: add agent triage",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [put("triage")],
    });

    expect(result.published).toBe(false);
    expect(result.publicationError).toContain("publisher exploded");
  });

  it("reports a published write when the bundle publication lands", async () => {
    const writer = new SoulWriter(store, logger, undefined, undefined, {
      publishCommittedTree: async () => undefined,
    });

    const result = await writer.apply({
      subject: "soul: add agent triage",
      source: "api",
      actor: ACTOR,
      businessId: "biz-1",
      changes: [put("triage")],
    });

    expect(result.published).toBe(true);
    expect(result.publicationError).toBeUndefined();
  });
});
