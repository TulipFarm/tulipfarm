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
| `src/model.ts` | `PINNED_MODELS` and `pinnedBinding` — the real-vendor binding. The only file here that touches a credential. |
| `src/retry.ts` | `withRetry` — transient vendor failures, retried and counted. |
| `src/spend.ts` | `Spend` totals: tokens, dollars, and what could not be priced. |
| `src/scorecard.ts` | Text rendering. |
| `src/args.ts` | Option parsing. Split out so a mistyped ceiling is a tested refusal. |
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
- **A content expectation must be grounded in what the model was given** — its text or pattern has
  to appear in the Case's `context`, `input` or `toolResults`. `script` does not count; it is the
  fake model's own words, so an expectation grounded there checks the script against itself. This
  is the one authoring fault the scripted tier cannot catch, and it surfaces against a real model
  as a failure that reads like a regression. Genuinely ungrounded checks — refusal wording, output
  format — set `ungrounded` to the reason; the rule bans the silent ones, not the deliberate ones.
- **Nothing selects the model but the pin.** `pinnedBinding` hands the loop a port wrapping one
  directly-constructed model, so the Model Profile catalogue, the tier router and the Effort
  classifier are all out of the path. Effort is declared on the `PinnedModel`, never inferred: a
  classifier change would otherwise silently move what every Case measures.
- **Both pins are aliases, and the Scorecard says so.** A dated id would be better — one the vendor
  rolls forward reads exactly like a harness regression — but neither seat publishes one, so
  `dated: false` prints a `NOTE`. A reported version is recorded only when it differs from the id
  we asked for; the SDK echoes the request otherwise, and an echo is not a confirmation.
- **A seat may not be redirected.** `--model` refuses to start when a base-URL override is in the
  environment: the vendor CLIs pass one through their jail, and a Sweep measured against a proxy
  has no field on the Scorecard that could reveal it.
- **The vendor credential comes from `env://` and nowhere else,** and `createModel` is called with no
  `principal` and no `credentials`. Given both, the provider layer silently prefers a principal's
  own key — a Sweep that did that would measure a different account and report it as a result.
- **Retries are owned here, not by the SDK.** `maxRetries: 0` is passed to `streamText` because the
  SDK retries silently; a Sweep has to report a retry as a retry, and charge for the attempt that
  failed. A throttled call was still billed for the prompt it submitted.
- **The spend ceiling bounds the overrun to one Trial,** not to zero. A call's cost is only knowable
  once it has been made, so the check runs before launching the next Trial. A Sweep that stops early
  reports `abortedReason` and `skipped`, and never clears a release.
- **`unpriced` is not zero.** A call nobody could price cost real money and contributes `0` to
  `costUsd`, so it is counted separately and the total is printed as a floor.
- Executed by `tsx`, like the other apps — this workspace is CJS-by-default, so no `import.meta`.

## Adding a Case

Drop a JSON file in `corpus/`. Required: `id`, `tier: "l2"`, `agent`, `context`, a non-empty
`input`, and `expect`. Run `pnpm eval --case <id>` to check it in isolation.

Put every fact the answer needs into `context` or `toolResults`, never only into `script`. A Case
whose expected answer is not somewhere the model was handed cannot be satisfied except by luck,
and `loadCorpus` will refuse it.

## Running against a real model

Both pinned models are **vendor CLI subscription seats**, not metered API keys. They cost $0 per
call and spend a personal quota instead, so `--max-tokens` is the only ceiling that can bind them —
and `--model` refuses to run without it.

```bash
pnpm eval                                               # scripted: free, no credentials

export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"  # sonnet  -> claude-code
pnpm eval --model sonnet --case support-answers-without-tools --max-tokens 20000

export CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"      # luna    -> codex
pnpm eval --model luna --case support-answers-without-tools --max-tokens 20000
```

A seat is one person's, so a public repo cannot hold it as a secret. Where a release Sweep runs
is still open — see `.scratch/harness-eval/spec.md`.
