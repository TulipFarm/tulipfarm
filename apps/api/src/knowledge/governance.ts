import type { KnowledgeDocument } from "./types";

export const PER_DOC_CHAR_CAP = 4000;
export const BLOCK_CHAR_CAP = 16000;
const WRAPPER_OVERHEAD = "<governance-knowledge>\n".length + "\n</governance-knowledge>".length;

/**
 * Build the `<governance-knowledge>` context block (KN-V1-005). Input is the set of
 * active `alwaysLoadForAgents` docs. Scoping: docs matching `domain` first, then
 * tenant-wide (`domain === null`); other domains are excluded. Budget: a doc longer
 * than `PER_DOC_CHAR_CAP` is skipped entirely (never truncated mid-doc), and docs are
 * added until the next would exceed `BLOCK_CHAR_CAP` — overflow is skipped, not
 * partially rendered. Returns "" when nothing qualifies.
 */
export function buildGovernanceBlock(
  docs: KnowledgeDocument[],
  domain: string | null = null
): string {
  const scoped = domain !== null ? docs.filter((d) => d.domain === domain) : [];
  const tenant = docs.filter((d) => d.domain === null);
  const ordered = [...scoped, ...tenant];

  const rendered: string[] = [];
  let used = WRAPPER_OVERHEAD; // budget the <governance-knowledge> wrapper against the block cap
  for (const doc of ordered) {
    const body = doc.plainText.trim();
    if (body.length > PER_DOC_CHAR_CAP) continue;
    const piece = `## ${doc.title}\n${body}`;
    const addition = (rendered.length > 0 ? 1 : 0) + piece.length;
    if (used + addition > BLOCK_CHAR_CAP) continue;
    rendered.push(piece);
    used += addition;
  }

  if (rendered.length === 0) return "";
  return `<governance-knowledge>\n${rendered.join("\n")}\n</governance-knowledge>`;
}
