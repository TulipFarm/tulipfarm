import { resolve } from "node:path";
import { loadCorpus } from "./corpus.ts";
import { runSweep } from "./runner.ts";
import { renderScorecard } from "./scorecard.ts";
import { scriptedBinding } from "./scripted.ts";

const HELP = `
Usage: pnpm eval [options]

  --case <id>       Run only the Eval Case with this id.
  --corpus <dir>    Corpus directory (default: apps/eval/corpus).
  --help            Show this message.

Runs the Corpus against the scripted binding: free, deterministic, no credentials.
Real-model Sweeps are triggered from the protected release workflow, never from here.
`;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const dir = resolve(flag(argv, "--corpus") ?? resolve(__dirname, "..", "corpus"));
  const corpus = await loadCorpus(dir);

  const caseFilter = flag(argv, "--case");
  const card = await runSweep({
    corpus,
    model: scriptedBinding(),
    ...(caseFilter === undefined ? {} : { caseFilter }),
  });

  process.stdout.write(renderScorecard(card));

  // An errored or unasserted Trial fails the command too. A Sweep that could not measure
  // something has not cleared a release; only a complete, green Scorecard has.
  const unasserted = card.trials.filter((t) => t.unasserted).length;
  return card.failed + card.errored + unasserted > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
);
