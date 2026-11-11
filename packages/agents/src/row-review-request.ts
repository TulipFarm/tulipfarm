const review =
  /\b(?:review\w*|approv\w*|propos\w*|draft\w*|preview\w*|before|until|first|check|look|confirm\w*|sign.?off)\b/i;
const rowChange = /\b(?:rows?|items?|records?|entr(?:y|ies)|lines?)\b/i;
const card = /\bcard\b/i;
export const tableCreationRequest =
  /\bnew\s+tables?\b|\b(?:create|make|build|set up)\s+(?:(?:a|an|the|new)\s+)*(?:[\w-]+\s+)?tables?\b/i;

/** A high-recall prefilter, not an intent decision. Writes err toward review; completion uses the checker. */
export function rowReviewPrefilter(human: readonly string[]) {
  const latest = human.at(-1) ?? '';
  const previous = human.at(-2);
  if (review.test(latest) && card.test(latest) && previous && rowChange.test(previous)) return `${previous}\n${latest}`;
  return review.test(latest) ? latest : undefined;
}
