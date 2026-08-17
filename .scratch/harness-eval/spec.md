# Spec: offline eval for the agent harness

Label: `in-delivery`
Status: tickets 02, 03, 04 landed; 05 next; 01 deferred
Map: `.scratch/harness-eval/map.md` · `map.html`
Tickets: `.scratch/harness-eval/issues/`

## Delivery status

*Updated 2026-08-18. This section is the only part of the spec that changes as work lands; the
rest is amended only where delivery proved the spec wrong, and every such amendment is marked.*

| # | Ticket | State | What actually landed |
|---|---|---|---|
| 01 | Provision eval credentials | **deferred by the developer** | Browser work, needed only at ticket 12. Deliberately postponed until push time |
| 02 | Remove old evals module | **done** | `packages/agent-runtime/src/evals/` deleted; 2 stale reachability-debt entries ratcheted out |
| 03 | Walking skeleton | **done** | `apps/eval` — CLI, corpus loader + hash, pure scorer, runner, Scorecard, 2 Cases, 49 tests. `pnpm eval` green → exit 0, red → exit 1 |
| 04 | Vocabulary into glossary | **done** | `metadata/terminologies.md` → *Offline eval*, 11 rows + 6 bans. Forced the Assertion → **Expectation** rename |
| — | *Unplanned:* extract `packages/turn-executor` | **done** | Not a ticket. A blocker found while building 03 — see *Siting* below |
| — | *Unplanned:* extract `packages/model-adapter` | **done** | Not a ticket. SDK↔`ModelPort` conversion was trapped in `apps/worker`; an app may not import an app |
| 05 | Pinned real model | **done** | `pinnedBinding`, `withRetry`, `Spend`, token + dollar ceilings, `--model`/`--max-tokens`. 76 tests. Forced the API-provider → **subscription CLI** correction |
| 06–16 | | not started | |

Four things delivery proved this spec got wrong, each corrected in place below:

1. **The Chat executor was unreachable**, not merely un-plumbed — see *Siting*.
2. **"Assertion" was already taken** by Memory — see *Collision note 2*.
3. **A Case with no Expectations scored as a pass.** `[].every(...)` is `true`, so a Case expecting nothing
   cleared the release gate having checked nothing. Now rejected at load, counted against the exit
   code, and named **Vacuous** in the glossary. The spec never anticipated it; it is the framework's
   worst failure mode because it fails *green*.
4. **The two models are subscription CLI seats, not API providers** — see *Correction: the vendors*.

## Problem Statement

A maintainer changes the agent harness — the context assembler, the guardrail composer, the
bounded Tool loop, the Effort router, the Memory Core Block, the retrieval path — and has no way
to answer the only question that matters before shipping it: **did that make the product better,
or did I just move a number?**

Today the only evidence available is unit tests with scripted models. Those prove the harness does
what the harness was written to do. They cannot prove that a real model, handed the real assembled
Context, actually behaves better. The two are not the same thing, and the gap between them is
exactly where harness regressions live.

The consequences the maintainer feels:

- A prompt or Context-assembly change ships on vibes. It looked better in one manual Chat.
- A regression is invisible until a user reports it, by which point the causing change is
  many commits back and hard to isolate.
- There is no way to distinguish a genuine improvement from run-to-run model variance, so every
  claimed improvement is unfalsifiable.
- Changes that are obviously good in one model silently regress the other vendor, and nobody
  finds out, because nobody ever runs both.
- Cost and latency regressions are wholly invisible — a change that doubles token spend for a 2%
  quality gain looks identical to a free win.
- The repository is public. There is no safe way to let a real-model check exist in CI without
  handing every fork's contributor a button that spends the maintainer's model budget.

## Solution

A **manually triggered, pre-release, offline eval framework**.

One runner, two front doors:

