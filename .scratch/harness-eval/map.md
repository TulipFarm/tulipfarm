# Offline eval for the agent harness

Label: `wayfinder:map`
Spec: [`spec.md`](spec.md) — in delivery
Visual: [`map.html`](map.html) — open in a browser
Delivery tickets: [`issues/`](issues/) — 16 vertical slices. **02, 03, 04, 05 landed**; frontier 06,
07; **01 must be re-decided** — see *Landed*
Charting tickets: [`issues-charting/`](issues-charting/) — archived, superseded by the spec

## Destination

A working offline eval framework for the TulipFarm agent harness: one runner with two front
doors — a local `pnpm eval` CLI and a maintainer-only GitHub Actions `workflow_dispatch` — that
executes a versioned corpus against a frozen eval Soul on **Claude Code (`sonnet`)** and **Codex
(`gpt-5.6-luna`)** — two subscription CLI seats, not API keys — and posts an advisory scorecard with
baseline deltas to the release PR.

Done means: a maintainer can trigger it before a release, nobody outside the trust boundary can,
and the scorecard is trustworthy enough to answer "did this harness change actually improve
anything, or did I just move a number?"

## Notes

**Domain.** The TulipFarm agent harness — `packages/agent-runtime` (context assembly, guardrails,
tool loop, model routing), `packages/run-kernel`, `packages/tool-broker`, `packages/llm`,
`packages/soul`, `packages/testkit`. Read the root `AGENTS.md` and the nearest package
`AGENTS.md` before touching anything.

**This map carries execution.** It overrides Wayfinder's plan-only default: the destination is
running code, so tickets produce working software, not only decisions. Decision tickets still
come first — do not start building past an unresolved upstream ticket.

**Skills.** `grilling` + `domain-modeling` by default on every session. `research` and
`prototype` per ticket type.

**Repo rules that bind this effort.** Biome only (no ESLint/Prettier). Vitest, colocated
`*.test.ts`. Dependency rules in `docs/architecture/dependency-rules.md` are binding — read them
before siting a new workspace. Conventional Commits. Never `git commit` unless asked.

### Settled at charting

Premises, not route steps — every ticket inherits these.

1. **Subject under test is the harness.** The two models are a *control*, not competitors. A
   harness change that lifts both is a real improvement; one that lifts a single vendor is
   overfitting. Baselines are per (harness version x model).
2. **Models: Claude Sonnet (anthropic) + a GPT model (openai).** Different vendors, deliberately —
   a same-vendor pair shares failure modes and decorrelates far less.
3. **Two tiers.** **L2** is the spine: one turn, real model, faked tools and storage, driven
   in-process through `AgentLoop`. **L3** is a small tier on top: real Postgres, fixture Soul,
   multi-turn journey, asserting on resulting state.
   *Reaffirmed after research.* [Establish headless Run execution for the L3 tier](issues/05-l3-headless-execution.md)
   came back recommending L2-only at ~3-6 engineer-days of build cost. The map owner kept L3
   anyway: it is the only tier that measures the product promise — "user asks in chat, the thing
   gets built" — and L2 measures the harness alone. The build cost is accepted, not overlooked.
4. **Advisory, not a gate, for v1.** LLM scoring is noisy; a gate built before the noise floor is
   measured is a gate that gets bypassed. The scorecard informs a human.
5. **Scoring is deterministic Expectations first.** Tool called, args matching, order, budget.
   LLM-as-judge only where output is genuinely prose — and the judge must be a **third-vendor**
   model pinned to an exact version and frozen for the life of a baseline.
6. **Frozen eval-only Soul fixture**, version controlled. Not the shipped default Soul: two
   moving parts make a score change unattributable. Permitted — `AGENTS.md` bans hand-writing
   into the *runtime* `soul/` repo, but allows automated fixtures outside it.
7. **Runs in GitHub Actions**, `workflow_dispatch` (already requires write access on this public
   repo) behind a protected Environment with required reviewers holding the keys. Plus a local
   CLI path for iteration.
8. **Budget: ~$5 per full run**, both tiers, both models, every run.
9. **`packages/agent-runtime/src/evals/` gets deleted.** It gates *user Agent publication*, has
   zero call sites, and is a different product surface from this effort.

### Facts established while charting

- `AgentLoop` (`packages/agent-runtime/src/loop/loop.ts`) runs in-process with injected ports —
  no Postgres, no worker, no pg-boss. This is the L2 seam.
- `packages/agent-runtime/test/security/harness.ts` (`loopHarness`) is ~90% of an L2 runner
  already: real `AgentLoop`, scripted model, scripted tool dispatch, in-memory checkpoints,
  captured events.
- Fakes that exist: `packages/testkit/src/model.ts` (`FakeModelAdapter`),
  `packages/testkit/src/tool.ts` (`FakeToolAdapter`), memory stores for artifacts, waits and
  soul publication. **No** fakes for secrets, blob or vector ports.
- `SoulLoader` (`packages/soul/src/published-loader.ts`) reads a plain directory tree, so a
  fixture Soul is cheap.
- Model keys resolve via `entry.api_key_ref`: `env://VAR` from env, else `secrets.get(ref)`.
- `ModelUsage` (`packages/llm/src/ports/model.ts`) already carries token counts, cache reads and
  `costUsd` — cost accounting has a source.
- **No record/replay or cassette mechanism exists** anywhere in the repo.
- **No CI job has ever called a real LLM.** This effort introduces the first one.
- Repo is **public**, has no `CODEOWNERS`, and `ci.yml` references no secrets.

## Landed

- **02 — Remove old evals module.** `packages/agent-runtime/src/evals/` deleted; two stale
  reachability-debt entries ratcheted out.
