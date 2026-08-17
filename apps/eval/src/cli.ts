import { resolve } from "node:path";
import { assertKnownFlags, flag, positive } from "./args.ts";
import { resolveBindings } from "./bindings.ts";
import { loadCorpus } from "./corpus.ts";
import { runMatrix } from "./matrix.ts";
import { PINNED_MODELS } from "./model.ts";
import { progressReporter } from "./progress.ts";
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
  const corpus = await loadCorpus(dir);

  const caseFilter = flag(argv, "--case");
  const modelName = flag(argv, "--model");
  const models = resolveBindings(modelName);
  const maxSpendUsd = positive(flag(argv, "--max-spend"), "--max-spend");
  const maxTokens = positive(flag(argv, "--max-tokens"), "--max-tokens");
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

  // A model that could not be measured fails the command as surely as a failing Case: a Matrix
  // missing a leg has not cleared a release, whatever the leg that ran says.
  const unmeasured = matrix.runs.filter((r) => r.card === undefined).length;
  const dirty = matrix.runs.reduce((n, r) => n + (r.card === undefined ? 0 : unclean(r.card)), 0);
  return unmeasured + dirty > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
);
