// Runs the internal eval suites against live models and gates them on their committed baselines.
//
//   pnpm exec turbo run build --filter=@tulipfarm/evals^...
//   TEST_ADMIN_DATABASE_URL=postgres://postgres:local-postgres@127.0.0.1:5432/postgres ANTHROPIC_API_KEY=test-placeholder \
//     pnpm --filter @tulipfarm/evals eval [--update-baselines]
//
// Environment:
//   EVALS_SUITES         comma-separated suites (default: all)
//   EVALS_CHANGED_FILES  newline-separated changed paths; runs only the suites they affect
//   EVALS_MODELS         comma-separated catalog model IDs (default: copilot-claude-sonnet)
//   EVALS_JUDGE_MODEL    judge model (default: the first model)
//   EVALS_REPEATS        repeats per case, 1 to 3 (default: 3)
//   EVALS_MAX_REQUESTS   request cap for the whole job (default: 500)
//   EVALS_MAX_COST       provider cost cap for the whole job, in US dollars (default: 5)
//   EVALS_COPILOT_TOKEN  GitHub token for Copilot models (default: `gh auth token`)
//   EVALS_REPORT_DIR     report directory (default: reports/evals at the repository root)
//   EVALS_VERBOSE=1      keep the runtime's info logs, which are hidden otherwise
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createCaps, internalCaps } from '../src/caps.ts';
import { evalCaseSchema, evalLimits } from '../src/contracts.ts';
import { baselineSchema, gate, markdownReport, summarize } from '../src/report.ts';
import { runEvals } from '../src/runner.ts';
import { chatHarness, chatJudge } from './harness.mjs';
import { list, selectSuites } from './index.mjs';

const baselineUrl = (suite, model) => new URL(`../baselines/${suite}/${model}.json`, import.meta.url);

async function readBaseline(suite, model) {
  try {
    return baselineSchema.parse(JSON.parse(await readFile(baselineUrl(suite, model), 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// The chat runtime logs every step at info level to stdout; the eval's own progress is easier to read without them.
function quietRuntimeLogs() {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) =>
    typeof chunk === 'string' && chunk.startsWith('{"level":"info"') ? true : write(chunk, ...rest);
}

async function main() {
  if (process.env.EVALS_VERBOSE !== '1') quietRuntimeLogs();
  const { values } = parseArgs({ options: { 'update-baselines': { type: 'boolean', default: false } } });
  const selected = selectSuites();
  if (!selected.length) {
    process.stdout.write('No eval suite is affected by this change.\n');
    return 0;
  }
  if (!process.env.TEST_ADMIN_DATABASE_URL) throw new Error('Set TEST_ADMIN_DATABASE_URL to a disposable Postgres');
  const models = list(process.env.EVALS_MODELS);
  if (!models.length) models.push('copilot-claude-sonnet');
  const repeats = Number(process.env.EVALS_REPEATS ?? 3);
  if (!evalLimits.repeats.includes(repeats)) throw new Error('EVALS_REPEATS must be 1 or 3');
  const judge = chatJudge(process.env.EVALS_JUDGE_MODEL?.trim() || models[0]);
  const caps = createCaps(
    internalCaps({
      requests: Number(process.env.EVALS_MAX_REQUESTS ?? 500),
      usd: Number(process.env.EVALS_MAX_COST ?? 5),
    }),
  );
  const reportDir = new URL(
    process.env.EVALS_REPORT_DIR ? `file://${process.env.EVALS_REPORT_DIR}/` : '../../../reports/evals/',
    import.meta.url,
  );
  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const gates = [];
  const allResults = [];
  let stopped = null;
  for (const suite of selected) {
    process.stdout.write(
      `\n# ${suite.name}: ${suite.cases.length} cases × ${repeats} repeats × ${models.join(', ')}\n`,
    );
    const cases = suite.cases.map(item => evalCaseSchema.parse({ priorTurns: [], ...item }));
    const harness = await chatHarness(suite.harness);
    let outcome;
    try {
      outcome = await runEvals({
        cases,
        models,
        repeats,
        driver: harness.driver,
        caps,
        judge,
        onResult: result =>
          process.stdout.write(
            `${result.pass ? 'pass' : 'FAIL'} ${result.model} ${result.caseId}#${result.repeat} ${Math.round(result.durationMs / 1000)}s${
              result.error ? ` error=${result.error}` : ''
            }${result.verdicts
              .filter(verdict => !verdict.pass)
              .map(verdict => ` [${verdict.reason}]`)
              .join('')}\n`,
          ),
      });
    } finally {
      await harness.close();
    }
    allResults.push(...outcome.results.map(result => ({ ...result, caseId: `${suite.name}/${result.caseId}` })));
    for (const summary of summarize(outcome.results).models) {
      const baseline = await readBaseline(suite.name, summary.model);
      const verdict = gate({
        score: summary.score,
        baseline,
        tolerance: suite.tolerance,
        failures: summary.total - summary.passed,
      });
      gates.push({ suite: suite.name, model: summary.model, ...verdict });
      if (values['update-baselines'] && !outcome.stopped) {
        await mkdir(new URL('.', baselineUrl(suite.name, summary.model)), { recursive: true });
        const recorded = {
          suite: suite.name,
          model: summary.model,
          score: summary.score,
          runs: summary.total,
          recordedAt: new Date().toISOString().slice(0, 10),
        };
        await writeFile(baselineUrl(suite.name, summary.model), `${JSON.stringify(recorded, null, 2)}\n`);
      }
    }
    await writeFile(
      new URL(`${stamp}-${suite.name}.json`, reportDir),
      `${JSON.stringify({ suite: suite.name, models, repeats, stopped: outcome.stopped, ...outcome }, null, 2)}\n`,
    );
    if (outcome.stopped) {
      stopped = outcome.stopped.reason === 'cap' ? outcome.stopped.message : 'Cancelled';
      break;
    }
  }
  const markdown = markdownReport({ title: 'Agent evals', results: allResults, gates, stopped });
  await writeFile(new URL(`${stamp}.md`, reportDir), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(`\n${markdown}`);
  if (values['update-baselines'] && stopped)
    process.stdout.write('Baselines were not updated for the stopped suite.\n');
  return stopped || gates.some(item => !item.pass) ? 1 : 0;
}

if (import.meta.main)
  main().then(
    code => process.exit(code),
    error => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
