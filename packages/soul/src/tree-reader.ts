import { basename } from "node:path";
import {
  type ClassifiedSoulPath,
  type ContentMode,
  classifySoulPath,
  type LlmConfig,
  type VersionedSchemaDocument,
  validateSoulConfig,
} from "@tulipfarm/schema";
import simpleGit, { type SimpleGit } from "simple-git";
import { parse as parseYaml } from "yaml";
import { agentDocumentFromLegacy, defaultModelProfile } from "./agent-documents";
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

/** The Agent definition a path addresses, by kind and format, or `null` when it addresses none. */
function agentDefinitionAt(path: string): { slug: string; legacy: boolean } | null {
  const location = classifySoulPath(path);
  if (location === null || location.kind !== "Agent" || !location.definition) return null;
  if (location.slug === null || location.slug === undefined) return null;
  return { slug: location.slug, legacy: location.modes.includes("legacy") };
}

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
    const llm = await this.llmConfig(commitSha, paths);
    if (llm !== undefined) definitions.push(...modelProfileDocuments(llm));
    // No configured LLM means no ModelProfile to reference, so Agents stay unprojected.
    const modelProfile = defaultModelProfile(llm);

    // A canonical `agent.yaml` supersedes the legacy file beside it; projecting both would put two
    // definitions on one slug.
    const canonicalAgents = new Set(
      paths.flatMap((path) => {
        const agent = agentDefinitionAt(path);
        return agent === null || agent.legacy ? [] : [agent.slug];
      })
    );

    for (const path of paths) {
      if (!isBundledDefinitionPath(path)) continue;
      const content = await this.content(commitSha, path);
      const parsed = parseSoulFile({ operation: "upsert", path, content });
      if (parsed.issue !== undefined) throw invalidDefinitionError(parsed.issue);
      if (parsed.parsed?.definition !== undefined) {
        definitions.push(parsed.parsed.definition.document);
        continue;
      }
      if (modelProfile === undefined) continue;
      const agent = agentDefinitionAt(path);
      if (agent === null || !agent.legacy || canonicalAgents.has(agent.slug)) continue;
      const projected = agentDocumentFromLegacy(agent.slug, content, modelProfile, basename(path));
      if (projected !== undefined) definitions.push(projected);
    }
    return definitions;
  }

  /** `soul.yaml#llm`, or `undefined` when the tree carries no configuration to read. */
  private async llmConfig(
    commitSha: string,
    paths: readonly string[]
  ): Promise<LlmConfig | undefined> {
    if (!paths.includes("soul.yaml")) return undefined;
    // An empty or comment-only `soul.yaml` — what a scaffolded Soul ships — parses to `null`,
    // which is no configuration rather than invalid configuration. Validating it would fail every
    // publication of the whole tree.
    const manifest = parseYaml(await this.content(commitSha, "soul.yaml")) as
      | Record<string, unknown>
      | null
      | undefined;
    if (manifest === undefined || manifest === null) return undefined;
    return validateSoulConfig(manifest).llm;
  }

  async readFiles(commitSha: string): Promise<readonly BundleSourceFile[]> {
    const files: BundleSourceFile[] = [];
    for (const path of await this.paths(commitSha)) {
      // A projected Agent declares its legacy AGENT.md as its instructions companion, and the
      // compiler refuses a declared companion that is not among the bundle's source files.
      if (!isBundledSourceFilePath(path) && agentDefinitionAt(path)?.legacy !== true) continue;
      files.push({ path, content: await this.content(commitSha, path) });
    }
    return files;
  }
}