```
   ┌──────────────────────┐        ┌────────────────────────────────┐
   │  local:  pnpm eval   │        │  CI: workflow_dispatch          │
   │  a maintainer's box  │        │  + protected Environment        │
   └──────────┬───────────┘        └───────────────┬────────────────┘
              │                                    │
              └───────────────┬────────────────────┘
                              ▼
                    ┌───────────────────┐
                    │   ONE eval runner │
                    └─────────┬─────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
      ┌───────────────┐               ┌───────────────┐
      │  L2 tier      │               │  L3 tier      │
      │  AgentLoop    │               │  real Postgres│
      │  faked tools  │               │  fixture Soul │
      │  one turn     │               │  multi-turn   │
      └───────┬───────┘               └───────┬───────┘
              └───────────────┬───────────────┘
                              ▼
                   ┌─────────────────────┐
                   │  Scorecard          │
                   │  + delta vs baseline│
                   │  + cost + noise band│
                   └─────────────────────┘
```

Before a release, a maintainer triggers a **Sweep**. It executes a versioned corpus of eval cases
against the harness, twice over — once on **Claude Code (`sonnet`)** and once on **Codex
(`gpt-5.6-luna`)** — and emits a Scorecard with per-case verdicts, aggregate scores, token usage,
and the delta against a stored baseline. *Amended: this said "Claude Sonnet (anthropic)" and "a
GPT model (openai)" — see* Correction: the vendors.

The two models are a **control, not a competition**. If a harness change improves one model and
regresses the other, that is a property of the change, and the maintainer needs to see it.

Crucially, the Scorecard reports a **noise floor**: the run-to-run variance measured with no
harness change at all. A delta inside the noise band is reported as *no signal*, not as an
improvement. This is what makes the framework honest rather than decorative.

For v1 it is **advisory** — it reports, it does not block the release. It earns the right to
become a gate only after the noise floor has been measured and shown to be small enough that a
gate would not fire spuriously.

Nobody outside the maintainer trust boundary can trigger it. The credentials live in a protected
GitHub Environment behind required reviewers.

## New vocabulary

The glossary (`metadata/terminologies.md`) had no eval nouns. This spec introduced them, and
ticket 04 added them under a maintainer-only *Offline eval* sub-section. **That section is now
binding and this table is only a summary of it.**

| Concept | Canonical name | Notes |
|---|---|---|
| One unit of measurement: a fixed input plus its expectations | **Eval Case** | ⛔ "test case" — reserved for Vitest |
| The versioned, hashed set of Eval Cases | **Corpus** | Its hash is part of Sweep identity |
| One execution of a Corpus against one harness version × one model | **Sweep** | see collision note below |
| One execution of one Eval Case inside a Sweep | **Trial** | a Case may have N Trials for variance |
| The report a Sweep emits | **Scorecard** | |
| A Scorecard promoted to reference status | **Baseline** | one per (harness version × model) |
| Run-to-run variance measured with no harness change | **Noise Floor** | |
| The pinned third-vendor model that scores prose | **Judge** | never anthropic or openai |
| A deterministic, model-free check on a Trial | **Expectation** | see collision note below |
| A Trial that passed while expecting nothing | **Vacuous** | rejected at load; counted against the exit code |
| The frozen, version-controlled fixture Soul the eval runs against | **Eval Soul** | |

**Collision note 1 — do not call a Sweep an "Eval Run".** `Run` is already the canonical name for
one execution of a Routine, and it is load-bearing across `run-kernel`, `RunOutcome`, `runId`,
`Run event` and `Run State`. An L3 Trial *contains* real Runs. Naming the outer loop a "Run" too
would make every L3 code path ambiguous at exactly the moment it is hardest to reason about.
`Sweep` is unloaded in this codebase and stays unambiguous inside L3.

**Collision note 2 — do not call an Expectation an "Assertion".** *Corrected during delivery.* This
spec originally called the deterministic check an **Assertion**. The glossary already binds
**Assertion** to one durable Memory statement (`MemoryAssertion`, REST `/api/v1/memory/assertions/:id`),
and its first rule is that one term names exactly one concept. **Expectation** was chosen instead —
the field the checks live under was already called `expect`, so `expect: Expectation[]` reads better
than what it replaced. Ticket 04 carried the rename; `apps/eval` holds no `Assertion` today.

