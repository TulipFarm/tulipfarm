import { parse as parseYaml } from "yaml";

/**
 * YAML frontmatter parsing for the Markdown-bodied authored artifacts (`AGENT.md`, `SKILL.md`).
 *
 * This lives beside the schemas that validate what it produces, not in the loader that happens to
 * read the file: the same bytes are parsed on the write path (before a change is admitted) and on
 * the read path (when the tree is loaded), and those two must not drift. It is pure — no I/O.
 *
 * The canonical `apiVersion`/`kind` layout supersedes frontmatter-as-configuration, so this is a
 * migration-scoped contract: it parses the legacy format faithfully and gains no new features.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedFrontmatter {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/**
 * Split a Markdown document into its YAML frontmatter and body.
 *
 * A document with no frontmatter block yields an empty `frontmatter` and the whole document as the
 * body — the caller distinguishes "legacy definition" from "plain prose" by that emptiness, so the
 * absence of a block must stay a valid parse rather than an error.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const frontmatter = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  return { frontmatter, body: match[2].trim() };
}
