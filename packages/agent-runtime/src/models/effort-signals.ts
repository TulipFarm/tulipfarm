/** Inspectable prompt-effort signals; weights stay on a 0.5 grid. */

/** Signals ignore fenced code: snippet keywords belong to the author, not the asker. */
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;

const INDENTED_CODE_RUN = /(?:^|\n)(?:[ \t]{4}|\t)\S[^\n]*\n(?:[ \t]{4}|\t)\S/;

const NUMBERED_ITEM = /^[ \t]*\d+[.)][ \t]+\S/gm;
const BULLET_ITEM = /^[ \t]*[-*•][ \t]+\S/gm;

const SEQUENCING = /\b(?:and then|after that|once (?:that|you|it)|finally,|first,|next,|step \d)\b/;

const DESIGN_KEYWORDS =
  /\b(?:architect\w*|design(?:s|ed|ing|er|ers)?|trade-?offs?|scalab\w*|migrat\w*|refactor\w*|strateg\w*|approach\w*|compare|comparison|evaluat\w*|pros and cons|best practice|rearchitect\w*|why (?:does|do|is|are|would|should))\b/;

/** Platform terms imply Tool Broker work, so they argue upward even in short prompts. */
const PLATFORM_KEYWORDS =
  /\b(?:routines?|agents?|skills?|resources?|integrat\w*|tools?|webhooks?|oauth|api|slack|github|connect(?:ed|ion|ions)?|sync(?:ed|ing)?|automat\w*|schedul\w*)\b/;

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

const LONG_PROMPT_CHARS = 400;
const VERY_LONG_PROMPT_CHARS = 1_200;
const SHORT_PROMPT_CHARS = 80;
const LOOKUP_MAX_CHARS = 200;
const ACKNOWLEDGEMENT_MAX_CHARS = 24;

/** `prose` removes fenced code so snippet identifiers do not score as the ask. */
export interface PromptFeatures {
  readonly text: string;
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

/** Named, signed scoring predicate. */
export interface EffortSignal {
  readonly name: string;
  readonly weight: number;
  test(features: PromptFeatures): boolean;
}

/** Ordered for reading only; scoring is a sum. */
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
