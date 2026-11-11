const rowChange =
  /\b(?:add|insert|append|put|include|create|prepare|draft|propose|generate|change|update|edit|set|delete|remove)\b[^.?!]*\b(?:rows?|items?|records?|entr(?:y|ies)|lines?)\b/i;
const review = /\b(?:review|approv\w*|propos\w*|draft)\b/i;
const createCard = /\b(?:create|make|prepare|show|give|produce|try)\b[^.?!]*\b(?:review|approval) card\b/i;
export const tableCreationRequest =
  /\bnew\s+tables?\b|\b(?:create|make|build|set up)\s+(?:(?:a|an|the|new)\s+)*(?:[\w-]+\s+)?tables?\b/i;

/** Only human requests establish review intent; a card retry inherits the preceding human row request. */
export function requestedRowReview(human: readonly string[]) {
  const latest = human.at(-1) ?? '';
  if (
    /^(?:how|what|why|explain)\b/i.test(latest.trim()) ||
    /\b(?:do not|don't|never) (?:add|create|prepare|propose|draft)\b/i.test(latest)
  )
    return undefined;
  if (rowChange.test(latest) && review.test(latest) && !tableCreationRequest.test(latest)) return latest;
  const previous = human.at(-2);
  return createCard.test(latest) && previous && rowChange.test(previous) && !tableCreationRequest.test(previous)
    ? `${previous}\n${latest}`
    : undefined;
}
