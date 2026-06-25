import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/*
 * Client-side OKF (Open Knowledge Format) serialize/parse — a small mirror of the backend's
 * `apps/api/src/knowledge/okf/{serialize,parse}.ts`, used only to round-trip the concept editor
 * between its "Guided" (structured fields) and "Raw" (whole markdown) tabs. The server remains the
 * source of truth: it re-parses/validates the submitted `content` and is the only authority on
 * whether a concept is valid OKF.
 *
 * An OKF concept is YAML frontmatter (delimited by `---`) followed by a markdown body. There are no
 * required fields; every frontmatter scalar is optional and omitted when empty (no frontmatter at all
 * when nothing is set).
 */

export type OkfFields = {
  title: string;
  description: string;
  resource: string;
  tags: string[];
  body: string;
};

export const EMPTY_OKF_FIELDS: OkfFields = {
  title: "",
  description: "",
  resource: "",
  tags: [],
  body: "",
};

// Matches the backend regex: an opening `---` line, the YAML block, a closing `---` line, then body.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Assemble the guided fields into the full OKF markdown string: optional scalars only when set, `tags`
// only when non-empty, then a blank line + body. Emits no frontmatter at all when nothing is set.
export function serializeOkf(fields: OkfFields): string {
  const fm: Record<string, unknown> = {};
  if (fields.title.trim()) fm.title = fields.title.trim();
  if (fields.description.trim()) fm.description = fields.description.trim();
  if (fields.resource.trim()) fm.resource = fields.resource.trim();
  if (fields.tags.length > 0) fm.tags = fields.tags;

  const body = fields.body.trim();
  if (Object.keys(fm).length === 0) return body.length > 0 ? `${body}\n` : "";
  const yamlBlock = stringifyYaml(fm).trimEnd();
  return body.length > 0 ? `---\n${yamlBlock}\n---\n\n${body}\n` : `---\n${yamlBlock}\n---\n`;
}

// Split a raw OKF string back into guided fields (for the raw → guided tab switch). Degrades
// gracefully like the backend parser: no frontmatter ⇒ the whole input is the body; non-string/
// missing fields fall back to empty. Never throws — the server does the real validation.
export function parseOkf(raw: string): OkfFields {
  const match = FRONTMATTER_RE.exec(raw);
  let fm: Record<string, unknown> = {};
  if (match) {
    try {
      fm = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
    } catch {
      fm = {};
    }
  }
  const body = (match ? match[2] : raw).trim();
  const tags = Array.isArray(fm.tags)
    ? fm.tags.filter((t): t is string => typeof t === "string")
    : [];
  return {
    title: asString(fm.title),
    description: asString(fm.description),
    resource: asString(fm.resource),
    tags,
    body,
  };
}
