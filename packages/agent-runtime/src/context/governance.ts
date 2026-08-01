/**
 * The part of a knowledge page this block renders. Structural on purpose: a store's page record
 * carries far more (ids, versions, tags, OKF fields), and none of it belongs in a prompt.
 */
export interface GovernancePage {
  readonly title: string;
  readonly plainText: string;
  readonly domain: string | null;
}

export const PER_DOC_CHAR_CAP = 4000;
export const BLOCK_CHAR_CAP = 16000;
const WRAPPER_OVERHEAD = "<governance-knowledge>\n".length + "\n</governance-knowledge>".length;

/**
 * Build the `<governance-knowledge>` context block (KN-V1-005). Input is the set of
 * active `alwaysLoadForAgents` pages. Scoping: pages matching `domain` first, then
 * tenant-wide (`domain === null`); other domains are excluded. Budget: a page longer
 * than `PER_DOC_CHAR_CAP` is skipped entirely (never truncated mid-page), and pages are
 * added until the next would exceed `BLOCK_CHAR_CAP` — overflow is skipped, not
 * partially rendered. Returns "" when nothing qualifies.
 */
export function buildGovernanceBlock(
  pages: readonly GovernancePage[],
  domain: string | null = null
): string {
  const scoped = domain !== null ? pages.filter((p) => p.domain === domain) : [];
  const tenant = pages.filter((p) => p.domain === null);
  const ordered = [...scoped, ...tenant];

  const rendered: string[] = [];
  let used = WRAPPER_OVERHEAD; // budget the <governance-knowledge> wrapper against the block cap
  for (const page of ordered) {
    const body = page.plainText.trim();
    if (body.length > PER_DOC_CHAR_CAP) continue;
    const piece = `## ${page.title}\n${body}`;
    const addition = (rendered.length > 0 ? 1 : 0) + piece.length;
    if (used + addition > BLOCK_CHAR_CAP) continue;
    rendered.push(piece);
    used += addition;
  }

  if (rendered.length === 0) return "";
  return `<governance-knowledge>\n${rendered.join("\n")}\n</governance-knowledge>`;
}
