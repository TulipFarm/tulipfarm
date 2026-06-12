import { MAX_HISTORY_TOKENS, RECENT_RETENTION_TOKENS } from "../memory/limits";
import {
  type CompactionCutoff,
  fromSummary,
  type MessageDoc,
  type MessagePart,
  type MessageRepo,
} from "./messages";

/**
 * Conversation compaction (CTX-V1-001/002). Statelessness is preserved — the prompt is
 * rebuilt every turn from durable rows; compaction only changes *which* history rows are
 * included. When a turn's estimated tokens exceed `MAX_HISTORY_TOKENS`, the oldest turns
 * are summarized once into a durable `summary` row and the recent turns stay verbatim.
 *
 * Token counts are a coarse char heuristic (no tokenizer dependency); a generous budget
 * with headroom under the model's context window makes the imprecision harmless.
 */

/** Flatten a message's content to the text used for the char-based token estimate. */
function contentText(content: string | MessagePart[]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** Coarse token estimate for a string: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sum the token estimate across a list of message rows. */
export function estimateDocsTokens(docs: MessageDoc[]): number {
  return docs.reduce((n, d) => n + estimateTokens(contentText(d.content)), 0);
}

/** `(createdAt, _id)` ordering: is `d` strictly newer than the cutoff? */
function isAfter(d: MessageDoc, cutoff: CompactionCutoff): boolean {
  const dt = d.createdAt.getTime();
  const ct = cutoff.createdAt.getTime();
  if (dt !== ct) return dt > ct;
  return d._id > cutoff._id;
}

/**
 * Read-path filter applied EVERY turn (statelessness). Given the rows ordered oldest→newest,
 * resolve the effective history: keep only the latest `summary` row plus the non-summary rows
 * newer than its cutoff. With no summary present, the rows pass through unchanged. A newer
 * summary therefore supersedes (and drops) any older summary — there is only ever one.
 */
export function applySummaryFilter(docs: MessageDoc[]): MessageDoc[] {
  let latest: MessageDoc | undefined;
  for (const d of docs) {
    if (d.role === "summary") latest = d; // rows are ordered, so the last summary seen wins
  }
  if (!latest) return docs;
  const cutoff = (latest.metadata?.compactedThrough ?? {
    createdAt: latest.createdAt,
    _id: latest._id,
  }) as CompactionCutoff;
  const verbatim = docs.filter((d) => d.role !== "summary" && isAfter(d, cutoff));
  return [latest, ...verbatim];
}

/**
 * Choose the cut between summarized-oldest and kept-verbatim. Walks newest→oldest accumulating
 * the estimate until it exceeds `RECENT_RETENTION_TOKENS`, then snaps the boundary to a `user`
 * row so the verbatim region always begins with a user turn (valid message sequence; whole
 * user→assistant→tool turns stay intact). Returns the index of the first kept (verbatim) row.
 */
export function computeCut(docs: MessageDoc[]): number {
  let acc = 0;
  let cut = 0;
  for (let i = docs.length - 1; i >= 0; i--) {
    acc += estimateTokens(contentText(docs[i].content));
    if (acc > RECENT_RETENTION_TOKENS) {
      cut = i + 1;
      break;
    }
  }
  const userIdx = docs.flatMap((d, i) => (d.role === "user" ? [i] : []));
  if (userIdx.length === 0) return docs.length; // no safe boundary → caller skips compaction
  const forward = userIdx.find((i) => i >= cut);
  return forward ?? userIdx[userIdx.length - 1];
}

/** Render the to-be-summarized rows to a plain role-labelled transcript for the LLM. */
function renderTranscript(docs: MessageDoc[]): string {
  return docs.map((d) => `${d.role}: ${contentText(d.content)}`).join("\n\n");
}

export interface CompactHistoryArgs {
  /** Raw rows from `listByConversation`, oldest→newest. */
  docs: MessageDoc[];
  conversationId: string;
  /** Estimated tokens for everything outside history (system prompt + current user message). */
  extraTokens: number;
  messageRepo: MessageRepo;
  /** Summarize a transcript via the LLM quick tier. */
  summarize: (transcript: string) => Promise<string>;
  log: { error: (obj: unknown, msg?: string) => void };
}

/**
 * Resolve the history rows to render for this turn. Always applies the summary filter; only when
 * the estimate is over budget does it run exactly one summarization pass: summarize the oldest
 * turns, persist a durable `summary` row, and return `[summary, ...verbatim]`. A summarize failure
 * degrades gracefully to the un-summarized (filtered) history so the turn still runs.
 */
export async function compactHistory(args: CompactHistoryArgs): Promise<MessageDoc[]> {
  const { docs, conversationId, extraTokens, messageRepo, summarize, log } = args;
  const filtered = applySummaryFilter(docs);

  if (estimateDocsTokens(filtered) + extraTokens <= MAX_HISTORY_TOKENS) return filtered;

  const cut = computeCut(filtered);
  const toSummarize = filtered.slice(0, cut);
  const verbatim = filtered.slice(cut);
  if (toSummarize.length === 0 || verbatim.length === 0) return filtered; // nothing safe to compact

  const last = toSummarize[toSummarize.length - 1];
  // Summarize + persist are both best-effort: any failure (LLM throw, quick tier unconfigured,
  // or a persistence error) degrades to the un-summarized history so the turn still runs.
  try {
    const text = await summarize(renderTranscript(toSummarize));
    const summary = fromSummary(conversationId, text, {
      createdAt: last.createdAt,
      _id: last._id,
    });
    await messageRepo.create(summary);
    return [summary, ...verbatim];
  } catch (err) {
    log.error(
      { err, conversationId },
      "history compaction: summarize/persist failed; sending full history"
    );
    return filtered;
  }
}
