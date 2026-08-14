/* Strip code before harvesting inline `#tag`s; headings (`# `) never match. */

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

/** Lowercase tags so chips and the case-sensitive server filter agree. */
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
