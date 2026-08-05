import type { EvalCase, Score, ScoreArgs, Scorer, TargetOutput } from "../types";

/**
 * LLM-as-judge scorer.
 *
 * The judge is a provider-neutral port so the pure core never imports `@tulipfarm/llm`. The real
 * implementation (a `generateObject` call on the `complex` tier) is wired in the app layer and
 * injected here; harness unit tests inject a deterministic fake judge. Best practice baked in: an
 * explicit rubric, a low-cardinality pass/fail verdict, and a rationale so a human can audit why.
 */

export interface JudgeInput {
  readonly rubric: string;
  /** The case input, rendered to text (prompt or joined messages). */
  readonly input: string;
  /** The target's produced answer. */
  readonly output: string;
  /** Optional reference context a faithfulness rubric grades against. */
  readonly context?: string;
}

export interface JudgeVerdict {
  readonly passed: boolean;
  /** 0..1 confidence/quality signal accompanying the verdict. */
  readonly score: number;
  readonly rationale: string;
}

export interface JudgeModelPort {
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

function renderInput(evalCase: EvalCase): string {
  const { prompt, messages } = evalCase.input;
  if (prompt !== undefined) return prompt;
  if (messages !== undefined) return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  return "";
}

function outputText(output: TargetOutput): string {
  if (output.text !== undefined) return output.text;
  if (typeof output.structured === "string") return output.structured;
  if (output.structured !== undefined) return JSON.stringify(output.structured);
  return "";
}

export interface LlmJudgeOptions {
  readonly judge: JudgeModelPort;
  /** Rubric override; when omitted the case's own `rubric` is used. */
  readonly rubric?: string;
  /** Additionally require the numeric score to meet this threshold (0..1). */
  readonly passThreshold?: number;
}

export function llmJudge(options: LlmJudgeOptions): Scorer {
  return async ({ evalCase, output }: ScoreArgs): Promise<Score> => {
    const rubric = options.rubric ?? evalCase.rubric;
    if (rubric === undefined) {
      return {
        scorer: "judge",
        passed: false,
        value: 0,
        rationale: "no rubric provided for judge",
      };
    }
    const verdict = await options.judge.judge({
      rubric,
      input: renderInput(evalCase),
      output: outputText(output),
      ...(evalCase.input.context === undefined ? {} : { context: evalCase.input.context }),
    });
    const passed =
      verdict.passed &&
      (options.passThreshold === undefined || verdict.score >= options.passThreshold);
    return { scorer: "judge", passed, value: verdict.score, rationale: verdict.rationale };
  };
}
