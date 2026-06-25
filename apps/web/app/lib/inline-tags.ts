/*
 * Extract inline `#tag` tokens from a markdown body so they can be unioned into the concept's
 * frontmatter `tags` on save — keeping the stored `tags[]` (and its server-side filtering)
 * authoritative. Headings (`# Heading`, hash + space) never match; fenced/inline code is stripped
 * first so `#include`-style tokens in code blocks aren't harvested as tags.
 */

// `#` + a LETTER-led slug (the letter-first rule excludes numeric refs like `#123`).
const TAG_RE = /(^|[\s(])#([a-z][a-z0-9_-]*)/gi;

function stripCode(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
}

/** Inline tags found in the body, lowercased + deduped, in first-seen order. */
export function extractInlineTags(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of stripCode(body).matchAll(TAG_RE)) {
    const tag = m[2].toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/**
 * Union existing frontmatter tags with inline body tags, lowercased + deduped (existing first).
 * Lowercasing keeps stored tags consistent with the `#tag` chip/pill links and the case-sensitive
 * `tags @> …` server filter, so the tag-listing route always matches.
 */
export function mergeTags(frontmatter: string[], body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...frontmatter, ...extractInlineTags(body)]) {
    const tag = t.toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}