Ticket 04 landed all of the above in `metadata/terminologies.md` under *Offline eval*, which is
binding and outranks this spec wherever the two disagree.

## Correction: the vendors

*Added 2026-08-18, during ticket 05. This spec assumed two API providers reached with API keys.
The operator holds neither key.*

What this deployment actually reaches a model with is two **vendor CLI subscription seats**, which
`packages/llm/src/cli/` has driven all along:

| Sweep name | Provider | Model | Credential |
| --- | --- | --- | --- |
| `sonnet` | `claude-code` | `sonnet` | `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token` |
| `luna` | `codex` | `gpt-5.6-luna` | `CODEX_AUTH_JSON`, the contents of `~/.codex/auth.json` |

These are the two the operator named at the outset. Three parts of this spec are wrong as a result,
and are corrected here rather than rewritten throughout:

**1. "Token cost" is tokens, not dollars.** `priceCall` classifies both providers as
`subscription`, which is right: a seat has a genuine zero marginal cost, and charging it published
API rates would abort Sweeps that had budget left. The consequence is that a **dollar ceiling can
never trip on a seat**. `--max-tokens` was added as the ceiling that actually binds, because tokens
are what the vendor meters. Wherever this spec says a Sweep is bounded by spend, read *bounded by
tokens, or by spend for any future priced provider*.

**2. Nothing here is a dated pin.** `sonnet` and `gpt-5.6-luna` are aliases the vendor may move
between Sweeps. The spec's promise that a Sweep isolates harness change from model change is
therefore **weaker than stated**: the alias can roll forward underneath a baseline comparison. Two
mitigations are built — the version the vendor reports is recorded per Sweep, and the Scorecard
prints an explicit `NOTE` that the id is an alias. Neither is as good as a dated id. Saying so on
the Scorecard is the point; a silent weakening is what this framework exists to prevent.

**3. Ticket 01 has to be re-decided.** It assumed a protected GitHub Environment holding
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. A personal OAuth seat cannot go into a public repository's
secret store — it is one person's credential, and sharing it is both a security exposure and
against the spirit of the vendor's terms. The release Sweep therefore either runs on a maintainer's
own machine and uploads its Scorecard as a release artifact, or waits for org-owned API keys. The
maintainer-only property still has to hold; it just cannot be enforced by a repository secret.

## User Stories

**Triggering and access control**

1. As a maintainer, I want to trigger a Sweep manually from the GitHub Actions UI, so that I can
   check a release candidate without waiting for a schedule.
2. As a maintainer, I want to trigger the identical Sweep locally with `pnpm eval`, so that I can
   iterate on a harness change without burning a CI slot per attempt.
3. As a maintainer, I want the local and CI front doors to execute the exact same runner code, so
   that a green local result is not quietly different from a green CI result.
4. As a maintainer, I want the Sweep to require an approval from a named reviewer before it spends
   any model budget, so that a stolen or mis-scoped token cannot drain my vendor accounts.
5. As an open-source contributor with a fork, I want my pull request to be unable to trigger a
   Sweep, so that I cannot spend the maintainer's money by accident or by malice.
6. As a maintainer, I want the model credentials to exist only inside a protected Environment, so
   that they are never readable from an ordinary workflow or a fork's build.
7. As a maintainer, I want to select which models a Sweep runs against at trigger time, so that I
   can do a cheap single-model smoke check without paying for the full matrix.
8. As a maintainer, I want to select which tier runs (L2 only, or L2 + L3), so that I can trade
   thoroughness against wall-clock time depending on how close I am to the release.
9. As a maintainer, I want to run a single named Eval Case, so that I can debug one failing case
   without re-executing the whole Corpus.

**Measuring the harness**

10. As a maintainer, I want each Eval Case to exercise the real assembled Context against a real
    model, so that the result reflects product behaviour and not just harness plumbing.
11. As a maintainer, I want the harness version under test to be recorded in the Scorecard, so
    that I can attribute a delta to a specific change.
