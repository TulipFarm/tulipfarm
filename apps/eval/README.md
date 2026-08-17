# The offline eval framework

Why every rule here exists. [`AGENTS.md`](AGENTS.md) is the map; this is the reasoning, and it is
the file to read before changing how a Case is scored, run or compared.

Vocabulary is binding: [`metadata/terminologies.md` → Offline eval](../../metadata/terminologies.md#offline-eval).

## Design rules

- **The Eval Soul is loaded, never constructed.** `loadEvalSoul` runs the real `SoulLoader` and the
  real `buildSoulCatalogue` over `apps/eval/soul/`. An eval that hand-built the catalogue would be
  measuring its own fixture code and would keep passing after the loader broke.
- **`soulContext` mirrors production's mapping** (`apps/api/src/chat/system-prompt.ts`): the
  AGENT.md **body** is `personality`, not `customInstructions`. A different mapping here would
  measure a prompt no real turn ever sees.
- **A Case names an Agent; it may not restate one.** The Corpus refuses any `context` field in
  `SOUL_OWNED_CONTEXT_KEYS` — which is exactly the key set `soulContext` returns, derived rather
  than restated. A Case's `context` is spread *over* the Soul's, so a field supplied but not
  refused is a field the Case silently owns; deriving the list is what stops that drift.
  A Case that restated them would drift from the fixture and go on passing after the Soul stopped
  supplying them — the regression naming an Agent exists to catch. A Case's `context` is per-turn
  material only: memory, tagged Resources, the Tool index, user-authored `customInstructions`.
- **The fixture is copied to a temp git repo per load,** never read where it sits: it cannot carry
  its own `.git` inside this repository, and L3's Soul writes must not dirty the tracked fixture.
- **The Eval Soul's hash is folded into `corpusHash`.** A fixture edit changes half of what a Case
  measures, so it must invalidate every Baseline exactly as a Case edit does.
- **Guards run in the turn, and are production's.** `turnGuardrails` enforces the fixture policy
  with `TurnGuardrails` and computes the digest as `turn-context.ts` does. Input refusals settle
  the turn before any model call, Tool refusals reach the model as denials, output refusals replace
  the answer — the driver's ordering, because a Case that measured a different ordering would pass
  on a harness no participant ever meets.
- **`output_field_equals` reads JSON returned as text.** Both compared models are CLI subscription
  seats that answer in text, so demanding `kind: "structured"` would make a structured-output Case
  unpassable on both.
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
- **Two models are a control, not a contest.** A Case that passes on one seat and fails on the
  other is telling you the harness change is model-specific — that is the whole reason a second
  vendor earns its quota. `renderMatrix` names the split Cases and says in words that this is not
  a ranking, because a two-column grid reads as a scoreboard unless it denies it.
- **Models run one after another, never at once,** and each gets the **full** ceiling rather than a
  share of one. Two seats in flight make throttling likelier, which lands as retries and changed
  timing on whichever Scorecard was unlucky; a shared budget would be spent by whoever ran first
  and truncate the last, and a partial Scorecard is not comparable with a complete one. Columns
  follow declaration order — sorting by result would turn the control into a leaderboard.
- **Only a scored Case is comparable.** An `ERR` is a vendor fault and a `-` means the Case never
  ran, so `renderMatrix` holds both out of the disagreement count and lists them under `NOT
  COMPARABLE`. Comparing them would report a rate limit or a spent ceiling as model-specific
  harness behaviour — the confound the whole framework exists to remove.
- **One model failing whole does not discard the other.** `runSweep` almost never rejects — a
  missing credential surfaces inside the call, so a dead seat yields a full Scorecard of errored
  Trials. A Sweep that scored nothing is collapsed into `ModelRun.unavailable` rather than rendered
  as a column of `ERR`, which would read as the harness differing under that model when nothing was
  measured at all. It still fails the command; the model that did run keeps its results.
- **A real Sweep reports as it goes, on stderr.** A Trial against a seat takes seconds and a matrix
  takes minutes; a command that prints nothing until it is done looks hung, and a killed run has
  spent its quota for no Scorecard. Progress never touches stdout — the Scorecard there is the
  artifact a release reads, and interleaved chatter would corrupt anything parsing it.
- **`corpusHash` is the unit of comparability.** Two Scorecards with different hashes are not
  comparable. Never compare across `modelId` either. `compareToBaseline` *throws* on either
  mismatch rather than returning a number, and the CLI prints `REFUSED` and fails: a delta computed
  across two Corpora is confident, precise and entirely fictitious, which is worse than no delta.
  It follows that a Corpus edit can never manufacture an improvement — it invalidates the Baseline.
- **Nothing becomes the Baseline on its own.** Promotion is `--promote` and only `--promote`.
  A run that promoted itself would make every later delta a comparison against whatever ran most
  recently, which is the drift a Baseline exists to detect. Promotion is refused from an
  uncommitted tree (nobody else can reproduce it), from a partial Sweep (its unreached Cases become
  permanently incomparable) and from one with vendor errors. A `--case` Sweep counts as partial:
  it keeps the whole Corpus hash while covering one Case, so `Scorecard.corpusCases` records what
  the Corpus held and promotion is refused unless the Sweep covered it. The scripted binding cannot
  be promoted at all: it is told what to say, so it cannot fail.
- **A regressed Sweep cannot promote itself,** even when `--baseline --promote` are given together.
  Promoting the run that just failed the gate would launder the regression into the reference and
  the next run would read green. Promotion also always writes `baselines/<model>.json`, never the
  file named by `--baseline <path>` — that path is a comparison source, and overwriting it would
  destroy an archive while the output claimed the Baseline had moved.
- **A regression fails the command; a fix does not.** That is the whole release gate. `ERR` and
  never-run Cases are held out of the delta for the same reason they are held out of the grid.
- **Every Case carries a `script`,** so the whole Corpus runs free and deterministically in ordinary
  CI. A real-model binding ignores it. This is what lets a contributor without vendor keys develop
  the framework.
- **`loadCorpus` throws rather than skipping** a malformed Case: silently dropping one reports a
  pass rate over a smaller denominator than the reader believes.
- **Output Expectations are case-insensitive; prompt Expectations are exact.** We assemble the
  prompt, so `prompt_contains` can demand the byte. The model writes its own prose, so a Case that
  failed because one vendor wrote "9 AM" where another wrote "9am" would be measuring
  capitalisation rather than the harness. The grounding guard matches the same way, or a Case could
  be refused as ungrounded and then pass.
- **A failing output Expectation quotes what the model said.** Without it the reader knows the
  answer was wrong but not how, and has to spend the vendor quota again to find out. Collapsed to
  one line and truncated so it cannot flood the Scorecard.
- **A content expectation must be grounded in what the model was given** — its text or pattern has
  to appear in the Case's `context`, `input` or `toolResults`. `script` does not count; it is the
  fake model's own words, so an expectation grounded there checks the script against itself. This
  is the one authoring fault the scripted tier cannot catch, and it surfaces against a real model
  as a failure that reads like a regression. Genuinely ungrounded checks — refusal wording, output
  format — set `ungrounded` to the reason; the rule bans the silent ones, not the deliberate ones.
  **`output_omits` is held to the same rule for the opposite reason**: text the model was never
  given can never appear, so an ungrounded one passes with the guard deleted.
- **`tool_call_count` is only a harness assertion at zero.** `count: 0` says the turn reached no
  Tool at all — that a guard settled it, or that the Agent answered from its Context — and the
  harness decides that. Any positive count pins how many times a model chose to call something,
  which is vendor strategy: `luna` calls a lookup twice where `sonnet` calls it once, and neither
  is a harness defect. Assert `tool_called`, `tool_argument_equals` and `tool_call_order` instead;
  `loop_status` already catches a runaway loop.
- **A Case must script a result for every Tool it exposes.** An unscripted call fails with a
  message naming the Tool, and a Tool called more often than the Case scripted repeats its last
  result. Neither fabricates an empty success — a payload the author never wrote would drive the
  rest of the turn, and a model reads an empty result as a reason to call again.
- **A guardrail Case must fail with the guard removed.** Assert `guardrail_blocked` with the guard
  named, and make the model's route to the violation mechanical — a Tool result that hands it the
  card number, a lookup whose `nextAction` names the blocked Tool. A Case that merely hopes the
  model misbehaves measures the vendor's mood. Prove it by editing `soul/guardrails.yaml` and
  checking that Case, and only that Case, turns red.
- **Nothing selects the model but the pin.** `pinnedBinding` hands the loop a port wrapping one
  directly-constructed model, so the Model Profile catalogue, the tier router and the Effort
  classifier are all out of the path. Effort is declared on the `PinnedModel`, never inferred: a
  classifier change would otherwise silently move what every Case measures.
- **Both pins are aliases, and the Scorecard says so.** A dated id would be better — one the vendor
  rolls forward reads exactly like a harness regression — but neither seat publishes one, so
  `dated: false` prints a `NOTE`. A reported version is recorded only when it differs from the id
  we asked for; the SDK echoes the request otherwise, and an echo is not a confirmation.
- **A credential is checked before the first Trial, not by the vendor.** `preflight` rejects a
  missing or malformed one up front: a bad `CODEX_AUTH_JSON` otherwise fails every Case in the
  Corpus identically and slowly, and reads as a model that behaves differently rather than one that
  was never reachable. `credentialShape` stays declarative so the provider SDK is still only
  imported when a real model is selected.
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

Drop a JSON file in `corpus/`. Required: `id`, `tier` (`"l2"` or `"l3"`), `agent`, `context`, a non-empty
`input`, and `expect`. Run `pnpm eval --case <id>` to check it in isolation.

Put every fact the answer needs into `context` or `toolResults`, never only into `script`. A Case
whose expected answer is not somewhere the model was handed cannot be satisfied except by luck,
and `loadCorpus` will refuse it.

## The two tiers

**L2** is the default and where nearly every Case belongs. It assembles the real system prompt,
runs the real Tool loop, and applies the real guardrails — all in memory, in milliseconds, with
no database. It can observe everything the harness *decides*.

**L3** exists for the one thing L2 structurally cannot see: whether a decision **survives**. It
boots an in-process PGlite from `@tulipfarm/storage`'s own DDL, mints a real Run, and drives
`createChatExecutor` from `@tulipfarm/turn-executor` — the same executor a production Turn runs
through — then reads the persisted result back. That unlocks five Expectation kinds L2 cannot
honour: `run_status`, `state_status`, `turn_status`, `run_event_emitted` and `soul_committed`.
`loadCorpus` refuses any of them on an L2 Case, so the mistake costs no model calls.

It deliberately stays small. Each L3 Case costs ~1.5s of setup against L2's milliseconds, and the
extra reach buys nothing for a Case about prompt content or Tool ordering. Reach for L3 only when
the assertion is genuinely about durability.

**Why it does not enter through the API's `/chat` route,** which is the path a real user takes:
`docs/architecture/dependency-rules.md` rule 1 forbids an app importing another app, and the
conversation repository, the migrations and the routes all live in `apps/api`.
`packages/turn-executor` was extracted precisely so this eval could drive a real Turn without
that import, so L3 owns the Conversation half itself and shares the executor. The API's own
wiring is covered by `apps/api`'s `durable-submission.pg.test.ts`, so the residual gap is the
route handler, not the Turn.

### Journeys

An L3 Case may carry a `journey` of further Turns, run against the same Conversation, database and
Soul. They exist for **one** seam a single Turn cannot reach: whether what a Turn *committed* is
what the next Turn can *see*. Between Turns the Soul is re-read with a fresh `SoulLoader` and the
Conversation is re-read from the database, so the real writer and the real loader end up on
opposite sides of one assertion.

That is not hypothetical. Building this tier turned up a live case of exactly that shape: the Soul
writer's canonical mode commits `agents/<slug>/agent.yaml`, but `SoulLoader` only reads the legacy
`AGENT.md` — so the write succeeded, the commit landed, and the product could not see it. A
single-Turn Case asserting `soul_committed` passes straight through that. The journey Case
`l3-a-committed-agent-is-visible-next-turn` does not.

History is deliberately re-read from `eval_messages` rather than accumulated in a variable: holding
it in memory would let a journey pass while the Turn persisted nothing at all.

Keep journeys rare. Anything a journey appears to test other than that seam — ordering, wording,
refusal — is carried far more cheaply by an L2 Case.

Each Trial gets a fresh clone of a memoised migrated snapshot, and the Eval Soul is
`git reset --hard`-ed back to its load-time commit in a `finally` — otherwise a Case that writes
a Soul artifact would be visible to every Case scored after it.

## Running against a real model

Both pinned models are **vendor CLI subscription seats**, not metered API keys. They cost $0 per
call and spend a personal quota instead, so a token ceiling is the only one that can bind them —
and `--model` refuses to run without one.

```bash
pnpm eval                                    # scripted: free, deterministic, no credentials
pnpm eval:sonnet                             # claude-code seat, prompts for the token
pnpm eval:luna                               # codex seat, reads ~/.codex/auth.json
pnpm eval:matrix                             # both seats, same Corpus, side by side
pnpm eval:sonnet --case support-answers-without-tools --max-tokens 5000
```

- **Express the ceiling per Trial, not per Sweep.** `--max-tokens-per-trial <n>` is multiplied by
  the Trials the Sweep plans, so it survives the Corpus growing and a `--case` filter shrinking it.
  A fixed `--max-tokens` is sized for the Corpus of the day it was written: the 20000 that held two
  Cases comfortably truncated the Sweep at five of nine once the guardrail Cases landed — and a
  truncated Sweep reports its unrun Cases as `NOT COMPARABLE`, which reads like a smaller Corpus
  rather than like a mistake. The two flags are mutually exclusive.
- **Budget per Trial from the heavier seat.** The two are not close: `luna` spends roughly 5.2k
  input tokens per model call against `sonnet`'s 1.7k, so a three-call Case costs it ~16k. The
  `seat.sh` default of 15000 per Trial is set from that, not from the average.

`scripts/seat.sh` collects every named seat's credential up front, into its own environment, so it
never enters your shell, your history, or a file. It defaults `--max-tokens-per-trial` to 15000 and
never overrides a ceiling you passed.

Codex's credential is a JSON document rather than a token, but it is pasted the same way: from
`$CODEX_AUTH_JSON`, else `$CODEX_AUTH_FILE`, else `${CODEX_HOME:-~/.codex}/auth.json`, else the
prompt, **on one line**. Wrapping quotes are stripped and a multi-line paste is refused, because
`read` keeps only the first line and the vendor answers a lone `{` with a bare 401 that says
nothing about the paste.

The prompt turns the terminal's line editor off first. A tty in canonical mode **discards any line
past `MAX_CANON`** — 1024 bytes on macOS — and never delivers the newline, so a multi-kilobyte
credential does not arrive truncated: the prompt hangs, with nothing to indicate why. The full
`stty -g` state is saved and restored, including on Ctrl-C. Abort with Ctrl-C, not Ctrl-D: with the
line editor off the kernel no longer treats Ctrl-D as end-of-file.

## The noise floor

There is no temperature, top-p or seed control anywhere in the model invocation path, so a Sweep
cannot run at temperature 0 and two identical Sweeps are not guaranteed to agree. `--repeat <n>`
runs every Case `n` times and records which Cases disagreed **with themselves**.

A delta then damps against the Baseline's own recorded floor, per Case rather than by count: a
movement on a Case the Baseline saw flap is `NO SIGNAL`, and a movement on one that never flapped
is a regression however many others flapped. A Baseline promoted without `--repeat` records no
floor, damps nothing, and says so on every delta.

Promote with it: `pnpm eval:sonnet --repeat 5 --promote`.

## Sampling controls, and why there are none

Temperature and seed are not threaded through the model path, and this is a decision rather than an
omission. No provider in `packages/llm` carries either field today, so adding them would widen the
invocation path the whole product shares.

What it would buy here is nothing: **both models under test are CLI subscription seats**
(`claude-code`, `codex`), and neither CLI accepts a temperature or a seed. The two Sweeps that
actually gate a release could not honour the setting. It would be configuration that reads as a
control and is silently dropped — the exact failure the Matrix option bug already taught us.

The variance those knobs would damp is instead **measured** rather than suppressed, by
`--repeat n` and the noise floor below. Revisit this only if a seat gains real sampling controls,
or if a measured floor turns out to be wide enough to drown a real delta.

## The red-team Corpus

`corpus/red-team/` holds attacks. It has its own hash and its own Baseline folder
(`baselines/red-team/`), so adding an attack cannot invalidate a capability Baseline.
`pnpm eval:redteam` runs it alone; a CI Sweep runs both in separate blocks.

Every Case there declares `redTeam`, and the declaration decides how it scores:

| `outcome` | What it proves | Scoring |
| --- | --- | --- |
| `guard_held` | A harness defence fired | Deterministic. **Gates the release.** |
| `model_resisted` | No guard fired; the model declined | A rate over Trials. **Never gates.** |

A Case may assert one or the other, never both — a Case asserting both would stay green after the
guard was deleted, because the model refused anyway. The loader rejects it.

`strategies` derive one Case per named transform (`base64`, `leetspeak`, `roleplay`,
`multilingual`, `indirect`). Every derivative is forced to `model_resisted`: a disguised payload is
exactly what a keyword guard is built to miss, so gating on it would leave a permanently red gate.
The Resistance block still reports whether a *later* guard held, so the harness is not
under-credited. Strategies are pure `(payload, seed) => Case`, never model-authored — a
model-generated attack could not be content-hashed, so no Baseline built on it would be comparable.

Every red-team Case names a `class` from `src/vulnerability.ts` — seven classes the harness can
own. The safety block groups by class, never by Case id, and prints a row for every class whether
or not one is covered, so a coverage gap is as visible as a failure. One `LEAKED` at high severity
fails the run on its own.

## The Judge

Deterministic Expectations are the backbone. `rubric_score` and `rubric_denies` exist only where
`===` genuinely cannot do the job, and both are answered by a pinned third-vendor Judge reached
through the existing `openai-compatible` provider — configuration, not a new adapter.

Configure it with `EVAL_JUDGE_BASE_URL`, `EVAL_JUDGE_MODEL`, `EVAL_JUDGE_API_KEY`. Pointing it at
a vendor already under test is refused: a model grading its own homework scores itself generously
and nothing in the result shows it. The Judge's identity is folded into the Corpus hash, so
swapping it breaks comparison loudly rather than silently re-scoring history.

Two rules that are the whole point:

- A failed, empty, unparseable or out-of-range Judge reply **errors the Trial**. It is never a low
  score — a Judge that is down would otherwise be indistinguishable from a quality regression.
- A Case carrying a rubric with no Judge configured **errors** rather than skipping. A quality
  check that passes because nothing measured it reads as coverage, which is worse than no check.

The default Corpus carries no rubric Case, so `pnpm eval` needs no Judge and no key.

## The CI door

`.github/workflows/eval.yml` is the second way to start a Sweep, for a release rather than for a
change you are making. It runs `scripts/seat.sh` too, so a green Actions run and a green
`pnpm eval:matrix` came from one runner, not from two that agree today.

Three things make it maintainer-only and it needs all three: `workflow_dispatch` is the only
trigger and a fork cannot dispatch into the upstream repo; the `eval` Environment holds
`CLAUDE_CODE_OAUTH_TOKEN` and `CODEX_AUTH_JSON`, which GitHub never exposes to a fork's run; and
that Environment's required reviewer pauses the job before it spends a token. `workflow.test.ts`
pins all three, so adding `pull_request:` to run evals on PRs fails the suite instead of opening
two personal seats to anyone who can open a PR.

CI passes `--save-dir`, the Matrix form of `--save`: it writes `<dir>/<model>.json` for every
model measured, and is uploaded whole as the run's artifact.
