import { parse as parseYaml } from "yaml";

/** Legacy Markdown frontmatter parser shared by read and write paths; pure, no I/O. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedFrontmatter {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/** No frontmatter is valid: callers use an empty object to distinguish plain prose. */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const frontmatter = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  return { frontmatter, body: match[2].trim() };
}
