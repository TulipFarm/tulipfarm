/** Structural prompt page input; store-only fields must not reach prompts. */
export interface GovernancePage {
  readonly title: string;
  readonly plainText: string;
  readonly domain: string | null;
}

export const PER_DOC_CHAR_CAP = 4000;
export const BLOCK_CHAR_CAP = 16000;
const WRAPPER_OVERHEAD = "<governance-knowledge>\n".length + "\n</governance-knowledge>".length;

/** Build `<governance-knowledge>` from scoped pages; skip over-budget pages whole. */
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
