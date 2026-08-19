import {
  type ClassifiedSoulPath,
  type ContentMode,
  classifySoulPath,
  type VersionedSchemaDocument,
  validateSoulConfig,
} from "@tulipfarm/schema";
import simpleGit, { type SimpleGit } from "simple-git";
import { parse as parseYaml } from "yaml";
import type { BundleSourceFile } from "./compiler";
import { hermeticGitEnv } from "./git-env";
import { modelProfileDocuments } from "./model-profile-documents";
import { parseSoulFile } from "./parse";
import type { SoulTreeReader } from "./publication";

const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BUNDLED_DEFINITION_CONTENT_MODES = new Set<ContentMode>([
  "definition",
  "legacy",
  "delegated",
]);
const BUNDLED_FILE_CONTENT_MODES = new Set<ContentMode>(["prose", "executable", "delegated"]);

// Bundle membership is a distribution decision: only machine-managed state stays out.
// `temporalClass` is orthogonal — it selects which digest a reader uses. Pinned readers use the
// Run's digest; live authority readers use the active digest. Invariant 2 in
// docs/architecture/authorization-design.md is enforced by PinnedDefinitionLoader refusing live
// kinds, not by excluding authority from the signed bundle distribution channel.
function isBundledAuthoredContent(location: ClassifiedSoulPath): boolean {
  return !location.modes.includes("managed");
}

export function isBundledDefinitionPath(path: string): boolean {
  const location = classifySoulPath(path);
  if (location === null) return false;
  return (
    location.definition &&
    isBundledAuthoredContent(location) &&
    location.modes.some((mode) => BUNDLED_DEFINITION_CONTENT_MODES.has(mode))
  );
}

export function isBundledSourceFilePath(path: string): boolean {
  const location = classifySoulPath(path);
  if (location === null) return false;
  return (
    isBundledAuthoredContent(location) &&
    location.modes.some((mode) => BUNDLED_FILE_CONTENT_MODES.has(mode))
  );
}

function invalidDefinitionError(issue: NonNullable<ReturnType<typeof parseSoulFile>["issue"]>) {
  const field = issue.field === undefined ? "" : ` at ${issue.field}`;
  return new Error(`SOUL_DEFINITION_INVALID: ${issue.code} in ${issue.path}${field}`);
}

export class GitSoulTreeReader implements SoulTreeReader {
  private handle: SimpleGit | undefined;

  constructor(private readonly soulPath: string) {}

  /** `show` constructs simple-git after mkdir because simple-git throws if the cwd is absent. */
  private get git(): SimpleGit {
    if (!this.handle) this.handle = simpleGit(this.soulPath).env(hermeticGitEnv());
    return this.handle;
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
      if (!isBundledDefinitionPath(path)) continue;
      const parsed = parseSoulFile({
        operation: "upsert",
        path,
        content: await this.content(commitSha, path),
      });
      if (parsed.issue !== undefined) throw invalidDefinitionError(parsed.issue);
      if (parsed.parsed?.definition !== undefined) {
        definitions.push(parsed.parsed.definition.document);
      }
    }
    if (paths.includes("soul.yaml")) {
      // An empty or comment-only `soul.yaml` — what a scaffolded Soul ships — parses to `null`,
      // which is no configuration rather than invalid configuration. Validating it would fail every
      // publication of the whole tree.
      const manifest = parseYaml(await this.content(commitSha, "soul.yaml")) as
        | Record<string, unknown>
        | null
        | undefined;
      if (manifest !== undefined && manifest !== null) {
        const config = validateSoulConfig(manifest);
        if (config.llm !== undefined) {
          definitions.push(...modelProfileDocuments(config.llm));
        }
      }
    }
    return definitions;
  }

  async readFiles(commitSha: string): Promise<readonly BundleSourceFile[]> {
    const files: BundleSourceFile[] = [];
    for (const path of await this.paths(commitSha)) {
      if (!isBundledSourceFilePath(path)) continue;
      files.push({ path, content: await this.content(commitSha, path) });
    }
    return files;
  }
}
