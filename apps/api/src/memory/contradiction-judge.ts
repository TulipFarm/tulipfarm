import type { MemoryContradictionInput, MemoryContradictionPort } from "@tulipfarm/memory";
import { generateText, type LanguageModel } from "ai";

/** LLM contradiction output is untrusted ids, filtered afterward against exactly what it saw. */

/** How many priors the judge is shown at once. Beyond this the prompt stops being answerable. */
export const MAX_JUDGED_PRIORS = 10;

const JUDGE_PROMPT = [
  "You decide which stored statements a new statement makes untrue.",
  "",
  "A statement is contradicted only if both cannot be true of the same person at the same time.",
  "Being about the same topic is not enough — people hold several preferences, several skills, and",
  "several projects at once. Prefer returning nothing.",
  "",
  "Contradicted:   'Works at Acme' vs 'Works at Beta' (one employer at a time)",
  "Not contradicted: 'Plays guitar' vs 'Plays piano' (both can be true)",
  "Not contradicted: 'Prefers dark mode' vs 'Prefers concise answers' (different things)",
  "",
  'Return strict JSON and nothing else: {"contradicted":["<id>", ...]}',
].join("\n");

/** Unparseable model output yields no ids, preserving facts instead of wrongly closing them. */
export function contradictedIdsFromResponse(raw: string): readonly string[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return [];
    const ids = (parsed as { contradicted?: unknown }).contradicted;
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  } catch {
    return [];
  }
}

/** Renders the question. Ids are opaque labels to the model — it never sees a scope or an owner. */
export function renderJudgePrompt(input: MemoryContradictionInput): string {
  const priors = input.priors
    .slice(0, MAX_JUDGED_PRIORS)
    .map((p) => `- id: ${p.assertionId}\n  ${p.subject}: ${p.statement}`)
    .join("\n");
  return [
    `New statement — ${input.statement.subject}: ${input.statement.statement}`,
    "",
    "Stored statements:",
    priors,
  ].join("\n");
}

export class LlmContradictionJudge implements MemoryContradictionPort {
  constructor(private readonly getModel: () => LanguageModel) {}

  async contradicts(input: MemoryContradictionInput): Promise<readonly string[]> {
    if (input.priors.length === 0) return [];
    const result = await generateText({
      model: this.getModel(),
      system: JUDGE_PROMPT,
      prompt: renderJudgePrompt(input),
    });
    return contradictedIdsFromResponse(result.text);
  }
}