- **03 — Walking skeleton.** `apps/eval`: CLI, corpus loader + hash, pure scorer, runner,
  scorecard, 2 Cases, 49 tests. Runs the *real* assembler and *real* Tool loop on a scripted
  model. Free, deterministic, no credential. Green exits 0, red exits 1.
- **04 — Vocabulary into the glossary.** `metadata/terminologies.md` gained an *Offline eval*
  section — 11 rows, 6 bans. It forced a rename this map did not foresee: **Assertion →
  Expectation**, because the glossary already binds *Assertion* to one Memory statement.
- **Unplanned — `packages/turn-executor` extracted.** Not a ticket. `apps/eval` could not reach
  `createChatExecutor` at all: it lived in `apps/worker`, and no app may import another. The naive
  extraction closure measured 22 files / 3,528 lines / 8 deps and looked prohibitive; counting only
  imports that survive **type erasure** gave 9 files / 1,507 lines / 3 deps. A sixth of its apparent
  size. Unblocks ticket 09. **Reuse that measurement before calling any extraction too big.**

- **05 — Pinned real model.** `pinnedBinding` hands the loop a port wrapping one directly-built
  model, so the Profile catalogue, the tier router and the Effort classifier are all out of the
  path. Plus `withRetry`, a `Spend` ledger, token *and* dollar ceilings, and `--model` /
  `--max-tokens`. 76 tests.
- **Unplanned — `packages/model-adapter` extracted.** Not a ticket. `splitPrompt`, `toOutput`,
  `toToolSet`, `UsageAccumulator` and friends were trapped in `apps/worker`. Moved verbatim; a
  second copy would let the eval score a call the product would never make.
- **05 overturned the spec's central premise.** There are **no API keys**. Both models are vendor
  CLI **subscription seats**, which `packages/llm/src/cli/` has driven all along — and which is what
  the map owner asked for at the outset. Three consequences: `priceCall` reports `subscription`, so
  the **dollar ceiling can never fire** and a token ceiling had to be added; `sonnet` and
  `gpt-5.6-luna` are **aliases, not dated pins**, so the Scorecard now states that caveat instead of
  implying a stability it does not have; and **ticket 01 is wrong as written** — a personal OAuth
  seat cannot live in a public repo's secret store.

## Decisions so far

<!-- one line per closed ticket -->

- [Pin an exact model for a whole eval run](issues/03-pin-an-exact-model.md) — inject a custom
  `ModelPort` wrapping one directly-built `LanguageModelV4`; it bypasses `selectModelProfile`,
  Effort routing and `LlmService` in one move. Effort is pinnable via `route()`'s `options.pinned`.
  A one-model chain is legal and rethrows loudly. **No temperature/top-p/seed knob exists
  anywhere on this path**, and `decidePromptCache` is never called on it.
- [Choose and pin the judge model](issues/04-choose-the-judge-model.md) —
  `gemini-2.5-flash-lite` via the **existing** `openai-compatible` provider, so config only and no
  new provider code. Key `GEMINI_API_KEY`, cost ~1% of budget. Two catches: `provider.ts` never
  passes `supportsStructuredOutputs`, so the judge needs its own model instantiation; and no frozen
  dated alias could be confirmed for this GA model, so runs must record the API-reported version.
- [Establish headless Run execution for the L3 tier](issues/05-l3-headless-execution.md) —
  feasible but ~3-6 engineer-days and 10-60s per journey; **recommends L2-only**. Cheaper than
  feared: PGlite via `makeMigratedPglite()` means no Docker Postgres, and pg-boss is not on the
  single-turn path. Worse than feared: ~12 ports with only 2 reusable fakes, a real git repo needed
  for Soul writes, and Expectations spanning three stores.

## Not yet specified

- **The scorecard.** What a maintainer needs to read to make a release call, and how it reaches
  the release PR (comment, check run, job summary, artifact). Shape depends on what
  [Baseline storage and delta comparison](issues/10-baseline-storage.md) decides a report contains.
- **The CI workflow wiring.** The job that runs the runner and publishes the scorecard. Cannot be
  written before the runner and scorecard shapes exist.
- **Turning the advisory report into a gate, and at what threshold.** Blocked on a real variance
  number from [Measure the noise floor](issues/12-noise-floor.md). Graduates once that exists.
- **Vendor model deprecation policy for the two *subject* models.** The judge's policy is settled
  (judge id joins a composite corpus version; mismatch fails loudly). The same question for
  Claude Sonnet and the GPT model is not, and it is the harder one — the subjects are the thing
  being measured, so a retirement invalidates the baseline in a way no re-scoring can repair.
- **Recovering the prompt-caching saving.** Charting hoped caching would cut the L2 bill.
  [Pin an exact model for a whole eval run](issues/03-pin-an-exact-model.md) found
  `decidePromptCache` is never called on the `AgentLoop`/`ModelPort` seam, so the saving is **not**
  available for free. Whether it is worth reaching for depends on real per-case cost from
  [Cost accounting and the $5 ceiling](issues/11-cost-accounting.md).
- **Principal credential fallback as a silent confound.** `principalModel()` falls back to the
  shared deployment credential when a principal has no usable one. Harmless or not for eval is
  unclear until the runner exists and it is known whether eval runs use a principal at all.

## Out of scope

- **Online / production evals.** Explicitly excluded — this effort is offline only.
- **Agent-publication gating.** The concern of the deleted `packages/agent-runtime/src/evals/`:
  an operator evaluating their *own* Agent before publishing it. A different product surface with
  a different user. If wanted, it is a fresh effort.
- **Model leaderboard / choosing the shipped default model.** The two models are a control, not
  candidates. Ranking them is a different question with a different corpus.
