/**
 * The weighted signals that score a prompt for effort.
 *
 * This is **configuration, not logic**: every signal is a named unit with its own weight and its
 * own predicate, and `EFFORT_SIGNALS` is exported so one can be added, removed, or re-weighted
 * without touching the scorer. A nested chain of conditions would make the same decision, but the
 * decision would not be inspectable — and calibrating a router you cannot inspect means rewriting
 * it. `scoreEffortSignals` reports which signals fired for exactly that reason.
 *
 * A positive weight argues for a stronger rung, a negative one for a weaker rung. Weights stay on
 * a 0.5 grid so a score is exact in binary and a threshold comparison cannot drift.
 *
 * Every predicate reads a precomputed {@link PromptFeatures} rather than the raw string, so adding
 * a signal never adds another scan of the prompt.
 */

/** Signals never see fenced code as prose: a keyword inside a snippet is the author's, not the asker's. */
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;

/** Two or more consecutive indented lines — a code block that was pasted without fences. */
const INDENTED_CODE_RUN = /(?:^|\n)(?:[ \t]{4}|\t)\S[^\n]*\n(?:[ \t]{4}|\t)\S/;

const NUMBERED_ITEM = /^[ \t]*\d+[.)][ \t]+\S/gm;
const BULLET_ITEM = /^[ \t]*[-*•][ \t]+\S/gm;

/** Phrases that order work rather than merely joining it. Bare "then" is too common to count. */
const SEQUENCING = /\b(?:and then|after that|once (?:that|you|it)|finally,|first,|next,|step \d)\b/;

const DESIGN_KEYWORDS =
  /\b(?:architect\w*|design(?:s|ed|ing|er|ers)?|trade-?offs?|scalab\w*|migrat\w*|refactor\w*|strateg\w*|approach\w*|compare|comparison|evaluat\w*|pros and cons|best practice|rearchitect\w*|why (?:does|do|is|are|would|should))\b/;

/**
 * The platform vocabulary. A turn that names a Routine, an Integration, or a Tool is asking for
 * work that reaches past the model into the Tool Broker, and an under-powered model on that path
 * spends real effects getting it wrong — so this argues upward even when the prompt is short.
 */
const PLATFORM_KEYWORDS =
  /\b(?:routines?|agents?|skills?|resources?|integrat\w*|tools?|webhooks?|oauth|api|slack|telegram|github|connect(?:ed|ion|ions)?|sync(?:ed|ing)?|automat\w*|schedul\w*)\b/;

const LOOKUP_OPENER =
  /^(?:(?:what|who|when|where|which)\s+(?:is|are|was|were|does|do|did)\b|how (?:many|much)\b|list\b|show me\b|find\b|look up\b|define\b|search for\b)/;

const ACKNOWLEDGEMENTS = new Set([
  "hi",
  "hello",
  "hey",
  "yo",
  "thanks",
  "thank you",
  "ty",
  "ok",
  "okay",
  "k",
  "yes",
  "yeah",
  "yep",
  "no",
  "nope",
  "sure",
  "go ahead",
  "do it",
  "sounds good",
  "looks good",
  "lgtm",
  "continue",
  "please continue",
  "proceed",
  "carry on",
]);

/** Char counts, not token counts: the scorer runs before any tokenizer is chosen. */
const LONG_PROMPT_CHARS = 400;
const VERY_LONG_PROMPT_CHARS = 1_200;
const SHORT_PROMPT_CHARS = 80;
/** A factual opener only argues downward while the question stays small. */
const LOOKUP_MAX_CHARS = 200;
const ACKNOWLEDGEMENT_MAX_CHARS = 24;

/**
 * One prompt, measured once.
 *
 * `prose` is the prompt with fenced code removed; keyword signals read it so a snippet's own
 * identifiers cannot be mistaken for the question's subject.
 */
export interface PromptFeatures {
  /** The prompt as given, trimmed. */
  readonly text: string;
  /** Lowercased prompt with fenced code blocks removed. */
  readonly prose: string;
  readonly length: number;
  readonly questionCount: number;
  readonly numberedItems: number;
  readonly bulletItems: number;
  readonly hasCodeBlock: boolean;
}

export function promptFeatures(prompt: string): PromptFeatures {
  const text = prompt.trim();
  const hasFence = text.includes("```");
  const prose = text.replace(FENCED_CODE, " ").toLowerCase();
  return {
    text,
    prose,
    length: text.length,
    questionCount: (text.match(/\?/g) ?? []).length,
    numberedItems: (text.match(NUMBERED_ITEM) ?? []).length,
    bulletItems: (text.match(BULLET_ITEM) ?? []).length,
    hasCodeBlock: hasFence || INDENTED_CODE_RUN.test(text),
  };
}

/**
 * One named, independently weighted reason to route a prompt up or down.
 *
 * `weight` is signed: positive argues for a stronger rung, negative for a weaker one.
 */
export interface EffortSignal {
  readonly name: string;
  readonly weight: number;
  test(features: PromptFeatures): boolean;
}

/**
 * The scoring configuration.
 *
 * Ordered strongest-negative to strongest-positive purely for reading; the scorer sums them, so
 * order carries no meaning and re-ordering changes nothing.
 */
export const EFFORT_SIGNALS: readonly EffortSignal[] = [
  {
    name: "greeting_or_ack",
    weight: -3,
    test: (f) =>
      f.length <= ACKNOWLEDGEMENT_MAX_CHARS &&
      ACKNOWLEDGEMENTS.has(
        f.text
          .toLowerCase()
          .replace(/[.!,]+$/, "")
          .trim()
      ),
  },
  {
    name: "simple_lookup",
    weight: -2.5,
    test: (f) => f.length <= LOOKUP_MAX_CHARS && LOOKUP_OPENER.test(f.prose),
  },
  { name: "short_prompt", weight: -1, test: (f) => f.length <= SHORT_PROMPT_CHARS },
  { name: "long_prompt", weight: 1.5, test: (f) => f.length >= LONG_PROMPT_CHARS },
  // Stacks with `long_prompt` rather than replacing it: length argues upward twice over, which is
  // the honest shape — a 2,000-character brief is not merely "long".
  { name: "very_long_prompt", weight: 1.5, test: (f) => f.length >= VERY_LONG_PROMPT_CHARS },
  { name: "multi_question", weight: 1.5, test: (f) => f.questionCount >= 2 },
  {
    name: "platform_keywords",
    weight: 1.5,
    test: (f) => PLATFORM_KEYWORDS.test(f.prose),
  },
  {
    name: "multi_step",
    weight: 2,
    test: (f) => f.numberedItems >= 2 || f.bulletItems >= 3 || SEQUENCING.test(f.prose),
  },
  { name: "code_block", weight: 2, test: (f) => f.hasCodeBlock },
  { name: "design_keywords", weight: 2.5, test: (f) => DESIGN_KEYWORDS.test(f.prose) },
];
