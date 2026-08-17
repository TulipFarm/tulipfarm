import { type Expectation, isJudged } from "./case.ts";
import type { Judge } from "./judge.ts";
import { givenTo, JudgeError, leakPrompt, MAX_SCORE, scorePrompt } from "./rubric.ts";
import type { ExpectationResult, Observation } from "./scorer.ts";

function answerOf(observation: Observation): string {
  const output = observation.output;
  if (output === undefined) return "";
  return output.kind === "text" ? output.text : JSON.stringify(output);
}

/**
 * Score the judged Expectations of one Case.
 *
 * Kept apart from `scoreCase` so the deterministic backbone stays synchronous, free and offline:
 * a Corpus with no rubric never builds a Judge, never spends a token and never waits on a network.
 *
 * @throws {JudgeError} when a Case carries a rubric and no Judge is configured. Skipping it would
 * pass the Case, which is the one outcome an unmeasured quality check must never produce.
 */
export async function scoreJudged(
  expect: readonly Expectation[],
  observation: Observation,
  judge: Judge | undefined
): Promise<readonly ExpectationResult[]> {
  const judged = expect.filter(isJudged);
  if (judged.length === 0) return [];
  if (judge === undefined) {
    throw new JudgeError(
      `this Case carries a rubric but no Judge is configured. Set the Judge environment, or ` +
        `remove the rubric — an unjudged rubric would pass, and a quality check that passes ` +
        `because nothing measured it is worse than no check.`
    );
  }

  const answer = answerOf(observation);
  const given = givenTo(observation);
  const results: ExpectationResult[] = [];
  for (const a of judged) {
    if (a.kind === "rubric_score") {
      const judgement = await judge.judge(scorePrompt({ criteria: a.criteria, answer, given }));
      results.push({
        expectation: a,
        passed: judgement.score >= a.min,
        detail: `Judge scored ${judgement.score}/${MAX_SCORE}, needed ${a.min} — ${judgement.reasoning}`,
      });
    } else if (a.kind === "rubric_denies") {
      const judgement = await judge.judge(leakPrompt(a.question, { answer, given }));
      // The conservative direction: only the top of the scale is a denial. Anything else — a
      // hedge, a partial disclosure, a Judge that split the difference — counts as a leak.
      results.push({
        expectation: a,
        passed: judgement.score === MAX_SCORE,
        detail:
          judgement.score === MAX_SCORE
            ? `Judge found no disclosure — ${judgement.reasoning}`
            : `Judge found a disclosure — ${judgement.reasoning}`,
      });
    }
  }
  return results;
}
