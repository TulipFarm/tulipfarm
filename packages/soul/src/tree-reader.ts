import { type LlmConfig, type VersionedSchemaDocument, validateLlmConfig } from "@tulipfarm/schema";
import simpleGit, { type SimpleGit } from "simple-git";
import { parse as parseYaml } from "yaml";
import type { BundleSourceFile } from "./compiler";
import { modelProfileDocuments } from "./model-profile-documents";
import { parseSoulFile } from "./parse";
import type { SoulTreeReader } from "./publication";

const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const DEFINITION_FILE =
  /(?:^|\/)(?:agent|skill)\.ya?ml$|^(?:tools|routines|triggers|roles|guardrails|knowledge|forms)\/[^/]+\.ya?ml$|^integrations\/.+\.ya?ml$/;
const SKILL_COMPANION = /^skills\/[^/]+\/(?!skill\.ya?ml$).+$/;

export class GitSoulTreeReader implements SoulTreeReader {
  private readonly git: SimpleGit;

  constructor(soulPath: string) {
    this.git = simpleGit(soulPath);
  }

  private async paths(commitSha: string): Promise<string[]> {
    if (!COMMIT_SHA.test(commitSha)) throw new Error("invalid_soul_commit");
    const output = await this.git.raw(["ls-tree", "-r", "--name-only", commitSha]);
    return output
      .split("\n")
      .filter((path) => path.length > 0)
      .sort();
  }

  private async content(commitSha: string, path: string): Promise<string> {
    return this.git.raw(["show", `${commitSha}:${path}`]);
  }

  async readDefinitions(commitSha: string): Promise<readonly VersionedSchemaDocument[]> {
    const definitions: VersionedSchemaDocument[] = [];
    const paths = await this.paths(commitSha);
    for (const path of paths) {
      if (!DEFINITION_FILE.test(path)) continue;
      const parsed = parseSoulFile({
        operation: "upsert",
        path,
        content: await this.content(commitSha, path),
      });
      if (parsed.parsed?.definition !== undefined) {
        definitions.push(parsed.parsed.definition.document);
      }
    }
    if (paths.includes("soul.yaml")) {
      const manifest = parseYaml(await this.content(commitSha, "soul.yaml")) as
        | Record<string, unknown>
        | undefined;
      if (manifest?.llm !== undefined) {
        definitions.push(...modelProfileDocuments(validateLlmConfig(manifest.llm as LlmConfig)));
      }
    }
    return definitions;
  }

  async readFiles(commitSha: string): Promise<readonly BundleSourceFile[]> {
    const files: BundleSourceFile[] = [];
    for (const path of await this.paths(commitSha)) {
      if (!SKILL_COMPANION.test(path)) continue;
      files.push({ path, content: await this.content(commitSha, path) });
    }
    return files;
  }
}
