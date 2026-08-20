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
| `src/matrix.ts` | `runMatrix` — the same Corpus across several models, one Scorecard each. |
| `src/bindings.ts` | `resolveBindings` — turns `--model sonnet,terra` into the bindings to measure. |
| `src/scripted.ts` | `scriptedBinding` — replays each Case's `script`. Free, deterministic. |
| `src/model.ts` | `PINNED_MODELS` and `pinnedBinding` — the real-vendor binding. The only file here that touches a credential. |
| `src/retry.ts` | `withRetry` — transient vendor failures, retried and counted. |
| `src/spend.ts` | `Spend` totals: tokens, dollars, and what could not be priced. |
| `soul/` | The **Eval Soul**: the frozen fixture business every Case is measured against. Ordinary tracked files. |
| `src/eval-soul.ts` | `loadEvalSoul` — copies the fixture to a throwaway git repo and reads it with the real `SoulLoader`; `soulContext` maps an Agent into the assembler. |
| `src/guardrails.ts` | Runs the Eval Soul's `guardrails.yaml` through the production `TurnGuardrails`; collects refusals off the real Run events. |
| `src/l3/` | The persisted tier: one Turn through the real Chat executor on in-process PGlite. `tier.ts` is the entry point. |
| `src/l3/soul-write.ts` | The `soul_write` Tool, over the real writer *and* the real publisher, so a Case can tell a commit from a publication. |
| `src/l3/file-store.ts` | The one place `file_create` runs for real, so a Case can read who a generated File was actually shared with. |
| `src/verdict.ts` | `caseVerdict`, `scoreable` — one Case collapsed into one word. Shared so the grid and a Baseline delta can never disagree. |
| `src/baseline.ts` | `compareToBaseline` — pure. Refuses a delta across two Corpora or two models. |
| `src/artifact.ts` | `ScorecardArtifact` read/write, `harnessVersion`, `baselinePath`. The durable form. |
| `src/release.ts` | `applyBaseline` — archive, compare, promote. The only place a Baseline is written. |
| `src/scorecard.ts` | Text rendering, including `renderDelta`. |
| `src/progress.ts` | `progressReporter` — live per-Trial output while a real Sweep runs. |
| `src/args.ts` | Option parsing. Split out so a mistyped ceiling is a tested refusal. |
| `src/cli.ts` | `pnpm eval`. |
| `baselines/<model>.json` | The promoted reference per model, committed so git history records the harness improving. |
| `corpus/` | The Cases. One JSON file each, `id` matching the filename. |

## Rules

The reasoning behind each of these — and thirty more — is in [`README.md`](README.md). **Read it
before changing how a Case is scored, run or compared.** These are the ones that bite hardest:

- **The Eval Soul is loaded, never constructed,** and its hash is folded into `corpusHash`.
- **The assembler stays in the path.** `runTrial` calls `assembleSystemPrompt` itself; a runner
  feeding hand-written prompts to the loop would never catch a Context-assembly regression.
- **Expectations are data, never functions** — that is what makes the Corpus hashable.
- **A vendor failure is not a verdict.** `model_*` loop failures count as `errored`, never `failed`.
- **`corpusHash` is the unit of comparability.** A delta across two Corpora, or two models, is
  refused rather than computed.
- **Nothing becomes the Baseline on its own.** Promotion is `--promote`, from a clean tree, from a
  complete and unregressed Sweep only.
- **A content Expectation must be grounded** in what the model was given, or declare `ungrounded`.
  A File's declared `content` counts as given; its id and filename do not.
- **`attachments` is what this Turn sent; `readable` is what `file_read` can go and get.** A File
  in both would be in the prompt from the first step, so a re-read Case asserting `prompt_attaches`
  would pass with the whole mechanism removed. Declaring it in neither is refused for the same
  reason.
- **Name a shipped Tool with `platformTools`; only hand-declare a Tool an operator would author.**
  A copy measures the model against a description no deployment sends, and cannot assert the
  properties that live in the declaration. The resolved declaration is in `corpusHash`, so
  rewording one retires every Baseline. An unresolvable name fails the load.
- **`soul_write` and `file_create` are the only Tools L3 runs for real,** routed by name in
  `routeTools`. Each writes something — a commit, a set of shares — that no scripted result could
  stand in for, so scripting one is impossible rather than discouraged.
- **A generated File's audience comes from `agentRoles`, never the soul's `roles:`,** which is
  advisory and writes no `role_assignments`. Pair `generated_file_readable_by` with a
  `generated_file_not_readable_by` for a Role the Agent lacks, or the Case passes just as well
  against an audience that shares every File with everyone.
- **Every Case carries a `script`,** so the whole Corpus runs free in ordinary CI.
- **Two models are a control, not a contest,** and they never run at once.
- **A Judge failure errors the Trial; it never scores low.**
- **A `fault` is L3-only and names a dependency, not an outcome.** It breaks what the executor was
  given, so a Case can measure a Turn abandoned before the loop ever ran.
- This workspace is CJS-by-default — no `import.meta`.

## Commands

| Command | Runs |
| --- | --- |
| `pnpm eval` | The capability Corpus on the free scripted tier. |
| `pnpm eval:redteam` | The attack Corpus, scripted. |
| `pnpm eval:sonnet` / `eval:terra` | One real seat. Needs that seat's credential. |
| `pnpm eval:matrix` / `eval:redteam:matrix` | Both seats, one Scorecard each plus a grid. |
| `pnpm eval -- --help` | Every flag. |
