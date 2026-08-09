import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { GitSoulTreeReader } from "./tree-reader";

const TMP = join(import.meta.dirname, "__tree_reader_tmp__");

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  const git = simpleGit(TMP);
  await git.init();
  await git.addConfig("user.email", "test@tulipfarm.dev");
  await git.addConfig("user.name", "TulipFarm Test");
});

afterEach(() => rm(TMP, { recursive: true, force: true }));

describe("GitSoulTreeReader", () => {
  it("derives published ModelProfiles from soul.yaml and ignores the retired models directory", async () => {
    await writeFile(
      join(TMP, "soul.yaml"),
      stringifyYaml({
        llm: {
          tiers: {
            quick: { providers: [{ provider: "openai", model: "gpt-fast" }] },
            standard: { providers: [{ provider: "openai", model: "gpt-balanced" }] },
            complex: { providers: [{ provider: "openai", model: "gpt-thorough" }] },
          },
          presets: {
            default: "balanced",
            fast: "fast",
            balanced: "balanced",
            thorough: "thorough",
          },
        },
      }),
      "utf8"
    );
    await mkdir(join(TMP, "models"));
    await writeFile(join(TMP, "models", "stale.yaml"), "not: a definition\n", "utf8");
    const git = simpleGit(TMP);
    await git.add("-A");
    await git.commit("test fixture");
    const sha = await git.revparse(["HEAD"]);

    const documents = await new GitSoulTreeReader(TMP).readDefinitions(sha.trim());

    expect(documents.filter((document) => document.kind === "ModelProfile")).toHaveLength(3);
    expect(
      documents.map((document) => (document.metadata as Record<string, unknown>)?.slug)
    ).toEqual(["fast", "balanced", "thorough"]);
    expect(JSON.stringify(documents)).not.toContain("stale");
  });
});
