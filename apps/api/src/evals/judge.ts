import type { JudgeInput, JudgeModelPort, JudgeVerdict } from "@tulipfarm/evals";
import { ajv } from "@tulipfarm/schema";
import { generateObject, jsonSchema, type LanguageModel } from "ai";

/**
 * LLM-as-judge over the Soul's configured providers.
 *
 * This is the app-layer implementation of the pure `JudgeModelPort` from `@tulipfarm/evals`. It
 * runs on the `complex` tier (the caller passes that model) for grading reliability and reuses the
 * existing provider credentials — no separate key. The verdict is a low-cardinality pass/fail plus
 * a 0..1 score and a rationale, which is the LLM-judge best practice: an auditable, bounded output
 * rather than a vague number.
 */

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "score", "rationale"],
  properties: {
    passed: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", minLength: 1 },
  },
} as const;

const validateVerdict = ajv.compile(VERDICT_SCHEMA);

const SYSTEM_PROMPT = [
  "You are a strict, fair evaluator of an AI assistant's output.",
  "Grade ONLY against the rubric you are given. Do not reward style you were not asked to reward.",
  "Return a JSON object: { passed: boolean, score: number in [0,1], rationale: string }.",
  "`passed` is your binary verdict; `score` is your confidence/quality (1 = clearly passes).",
  "Be concise in the rationale and cite the specific reason for your verdict.",
].join("\n");

function buildPrompt(input: JudgeInput): string {
  const sections = [
    `RUBRIC:\n${input.rubric}`,
    `ASSISTANT INPUT:\n${input.input}`,
    `ASSISTANT OUTPUT:\n${input.output}`,
  ];
  if (input.context !== undefined) {
    sections.splice(
      1,
      0,
      `REFERENCE CONTEXT (the output must be faithful to this):\n${input.context}`
    );
  }
  return sections.join("\n\n");
}

export class LlmJudgeModel implements JudgeModelPort {
  constructor(private readonly model: LanguageModel) {}

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const { object } = await generateObject({
      model: this.model,
      schema: jsonSchema<JudgeVerdict>(VERDICT_SCHEMA),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(input),
    });
    if (!validateVerdict(object)) {
      throw new Error(`judge produced invalid verdict: ${ajv.errorsText(validateVerdict.errors)}`);
    }
    return object;
  }
}
