# apps/eval

Offline eval harness. Runs a versioned **Corpus** of **Eval Cases** through the *real* Context
assembler and the *real* Tool loop, scores deterministic **Expectations**, and prints a **Scorecard**.

Manually triggered before a release. Never runs in the product; nothing here is reachable at runtime.

Every noun above is defined in [`metadata/terminologies.md` → Offline eval](../../metadata/terminologies.md#offline-eval),
which is binding. Two words are easy to get wrong: an eval check is an **Expectation**, never an
"assertion" (Memory owns that), and a Sweep is never an "eval run" (a Trial *contains* real Runs).

## Read on / Skip

**Read on** if your task touches: eval Cases, Expectation kinds, the Corpus hash, Sweep execution,
Scorecard output, or wiring a new model binding.

**Skip** if you are changing the loop, the assembler or a Tool — this app consumes them unchanged.
Only its own Cases need updating when their observable behaviour moves.

## Map

| Path | Owns |
| --- | --- |
| `src/case.ts` | `EvalCase`, the `Expectation` union, loop limits. The vocabulary everything else reads. |
| `src/corpus.ts` | Loading and validating `corpus/*.json`; `corpusHash` — the content hash. |
| `src/scorer.ts` | `scoreCase` — pure and total. No I/O, no model, no clock. |
| `src/runner.ts` | `runSweep` and `ModelBinding` — **the single seam this framework adds.** |
| `src/scripted.ts` | `scriptedBinding` — replays each Case's `script`. Free, deterministic. |
| `src/scorecard.ts` | Text rendering. |
| `src/cli.ts` | `pnpm eval`. |
| `corpus/` | The Cases. One JSON file each, `id` matching the filename. |

## Rules

- **The assembler must stay in the path.** `AgentLoopInput.messages` is *already assembled*, so a
  runner that fed hand-written prompts to the loop would never catch a Context-assembly regression.
  `runTrial` calls `assembleSystemPrompt` itself; `prompt_contains` is the expectation that proves it.
- **Expectations are data, never functions.** That is what lets the Corpus be content-hashed and a
  Case be authored without writing code. Add a new `kind` to the union and handle it in `scoreCase`.
- **A vendor failure is not a verdict.** A loop failure whose reason starts with `model_` is counted
  as `errored`, never `failed`. Scoring a rate-limit as a quality regression is the exact confound
  this framework exists to remove.
- **A Case that expects nothing is rejected at load,** and a `vacuous` Trial fails the CLI exit
  code. `[].every(...)` is `true`, so an empty `expect` would otherwise clear the release gate
  having checked nothing.
- **A malformed Expectation is rejected at load,** per-kind, by `EXPECTATION_FIELDS`. A missing
  `pattern` would compile to `/(?:)/` and match anything; a missing `path` would throw mid-score.
  `scoreCase` also guards both, because it is documented as total.
- **An unscripted Tool call succeeds with empty output** rather than erroring, so a Case need not
  model a Tool whose result it does not care about. Pin the interaction with `tool_call_count` or
  `tool_not_called` when it matters.
- **`corpusHash` is the unit of comparability.** Two Scorecards with different hashes are not
  comparable. Never compare across `modelId` either.
- **Every Case carries a `script`,** so the whole Corpus runs free and deterministically in ordinary
  CI. A real-model binding ignores it. This is what lets a contributor without vendor keys develop
  the framework.
- **`loadCorpus` throws rather than skipping** a malformed Case: silently dropping one reports a
  pass rate over a smaller denominator than the reader believes.
- Executed by `tsx`, like the other apps — this workspace is CJS-by-default, so no `import.meta`.

## Adding a Case

Drop a JSON file in `corpus/`. Required: `id`, `tier: "l2"`, `agent`, `context`, a non-empty
`input`, and `expect`. Run `pnpm eval --case <id>` to check it in isolation.
