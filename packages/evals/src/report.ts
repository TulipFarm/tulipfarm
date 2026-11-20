import { z } from 'zod';
import { addUsage, emptyUsage, type CaseResult, type Usage } from './contracts.ts';
import { usageCost } from './caps.ts';

export interface CaseSummary {
  caseId: string;
  model: string;
  passed: number;
  total: number;
}
export interface ModelSummary {
  model: string;
  passed: number;
  total: number;
  /** Pass rate across all cases and repeats, from 0 to 100. */
  score: number;
  agentUsage: Usage;
  judgeUsage: Usage;
  durationMs: number;
}

const rate = (passed: number, total: number) => (total ? Math.round((10000 * passed) / total) / 100 : 0);

/** Pass counts per case and model, such as 2/3 with three repeats, and the pass rate per model. */
export function summarize(results: readonly CaseResult[]) {
  const cases = new Map<string, CaseSummary>();
  const models = new Map<string, ModelSummary>();
  for (const result of results) {
    const key = `${result.model}\u0000${result.caseId}`;
    const item = cases.get(key) ?? { caseId: result.caseId, model: result.model, passed: 0, total: 0 };
    item.total++;
    if (result.pass) item.passed++;
    cases.set(key, item);
    const model = models.get(result.model) ?? {
      model: result.model,
      passed: 0,
      total: 0,
      score: 0,
      agentUsage: emptyUsage(),
      judgeUsage: emptyUsage(),
      durationMs: 0,
    };
    model.total++;
    if (result.pass) model.passed++;
    addUsage(model.agentUsage, result.agentUsage);
    addUsage(model.judgeUsage, result.judgeUsage);
    model.durationMs += result.durationMs;
    model.score = rate(model.passed, model.total);
    models.set(result.model, model);
  }
  return { cases: [...cases.values()], models: [...models.values()] };
}

export const baselineSchema = z.strictObject({
  suite: z.string(),
  model: z.string(),
  /** Pass rate from 0 to 100. */
  score: z.number().min(0).max(100),
  runs: z.number().int().positive(),
  recordedAt: z.string(),
});
export type Baseline = z.infer<typeof baselineSchema>;

export interface GateInput {
  score: number;
  baseline: Baseline | null;
  /** Points of pass rate a run may fall below its baseline. Zero means any failed case fails the gate. */
  tolerance: number;
  failures: number;
}

/** Whether a suite's score passes its gate: within tolerance of the baseline, and with zero tolerance, no failures. */
export function gate({ score, baseline, tolerance, failures }: GateInput) {
  if (tolerance === 0 && failures > 0)
    return { pass: false, reason: `${failures} case run(s) failed and this suite has zero tolerance.` };
  if (!baseline) return { pass: true, reason: 'No baseline is recorded for this model yet.' };
  const floor = Math.max(0, baseline.score - tolerance);
  return score >= floor
    ? { pass: true, reason: `Score ${score} is within ${tolerance} points of baseline ${baseline.score}.` }
    : { pass: false, reason: `Score ${score} is below baseline ${baseline.score} minus ${tolerance} points.` };
}

const usd = (usage: Usage) => `$${usageCost(usage).toFixed(4)}`;
const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A Markdown report of one run: one table per model comparison, then each failed case with its reasons. */
export function markdownReport(input: {
  title: string;
  results: readonly CaseResult[];
  gates?: readonly { suite: string; model: string; pass: boolean; reason: string }[];
  stopped?: string | null;
}) {
  const { cases, models } = summarize(input.results);
  const lines = [`# ${input.title}`, ''];
  if (input.stopped) lines.push(`**Stopped:** ${input.stopped}`, '');
  lines.push(
    '| Model | Pass rate | Passed | Requests | Agent cost | Judge cost | Duration |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const model of models)
    lines.push(
      `| ${cell(model.model)} | ${model.score}% | ${model.passed}/${model.total} | ${model.agentUsage.requests + model.judgeUsage.requests} | ${usd(model.agentUsage)} | ${usd(model.judgeUsage)} | ${Math.round(model.durationMs / 1000)}s |`,
    );
  if (input.gates?.length) {
    lines.push('', '| Suite | Model | Gate | Reason |', '| --- | --- | --- | --- |');
    for (const item of input.gates)
      lines.push(
        `| ${cell(item.suite)} | ${cell(item.model)} | ${item.pass ? 'pass' : 'FAIL'} | ${cell(item.reason)} |`,
      );
  }
  const failed = cases.filter(item => item.passed < item.total);
  if (failed.length) {
    lines.push('', '## Failed cases', '');
    for (const item of failed) {
      lines.push(`- **${item.caseId}** on ${item.model}: ${item.passed}/${item.total}`);
      const reasons = new Set(
        input.results
          .filter(result => result.caseId === item.caseId && result.model === item.model && !result.pass)
          .flatMap(result => (result.error ? [result.error] : result.verdicts.filter(v => !v.pass).map(v => v.reason))),
      );
      for (const reason of reasons) lines.push(`  - ${reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
