import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmacCommitSigner } from "./commit-signing";
import { SoulGitStore } from "./git-store";

let root: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(path: string, content: string, message: string): string {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  git("add", "--", path);
  git("commit", "--quiet", "-m", message);
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".soul-path-history-"));
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "bot@example.com");
  git("config", "user.name", "bot");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SoulGitStore.lastCommitForPath", () => {
  it("returns the artifact-scoped revision instead of repository HEAD", async () => {
    const artifactRevision = commit(
      "integrations/weather-v1/oim.yml",
      "kind: Integration\n",
      "install weather"
    );
    const head = commit("agents/helper/agent.yaml", "kind: Agent\n", "add unrelated agent");
    const store = new SoulGitStore(root, createHmacCommitSigner("test", "secret"), {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    expect(head).not.toBe(artifactRevision);
    await expect(store.lastCommitForPath("integrations/weather-v1")).resolves.toBe(
      artifactRevision
    );
    await expect(store.lastCommitForPath("integrations/missing")).resolves.toBeNull();
    await expect(store.lastCommitForPath("../outside")).resolves.toBeNull();
  });
});
