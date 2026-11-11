import { z } from 'zod';

const review =
  /\b(?:review\w*|approv\w*|propos\w*|draft\w*|preview\w*|before|until|first|check|look|confirm\w*|sign.?off)\b/i;
const rowChange = /\b(?:rows?|items?|records?|entr(?:y|ies)|lines?)\b/i;
const card = /\bcards?\b/i;
const insert = /\b(?:add|insert|append)\b/i;
export type RowReviewTurn = {
  role: 'user' | 'assistant';
  text: string;
  rowReviews?: readonly { table: string; input: unknown }[];
};
export const tableCreationRequest =
  /\bnew\s+tables?\b|\b(?:create|make|build|set up)\s+(?:(?:a|an|the|new)\s+)*(?:[\w-]+\s+)?tables?\b/i;

/** A high-recall prefilter, not an intent decision. Writes err toward review; completion uses the checker. */
export function rowReviewPrefilter(turns: readonly RowReviewTurn[], tables: readonly string[] = []) {
  const recent = [...turns].reverse();
  const index = recent.findIndex(turn => turn.role === 'user');
  const latest = recent[index]?.text ?? '';
  const previous = recent[index + 1];
  const human = recent.slice(index + 1).find(turn => turn.role === 'user')?.text;
  const rowContext = (text: string) =>
    rowChange.test(text) || insert.test(text) || tables.some(table => mentionsTable(text, table));
  if (
    human &&
    rowContext(human) &&
    ((review.test(latest) && card.test(latest)) ||
      (previous?.role === 'assistant' &&
        reviewClaim(previous.text) &&
        !previous.rowReviews?.some(receipt => rowReviewMatches(human, receipt.input, receipt.table))))
  )
    return `${human}\n${latest}`;
  return review.test(latest) && rowContext(latest) ? latest : undefined;
}

function reviewClaim(text: string) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .some(
      sentence =>
        !sentence.trim().endsWith('?') &&
        sentence
          .split(/[;:,]|\s(?:but|and|so|because)\s/i)
          .some(
            clause =>
              /\b(?:review\w*|approv\w*|propos\w*|draft\w*)\b/i.test(clause) &&
              (rowChange.test(clause) || card.test(clause)) &&
              !/\b(?:no|not|never|nothing|cannot|unable|without)\b|n['’]t\b/i.test(clause),
          ),
    );
}

export function mentionsTable(text: string, table: string) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${table.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')}(?![\\p{L}\\p{N}_])`,
    'iu',
  ).test(text);
}

export function rowReviewMatches(request: string, input: unknown, table?: string) {
  if (table && !mentionsTable(request, table)) return false;
  if (!input || typeof input !== 'object') return false;
  const call = z.object({ rows: z.array(z.unknown()).optional() }).safeParse(input);
  if (!call.success) return false;
  const count = request.match(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:new\s+)?(?:rows?|records?|entries|items?)\b/i,
  )?.[1];
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return !count || (Number(count) || words.indexOf(count.toLowerCase()) + 1) === (call.data.rows?.length ?? 1);
}