12. As a maintainer, I want the same Corpus executed against both vendors, so that I can see when
    a change helps one model and hurts the other.
13. As a maintainer, I want an L2 tier that runs one Turn through the Tool loop with faked Tools
    and storage, so that the majority of my cases are fast and cheap.
14. As a maintainer, I want an L3 tier that runs a multi-Turn journey against a real database and
    the Eval Soul, so that I have end-to-end proof that the whole product path works, not just the
    loop in isolation.
15. As a maintainer, I want L3 Trials to assert on persisted state — the Records written, the
    Soul artifacts committed, the Run events emitted — so that I am measuring what the product
    actually did, not just what it said.
16. As a maintainer, I want the exact model identifier pinned per Sweep and recorded, so that a
    vendor silently rolling their alias forward cannot be mistaken for a harness regression.
17. As a maintainer, I want the eval to bypass Model Profile selection and Effort routing, so that
    the model under measurement is the one I chose and not one the router picked.
18. As a maintainer, I want Effort pinned explicitly, so that a routing classifier change does not
    silently alter what every Eval Case is measuring.
19. As a maintainer, I want to know that the eval never silently fell back to a different
    credential or a different model, so that a Scorecard is never quietly measuring the wrong thing.

**Scoring**

20. As a maintainer, I want the majority of scoring to be deterministic Expectations, so that most
    of my signal has no model-shaped uncertainty in it at all.
21. As a maintainer, I want Expectations on which Tools were called, in what order, and with what
    arguments, so that I can measure harness behaviour precisely.
22. As a maintainer, I want Expectations on structured output shape and content, so that schema
    regressions are caught exactly.
23. As a maintainer, I want Expectations on refusal and guardrail behaviour, so that a Context change
    that weakens a guardrail is caught immediately.
24. As a maintainer, I want a Judge model only for the cases where the thing being measured is
    genuinely prose quality, so that I am not paying a model to check something `===` could check.
25. As a maintainer, I want the Judge to be a third vendor, different from both models under test,
    so that a vendor is never grading its own homework.
26. As a maintainer, I want the Judge model pinned and recorded in the Corpus version, so that
    swapping the Judge invalidates comparisons loudly instead of silently re-scoring history.
27. As a maintainer, I want a Judge disagreement or failure to be reported as an error rather than
    a low score, so that infrastructure failure never masquerades as a quality regression.

**Baselines, deltas and trust**

28. As a maintainer, I want each Scorecard compared against a stored Baseline for the same model,
    so that I see change rather than an absolute number I have no way to interpret.
29. As a maintainer, I want to explicitly promote a Scorecard to Baseline, so that a bad run never
    silently becomes the new reference.
30. As a maintainer, I want the noise floor measured by running the identical harness repeatedly,
    so that I know how big a delta has to be before it means anything.
31. As a maintainer, I want deltas inside the noise band reported as "no signal", so that I am not
    fooled into believing in an improvement that is really variance.
32. As a maintainer, I want per-case verdicts and not just an aggregate score, so that I can see
    which specific behaviour moved.
33. As a maintainer, I want a Corpus hash in every Scorecard, so that I cannot accidentally compare
    two Sweeps that measured different things.
34. As a maintainer, I want a Sweep against a changed Corpus to refuse to report a delta against an
    older Baseline, so that a Corpus edit cannot manufacture a fake improvement.
35. As a maintainer, I want the Scorecard to be a durable artifact I can archive, so that I can
    revisit why a past release was believed to be good.

**Cost and operability**

36. As a maintainer, I want the token cost of every Sweep reported in dollars, so that I know what
    each pre-release check costs me.
37. As a maintainer, I want a Sweep to abort if projected spend exceeds a configured ceiling, so
    that a runaway loop cannot produce a surprise invoice.
38. As a maintainer, I want per-case cost broken out, so that I can find the one expensive case
    that is not earning its keep.
39. As a maintainer, I want a transient vendor error to be retried and reported distinctly from a
    genuine case failure, so that vendor flakiness never reads as a harness regression.
