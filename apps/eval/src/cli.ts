import { resolve } from "node:path";
import { assertKnownFlags, flag, positive, present } from "./args.ts";
import { harnessVersion } from "./artifact.ts";
import { resolveBindings } from "./bindings.ts";
import { loadCorpus } from "./corpus.ts";
import { loadEvalSoul } from "./eval-soul.ts";
import { runMatrix } from "./matrix.ts";
import { PINNED_MODELS } from "./model.ts";
import { progressReporter } from "./progress.ts";
import { applyBaseline } from "./release.ts";
import type { Scorecard } from "./runner.ts";
import { renderMatrix, renderScorecard } from "./scorecard.ts";

const MODELS = Object.keys(PINNED_MODELS).join(", ");

const HELP = `
Usage: pnpm eval [options]

  --case <id>        Run only the Eval Case with this id.
  --corpus <dir>     Corpus directory (default: apps/eval/corpus).
  --model <names>    Run against real vendor models (${MODELS}). Costs money.
                     Comma-separate to run the matrix: --model sonnet,luna. Each model
                     gets the full ceiling, because a shared one would starve the last.
  --max-spend <usd>  Stop launching Trials once this much has been spent.
  --max-tokens <n>   Stop launching Trials once this many tokens are used. The only
                     ceiling that binds a subscription seat, whose dollar cost is zero.
  --baseline [path]  Report this Sweep as a delta against the promoted Baseline for each
                     model (apps/eval/baselines/<model>.json), and fail on a regression.
  --promote          Make this Sweep the Baseline for each model it measured. Never
                     automatic: a Baseline is a reference, so promoting is a decision.
  --save <path>      Archive this Scorecard as JSON. One model only, since one path
                     cannot hold two.
  --help             Show this message.

Without --model the Corpus runs against the scripted binding: free, deterministic, no
credentials. --model drives a real vendor CLI on your own subscription seat, which needs
that seat's credential in the environment and consumes your quota. Always bound it with
--max-tokens: a seat's dollar cost is zero, so --max-spend can never stop one.
`;

/** A Sweep clears a release only when it measured everything it set out to measure. */
function unclean(card: Scorecard): number {
  return card.failed + card.errored + card.skipped + card.trials.filter((t) => t.vacuous).length;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  assertKnownFlags(argv);

  const dir = resolve(flag(argv, "--corpus") ?? resolve(__dirname, "..", "corpus"));
  const corpus = await loadCorpus(dir, await loadEvalSoul());

  const caseFilter = flag(argv, "--case");
  const modelName = flag(argv, "--model");
  const models = resolveBindings(modelName);
  const maxSpendUsd = positive(flag(argv, "--max-spend"), "--max-spend");
  const maxTokens = positive(flag(argv, "--max-tokens"), "--max-tokens");
  const compare = present(argv, "--baseline");
  const promote = present(argv, "--promote");
  const baselineFile = flag(argv, "--baseline");
  const save = flag(argv, "--save");
  // Two models write two Scorecards, and one path can only hold one. Silently keeping the last
  // would archive a file whose name says nothing about which model is inside it.
  if (save !== undefined && models.length > 1) {
    throw new Error("--save takes one model: name it with --model, or use --promote per model");
  }
  if (present(argv, "--save") && save === undefined) throw new Error("--save needs a path");
  // A `--case` Sweep shares the Corpus hash while covering one Case, so a delta against it would
  // report every other Case as "not comparable" and pass. Refused here as well as in `release.ts`,
  // so the operator is told before spending quota rather than after.
  if ((compare || promote) && caseFilter !== undefined) {
    throw new Error(
      "--case cannot be combined with --baseline or --promote: a filtered Sweep does not measure the Corpus"
    );
  }
  // The scripted binding is told what to say, so it cannot fail and its Scorecard is not a
  // measurement. A Baseline made from one would certify every later Sweep against a fiction.
  if ((compare || promote) && modelName === undefined) {
    throw new Error(
      "--baseline and --promote need --model: the scripted binding cannot fail, so it is not a reference"
    );
  }
  // Comparing against a Baseline that is explicitly named for one model, across several models,
  // would measure every model against whichever one that file happens to hold.
  if (baselineFile !== undefined && models.length > 1) {
    throw new Error("--baseline <path> takes one model; bare --baseline works across a Matrix");
  }
  // A real Sweep spends a finite quota. Refusing here is the only place that can stop an
  // unbounded one, because a seat reports no dollar cost for a ceiling to act on.
  if (modelName !== undefined && maxTokens === undefined) {
    throw new Error("--model needs --max-tokens: a seat costs $0, so --max-spend cannot bound it");
  }
  // Only the real-model path is slow enough to need it, and only stderr may carry it: the
  // Scorecard on stdout is the artifact, and chatter interleaved into it would corrupt a reader.
  const onProgress =
    modelName === undefined
      ? undefined
      : progressReporter((text) => {
          process.stderr.write(text);
        });

  const matrix = await runMatrix({
    corpus,
    models,
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(caseFilter === undefined ? {} : { caseFilter }),
    ...(maxSpendUsd === undefined ? {} : { maxSpendUsd }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });

  // One model is not a matrix, and a grid of one column reads as if a comparison were made.
  const single = matrix.runs.length === 1 ? matrix.runs[0] : undefined;
  if (single?.card !== undefined) process.stdout.write(renderScorecard(single.card));
  else process.stdout.write(renderMatrix(matrix));

  const version = harnessVersion(resolve(__dirname, ".."));
  let baselineFailed = false;
  for (const run of matrix.runs) {
    if (run.card === undefined) continue;
    const outcome = applyBaseline(run.card, {
      root: resolve(__dirname, ".."),
      harnessVersion: version,
      compare,
      promote,
      ...(baselineFile === undefined ? {} : { baseline: baselineFile }),
      ...(save === undefined ? {} : { save }),
    });
    process.stdout.write(outcome.text);
    if (outcome.failed) baselineFailed = true;
  }

  // A model that could not be measured fails the command as surely as a failing Case: a Matrix
  // missing a leg has not cleared a release, whatever the leg that ran says.
  const unmeasured = matrix.runs.filter((r) => r.card === undefined).length;
  const dirty = matrix.runs.reduce((n, r) => n + (r.card === undefined ? 0 : unclean(r.card)), 0);
  return unmeasured + dirty > 0 || baselineFailed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
);
