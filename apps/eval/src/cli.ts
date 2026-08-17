import { resolve } from "node:path";
import { assertKnownFlags, flag, positive } from "./args.ts";
import { loadCorpus } from "./corpus.ts";
import { isPinnedModelName, PINNED_MODELS, pinnedBinding } from "./model.ts";
import { type ModelBinding, runSweep } from "./runner.ts";
import { renderScorecard } from "./scorecard.ts";
import { scriptedBinding } from "./scripted.ts";

const MODELS = Object.keys(PINNED_MODELS).join(", ");

const HELP = `
Usage: pnpm eval [options]

  --case <id>        Run only the Eval Case with this id.
  --corpus <dir>     Corpus directory (default: apps/eval/corpus).
  --model <name>     Run against a real vendor model (${MODELS}). Costs money.
  --max-spend <usd>  Stop launching Trials once this much has been spent.
  --max-tokens <n>   Stop launching Trials once this many tokens are used. The only
                     ceiling that binds a subscription seat, whose dollar cost is zero.
  --help             Show this message.

Without --model the Corpus runs against the scripted binding: free, deterministic, no
credentials. --model drives a real vendor CLI on your own subscription seat, which needs
that seat's credential in the environment and consumes your quota. Always bound it with
--max-tokens: a seat's dollar cost is zero, so --max-spend can never stop one.
`;

/** No `--model` means the free scripted tier; a name must be one this repo has pinned. */
function resolveBinding(name: string | undefined): ModelBinding {
  if (name === undefined) return scriptedBinding();
  if (!isPinnedModelName(name)) {
    throw new Error(`unknown model "${name}" — pinned models are: ${MODELS}`);
  }
  return pinnedBinding(PINNED_MODELS[name]);
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
  const model = resolveBinding(modelName);
  const maxSpendUsd = positive(flag(argv, "--max-spend"), "--max-spend");
  const maxTokens = positive(flag(argv, "--max-tokens"), "--max-tokens");
  // A real Sweep spends a finite quota. Refusing here is the only place that can stop an
  // unbounded one, because a seat reports no dollar cost for a ceiling to act on.
  if (modelName !== undefined && maxTokens === undefined) {
    throw new Error("--model needs --max-tokens: a seat costs $0, so --max-spend cannot bound it");
  }
  const card = await runSweep({
    corpus,
    model,
    ...(caseFilter === undefined ? {} : { caseFilter }),
    ...(maxSpendUsd === undefined ? {} : { maxSpendUsd }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });

  process.stdout.write(renderScorecard(card));

  // An errored, vacuous or never-run Trial fails the command too. A Sweep that could not measure
  // something has not cleared a release; only a complete, green Scorecard has.
  const vacuous = card.trials.filter((t) => t.vacuous).length;
  return card.failed + card.errored + vacuous + card.skipped > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
);
