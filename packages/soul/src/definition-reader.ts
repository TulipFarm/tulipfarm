import { join } from "node:path";
import {
  type ArtifactKind,
  definitionPath,
  legacyDefinitionCandidates,
  parseFrontmatter,
} from "@tulipfarm/schema";
import { parse as parseYaml } from "yaml";
import { readContainedFile } from "./safe-fs";

/** Reader and writer both resolve definition paths from the schema registry to prevent drift. */

export interface ResolvedDefinition {
  /** Repo-relative path the definition was actually read from. */
  readonly path: string;
  readonly content: string;
  /** True when the file is a superseded filename still carrying configuration. */
  readonly legacy: boolean;
}

/** Reads a file, returning `undefined` for ENOENT and rethrowing anything else. */
async function readIfPresent(soulPath: string, path: string): Promise<string | undefined> {
  try {
    return await readContainedFile(soulPath, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Canonical first, then each legacy filename in registry order. Returns `undefined` when the
 * directory holds no definition at all — the caller decides whether that is fatal.
 */
export async function resolveDefinition(
  soulPath: string,
  kind: ArtifactKind,
  slug: string
): Promise<ResolvedDefinition | undefined> {
  const canonical = definitionPath(kind, slug);
  const content = await readIfPresent(soulPath, join(soulPath, canonical));
  if (content !== undefined) return { path: canonical, content, legacy: false };

  for (const path of legacyDefinitionCandidates(kind, slug)) {
    const legacyContent = await readIfPresent(soulPath, join(soulPath, path));
    if (legacyContent !== undefined) return { path, content: legacyContent, legacy: true };
  }
  return undefined;
}

/** Legacy agent/skill view: frontmatter plus body recomposed from the canonical envelope. */
export interface FrontmatterArtifact {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inverse of conversion: spec fields become frontmatter, instructions path becomes body. */
export async function readFrontmatterArtifact(
  soulPath: string,
  _kind: ArtifactKind,
  _slug: string,
  definition: ResolvedDefinition
): Promise<FrontmatterArtifact> {
  if (definition.legacy) {
    const { frontmatter, body } = parseFrontmatter(definition.content);
    return { frontmatter, body };
  }

  const document = parseYaml(definition.content);
  if (!isRecord(document)) {
    throw new Error(`${definition.path}: expected a YAML mapping`);
  }
  const spec = isRecord(document.spec) ? document.spec : {};
  const metadata = isRecord(document.metadata) ? document.metadata : {};

  const { instructions, ...rest } = spec;
  const frontmatter: Record<string, unknown> = { ...rest };
  if (typeof metadata.displayName === "string") frontmatter.name = metadata.displayName;
  if (typeof metadata.description === "string") frontmatter.description = metadata.description;

  // The body lives in the companion the definition points at. A definition that names a companion
  // it does not have is malformed, not empty — surface it rather than loading a blank agent.
  const pointer = isRecord(instructions) ? instructions.path : undefined;
  if (typeof pointer !== "string") return { frontmatter, body: "" };

  const directory = definition.path.slice(0, definition.path.lastIndexOf("/"));
  const body = await readIfPresent(soulPath, join(soulPath, directory, pointer));
  if (body === undefined) {
    throw new Error(`${definition.path}: instructions companion "${pointer}" is missing`);
  }
  return { frontmatter, body };
}