40. As a maintainer, I want a Sweep to keep going after one case fails, so that one bad case does
    not cost me the whole run's information.
41. As a maintainer, I want the Sweep's wall-clock time bounded, so that a hung vendor call cannot
    block a release indefinitely.
42. As a maintainer, I want to run the framework's own tests without any credential, so that
    ordinary contributors can still develop the eval framework itself.

**Fixtures**

43. As a maintainer, I want a frozen Eval Soul checked into version control, so that every Sweep
    measures against identical configuration.
44. As a maintainer, I want the Eval Soul to be entirely separate from the runtime `soul/` repo,
    so that the product-surfaces rule is never violated to set up a test.
45. As a maintainer, I want a change to the Eval Soul to change the Corpus version, so that a
    fixture edit cannot silently invalidate a comparison.

**Housekeeping**

46. As a maintainer, I want the previous unused `evals` module removed, so that there is exactly
    one thing in the repository called "eval" and no ambiguity about which is real.

## Implementation Decisions

### Seams — the central decision

**One interface carries the entire framework: `ModelPort`.** No new injection seam is required to
attach the eval to the product, at either tier. This was verified against the code, not assumed:

- L2: `AgentLoop` is constructed with an injected `model` port alongside `tools`, `checkpoints`,
  `events` and `budget`. It has no ambient dependency on Postgres, the worker, or pg-boss.
  **Caveat, verified against the code:** the loop receives `messages` *already assembled*, plus
  Context and guardrail digests. Context assembly and guardrail composition are separate functions
  sitting above it. Attaching the eval only at the loop would therefore measure the Tool loop
  against hand-written prompts and would not detect a Context-assembly regression at all. **The L2
  runner must call the real assembler and feed its output into the loop.** Both live in the same
  package and the assembler is pure, so this costs little — but it decides what an Eval Case must
  carry, so it belongs in the walking skeleton rather than being added later.
- L3: the Chat executor already accepts `model` as **either** a `ModelPort` **or** a factory
  function receiving the per-Turn writer, budget manager, business, run and conversation. The
  injection point the eval needs at L3 already exists and was built for another reason.
  **Correction, found during delivery:** the injection point existed but was not *reachable*. The
  Chat executor lived in `apps/worker`, and the repository forbids one app importing another. See
  *Siting — the correction this spec missed* below.
- The framework's own Vitest suite: the existing testkit model fake is already structurally a
  `ModelPort`.

So the same interface accepts a pinned real model, a scripted fake, and the Judge. Three uses, one
shape, zero new seams for model injection.

**Exactly one new seam is introduced: the eval runner's entry point.** Corpus + tier + model
binding in, Scorecard out. It is the only component in the framework that performs I/O, and
therefore the only one that needs a seam at all. Everything downstream of it is pure and is tested
by direct call.

This was confirmed with the developer before writing this spec.

### Siting — the correction this spec missed

*Added during delivery. This spec asserted the L3 seam already existed and stopped there. It did
exist, but it was in the wrong workspace, and that was not discovered until the walking skeleton
was built.*

The eval must be an **app**: it imports `agent-runtime` and the Chat executor, and a package may
never import from `apps/*`. But `createChatExecutor` lived in `apps/worker`, and the repository's
first dependency rule also forbids **one app importing another**. So `apps/eval` could not reach
the L3 seam at all. Neither half of the rule is negotiable and neither could be worked around.

The fix was to extract the executor into `packages/turn-executor`. The naive case against doing so
looked prohibitive — a first measurement of the import closure said **22 files, 3,528 lines and 8
workspace dependencies**, including `llm`, `storage`, `db` and `secrets`.

**That measurement was wrong, and the technique that corrected it is worth reusing.** Counting only
the imports that survive *type erasure* — excluding `import type` and clauses whose every specifier
is `type X` — gave **9 files, 1,507 lines and 3 dependencies**. The heavy modules were referenced
only as types. The extraction was roughly a sixth of its apparent size.

