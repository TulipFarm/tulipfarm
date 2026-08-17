/**
 * Citation checking: a filter, not a proof.
 *
 * The model proposes durable writes to a user's Memory and to the whole business's Knowledge, so
 * every claim must name evidence and the server must find that evidence in the exact input the Run
 * was pinned to. What this rules out is a claim invented from nothing, a claim sourced from a Tool
 * result or an Integration payload rather than a person, and a claim that reaches across Runs.
 *
 * What it deliberately does not attempt is entailment. A quote can resolve, be user-authored, and
 * still not support the claim built on it; the only honest check for that is another model pass,
 * which is not this. A lexical proxy would be worse than none — "keep it short" does not share a
 * token with "prefers concise answers", and rejecting that would train the loop to stop learning.
 */

/** One Turn as pinned input: only what the person themselves wrote. */
export interface CitableTurn {
  readonly turnId: string;
  /**
   * The user's own message text. Tool results, Integration payloads and assistant output are
   * excluded by the caller — content the user did not author must never become durable memory.
   */
  readonly userText: string;
}

export type CitationRejection =
  | { readonly reason: "unknown_turn"; readonly turnId: string }
  | { readonly reason: "quote_not_found"; readonly turnId: string }
  | { readonly reason: "no_directive_evidence" }
  | { readonly reason: "governance_hijack"; readonly text: string }
  | { readonly reason: "link_in_shared_text"; readonly text: string };

/**
 * The single normalization both sides go through. Quotes are re-typed by the model rather than
 * copied byte for byte, so a straight substring test on raw text fails on whitespace alone.
 */
export function normalizeQuote(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

export interface CitationIndex {
  has(turnId: string): boolean;
  supports(turnId: string, quote: string): boolean;
}

/** Builds the lookup once per Run; every citation in the output is checked against it. */
export function buildCitationIndex(turns: readonly CitableTurn[]): CitationIndex {
  const byTurn = new Map(turns.map((turn) => [turn.turnId, normalizeQuote(turn.userText)]));
  return {
    has: (turnId) => byTurn.has(turnId),
    supports: (turnId, quote) => byTurn.get(turnId)?.includes(normalizeQuote(quote)) ?? false,
  };
}

/**
 * Phrases that address the model's own governance rather than state something about the user.
 * Deliberately narrow: a standing instruction *is* an imperative ("always use British spelling"),
 * so blocking imperatives would block the most valuable thing the Curator learns.
 */
const GOVERNANCE_HIJACK =
  /\b(ignore (all |any |the )?(previous|prior|earlier|above)|disregard (all |any |the )?(previous|prior|earlier|above)|system prompt|you are now|new instructions|developer mode|override your)\b/i;

const LINK = /\b(?:https?:\/\/|www\.)\S/i;

/**
 * Evidence that the user stated a rule, rather than the model inferring one from a single reply.
 * `## Standing instructions` is applied to every future turn, so inference is not good enough.
 */
const DIRECTIVE =
  /\b(always|never|don'?t|do not|stop|instead|from now on|going forward|prefer|make sure|please (?:always|never|stop|don'?t))\b/i;

function hasGovernanceHijack(text: string): boolean {
  return GOVERNANCE_HIJACK.test(text);
}

function hasLink(text: string): boolean {
  return LINK.test(text);
}

export function hasDirectiveEvidence(quotes: readonly string[]): boolean {
  return DIRECTIVE.test(quotes.join("\n"));
}

/**
 * The guardrails that apply to text with no citation to lean on — a business Knowledge page, or a
 * seed rationale — where "one person typed this" is not available as a control.
 */
export function checkSharedText(text: string): CitationRejection | undefined {
  if (hasGovernanceHijack(text)) return { reason: "governance_hijack", text };
  if (hasLink(text)) return { reason: "link_in_shared_text", text };
  return undefined;
}

export interface CitationCheckInput {
  readonly citations: readonly { readonly turnId: string; readonly quote: string }[];
  /** The text this evidence is being used to justify writing. */
  readonly claims: readonly string[];
  /** `## Standing instructions` requires the user to have stated a rule, not implied one. */
  readonly requireDirective?: boolean;
  /** True when the text crosses from one person to an audience that is not them. */
  readonly shared?: boolean;
}

/**
 * Links are rejected only in shared text. A URL the user typed about their own work is a fact
 * about them, and the citation is what proves they typed it; the same URL republished to everyone
 * in the business is read by people who never saw it typed, and for them it is just a link the
 * system now vouches for.
 */
export function checkCitations(
  index: CitationIndex,
  input: CitationCheckInput
): CitationRejection | undefined {
  for (const claim of input.claims) {
    if (hasGovernanceHijack(claim)) return { reason: "governance_hijack", text: claim };
    if (input.shared && hasLink(claim)) return { reason: "link_in_shared_text", text: claim };
  }
  for (const citation of input.citations) {
    if (!index.has(citation.turnId)) {
      return { reason: "unknown_turn", turnId: citation.turnId };
    }
    if (!index.supports(citation.turnId, citation.quote)) {
      return { reason: "quote_not_found", turnId: citation.turnId };
    }
  }
  if (input.requireDirective && !hasDirectiveEvidence(input.citations.map((c) => c.quote))) {
    return { reason: "no_directive_evidence" };
  }
  return undefined;
}
