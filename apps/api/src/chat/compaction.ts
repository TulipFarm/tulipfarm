import { MAX_HISTORY_TOKENS, RECENT_RETENTION_TOKENS } from "@tulipfarm/memory";
import {
  type CompactionCutoff,
  fromSummary,
  type MessageDoc,
  type MessagePart,
  type MessageRepo,
} from "./messages";

/** CTX-V1-001/002: compact only by durable summary rows; token counts are coarse. */

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

/** Every turn keeps only the latest summary plus rows newer than its cutoff. */
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

/** Cut at a user row so the verbatim region starts with a valid whole turn. */
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
  /** Optional Episode sink; must not trigger another summary or decide turn execution. */
  episodeRecorder?: {
    recordConversationEpisode(input: {
      readonly conversationId: string;
      readonly summary: string;
      readonly decisions?: readonly string[];
      readonly outcome?: string;
    }): Promise<void>;
  };
  log: { error: (obj: unknown, msg?: string) => void };
}

/** Apply summaries every turn; on over-budget, run one best-effort summarization pass. */
export async function compactHistory(args: CompactHistoryArgs): Promise<MessageDoc[]> {
  const { docs, conversationId, extraTokens, messageRepo, summarize, log } = args;
  const filtered = applySummaryFilter(docs);

  if (estimateDocsTokens(filtered) + extraTokens <= MAX_HISTORY_TOKENS) return filtered;

  const cut = computeCut(filtered);
  const toSummarize = filtered.slice(0, cut);
  const verbatim = filtered.slice(cut);
  if (toSummarize.length === 0 || verbatim.length === 0) return filtered; // nothing safe to compact

  const last = toSummarize[toSummarize.length - 1];
  // Summarize + persist are best-effort; failures leave the turn running with filtered history.
  try {
    const text = await summarize(renderTranscript(toSummarize));
    const summary = fromSummary(conversationId, text, {
      createdAt: last.createdAt,
      _id: last._id,
    });
    await messageRepo.create(summary);
    try {
      await args.episodeRecorder?.recordConversationEpisode({
        conversationId,
        summary: text,
        outcome: "history compacted",
      });
    } catch (err) {
      log.error(
        { err, conversationId },
        "history compaction: episode persist failed; keeping compacted summary"
      );
    }
    return [summary, ...verbatim];
  } catch (err) {
    log.error(
      { err, conversationId },
      "history compaction: summarize/persist failed; sending full history"
    );
    return filtered;
  }
}