`packages/turn-executor` therefore *declares* its ports (`RunExecutor`, `RunOutcome`, `SpendSink`,
`ModelCallReceipt`) and never imports an implementation. The worker satisfies them from outside.
Adding a concrete store or provider dependency to it would re-couple it and undo the extraction.

Cost: 9 modules and 10 test files moved, 9 worker files repointed, worker's 408 tests still green.
Ticket 09 is unblocked as a result; nothing else in the plan changed.

### Model pinning

Pin by injecting a custom `ModelPort` that wraps one directly-constructed provider model. This
bypasses Model Profile selection, the Effort router and the LLM service fallback chain in a single
move, because the loop only ever sees the port.

Two alternatives were investigated and rejected:

- Setting the model in the Eval Soul's `llm` config — rejected: still runs Model Profile selection,
  so the router remains in the measurement path.
- Building a single-entry fallback chain — rejected: that API takes *model* identifiers rather than
  *profile* identifiers, which makes it the wrong level of abstraction for this, and it leaves the
  service layer in the path.

Effort is pinned explicitly through the router's pinned-override option rather than left to the
classifier.

### Sampling controls — a known gap

**No temperature, top-p or seed control exists anywhere in the model invocation path today.** The
model invocation request carries request id, profile, messages, tools, output schema, max output
tokens, policy, principal and agent — and nothing else. The provider factory takes only the
provider entry plus credentials, timeout, principal and logging.

**Consequence: v1 cannot run at temperature 0.** This is precisely why the noise floor must be
measured before the framework is trusted, and why v1 is advisory rather than a gate.

Adding sampling controls is deliberately sequenced *after* the noise floor is measured, so that the
value of adding them is known rather than assumed. If the noise floor turns out to be acceptable
without them, the change is not worth its blast radius across the model path.

### Judge

A pinned model from a third vendor, reached through the **existing** OpenAI-compatible provider —
configuration only, no new adapter. Estimated at well under 1% of the Sweep budget, so Judge cost
is not a design constraint.

One gotcha found: the provider construction path does not pass the structured-outputs capability
flag through to the OpenAI-compatible SDK, so it defaults off and JSON-schema mode is never
requested. **The Judge therefore requires its own model instantiation rather than reusing the
shared construction path.**

The Judge identity is not incidental metadata — it is part of Corpus identity:

```
corpus_version = <corpus-content-hash> : <judge-model-id> : <judge-vendor>
```

A mismatch between a Scorecard's `corpus_version` and a Baseline's must fail loudly and refuse to
compute a delta. Silent re-scoring against a different Judge is the single most dangerous failure
mode available to this framework, because it produces a confident and completely fictitious number.

Vendors do not reliably publish frozen dated aliases for the Judge tier chosen. Mitigation: record
the API-reported model version and the wall-clock timestamp in every Scorecard, so drift is at
least detectable after the fact.

### Eval Case format

A single declarative format serves both tiers, discriminated by `tier`. Shape (decision-bearing
parts only — this is not the full schema):

```
EvalCase
  id            stable, appears in the Scorecard
  tier          "l2" | "l3"
  agent         which Agent in the Eval Soul answers
  input         the Message(s) that open the Conversation
  tools         L2 only: the faked Tool responses, in order
  expect        Expectation[]        deterministic, model-free
  rubric?       Judge criteria     only where prose quality is the point
  trials        default 1; raised for cases used to measure the Noise Floor
```

Expectations are declarative and evaluated by a pure function, so that a case is data rather than
code. This is what allows the Corpus to be content-hashed meaningfully.

### Tiers

**L2** — one Turn through the real Context assembler and the real Tool loop with a real model, faked
Tools and storage. In-process, no database. This is the spine and carries the majority of cases. An
existing adversarial-security harness in the agent-runtime test tree is close to the required
scaffold and is the starting point. The assembler is included deliberately — see the seams caveat
above; without it the tier does not measure Context at all.

**L3** — a multi-Turn journey against a real database and the Eval Soul, asserting on persisted
state. Deliberately a small tier. Investigation established:

- *Cheaper than feared:* migrations already run programmatically against in-process PGlite, so no
  Docker Postgres is needed; and pg-boss is not required, because the Chat executor is invoked
  synchronously.
- *More expensive than feared:* the Chat executor needs roughly a dozen ports, and reusable fakes
  exist for only two of them. Existing tests use inline stubs, so six to eight fakes must be
  written and made reusable.
- Soul writes must go through the Soul writer, which requires a **real git repository** — the
  Eval Soul fixture must therefore be initialised as one.
- Two pieces of prior art bracket the gap: an API-side test that runs real PGlite and real stores
  without a worker, and a worker-side test that runs a real worker without Chat submission. **The
  missing bridge between those two is the bulk of the L3 cost.**

Estimated at 3–6 engineer-days. Research recommended dropping L3 and shipping L2-only; the
developer explicitly overrode that, judging the end-to-end proof worth the cost. Recorded here so
the tradeoff is not silently relitigated later.

### Eval Soul

A frozen fixture Soul directory, version controlled, initialised as a git repository, containing
its own Agents, Skills, Resource types, Routines and guardrails. It lives **outside** the runtime
`soul/` repo. Hand-authoring it is permitted precisely because it is a fixture and not the runtime
Soul — the product-surfaces rule constrains the latter only.

### Access control

GitHub Actions `workflow_dispatch` gated on a protected Environment with required reviewers.
Credentials are held as Environment secrets, never repository secrets, so no ordinary workflow can
read them.

`pull_request_target` must not appear anywhere near this workflow — on a public repository it is
the standard path by which a fork obtains secrets, and it would defeat the entire control.

Credentials are read directly from environment variables by the provider layer, which strips the
`env://` prefix and reads `process.env` verbatim. **Variable names must match exactly.** The
existing bootstrap-seeding variable is unrelated and is not a valid target for `env://`.

Vendor-side spend limits are required in addition to the reviewer gate: the gate stops casual
triggering, but it does not stop a runaway loop inside an approved Sweep.

### Advisory, not a gate

v1 reports and does not block. Promotion to a gate is a later decision, permitted only once the
Noise Floor is known — because a gate whose threshold sits inside the noise band trains
maintainers to ignore it, which is worse than having no gate at all.

### Removal

The existing `evals` module in agent-runtime is deleted. It addresses an unrelated concern — gating
the publication of user-authored Agents — and has zero call sites outside its own test. Keeping a
second thing called "eval" guarantees confusion. Its removal is safe to prove by typecheck rather
than by running consumer suites, since a broken consumer would be a compile error.

## Testing Decisions

**What makes a good test here.** Test observable behaviour at the boundary, never internals. For
this framework specifically, the boundary is: *given a Corpus and a scripted model, does the runner
produce the correct Scorecard?* Tests must not assert on how the runner iterated, what it logged,
or in what order it assembled things. A test that breaks when the runner is refactored but the
Scorecard is unchanged is a bad test and should be deleted rather than repaired.

**The framework's own tests must never call a real model.** Every test in this list runs against a
scripted `ModelPort`, is free, is deterministic, and runs in the ordinary Vitest suite that every
contributor and CI job runs. Real model calls happen only inside a Sweep, which is never part of
the normal test suite. This is what lets contributors without credentials develop the framework.

Modules under test, and what each proves:

1. **Scorer** — pure function, tested by direct call. Each Expectation kind against passing,
   failing and malformed input. Highest test density in the framework, because it is pure, free and
   is where correctness of every verdict ultimately rests.
2. **Corpus loader and hasher** — that a semantic change to a case changes the hash, that
   reordering or reformatting without semantic change does not, and that Judge identity is folded
   into the version string.
3. **Eval runner entry (the one new seam)** — driven end-to-end with a scripted model: correct
   Scorecard for all-pass, mixed and all-fail Corpora; that a single case failure does not abort
   the Sweep; that a transient vendor error is retried and classified separately from a case
   failure; that the spend ceiling aborts; that per-case cost is attributed correctly.
4. **Baseline comparison** — the delta arithmetic; that a `corpus_version` mismatch refuses to
   produce a delta and fails loudly; that a delta inside the noise band is reported as *no signal*
   and not as an improvement.
5. **Judge adapter** — with a scripted model standing in for the Judge: rubric-to-prompt
   construction, verdict parsing, and that a malformed or failed Judge response surfaces as an
   error rather than a zero score.
6. **Model pinning** — that the constructed port bypasses Model Profile selection and the Effort
   router, asserted by observing what the port receives rather than by inspecting internals.
7. **L3 execution harness** — against in-process PGlite with the Eval Soul, that a journey drives
   real Turns and that state Expectations read genuinely persisted state.

**Prior art to follow.** The adversarial-security harness in the agent-runtime test tree is the
model for L2 — a scripted model plus scripted broker, so each case declares only what it is
exercising. For L3, two existing tests bracket the target: an API-side test running real PGlite
with real stores and no worker, and a worker-side test running a real worker without Chat
submission. The existing testkit fakes are the base for the scripted model and Tool adapters.

**Verification tiers.** Per the repository's standard: Biome after each edit, then filtered
typecheck plus filtered Vitest per touched workspace. The full root suite is not warranted — this
work adds a new workspace and touches agent-runtime; it is not a repo-wide change. Deletion of the
old module is proven by typecheck, not by running consumer suites.

## Out of Scope

- **Online and production evaluation.** No live traffic sampling, no production scoring, no A/B
  infrastructure. Offline only.
- **Blocking releases.** v1 is advisory. Becoming a gate is a later decision, and one that is not
  permitted to be made before the Noise Floor is known.
- **Scheduled or per-commit runs.** Manual trigger only. Every Sweep is a deliberate, approved,
  paid act.
- **Comparing the two models against each other.** They are a control on the harness measurement.
  Producing a "which model is better" verdict is explicitly not a goal and the Scorecard should
  not invite that reading.
- **Evaluating user-authored Agents or Soul configurations.** The subject is the harness. That
  other concern is what the deleted module attempted; it is not revived here.
- **Adding sampling controls to the model path.** Sequenced deliberately after the Noise Floor is
  measured, so the decision is made on evidence.
- **Any third model, or any additional vendor**, beyond the two under test and the Judge.
- **A UI.** The Scorecard is a file and a CI summary. No product surface renders it.

## Further Notes

**This framework has never existed here before, in a specific sense worth stating plainly: no CI
job in this repository has ever called a real LLM.** This effort introduces the first one, into a
**public** repository. The access-control decisions are therefore not ceremony — they are the
precondition that makes the rest of the work safe to merge at all.

**No record/replay or cassette mechanism exists anywhere in the codebase.** Every Sweep pays real
vendor cost. Recorded because the natural instinct on reading the cost ceiling is to reach for
replay, and the reader should know it would be built from nothing.

**Watch for a silent credential fallback.** The provider layer falls back to the shared deployment
credential when a principal has no usable one, without surfacing it. If Sweeps run under a
principal, this is a live confound: a Scorecard could be measuring a different account, and
possibly a different model, than the maintainer believes. Whether Sweeps use a principal at all is
still open.

**Prompt caching is not currently a confound**, because the cache decision is never invoked on the
loop's model seam. The corollary is that the hoped-for cost saving from caching is also not
available for free.

**Token accounting has a trap.** Usage reports carry a cached-input figure that is a *breakdown of*
the input count, not an addend to it. Adding them double-counts. Separately, CLI-adapter usage
reports are running totals rather than per-call deltas and must never be summed.

**Sequencing.** *Superseded — see Delivery status.* At writing, four tickets were takeable: remove
the old module, site the eval workspace, design the Eval Case format, and set up the maintainer-only
trigger. Three of those have landed. The fourth — the protected GitHub Environment and its three
credentials — is browser work that cannot be delegated, and the developer has deferred it until
push time. Nothing downstream waits on it before ticket 12, which is precisely why it is the kind
of task that gets discovered on release day if left alone. **It is now the oldest open item in the
plan.**
