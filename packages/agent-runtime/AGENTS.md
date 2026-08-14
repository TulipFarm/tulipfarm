# Agent Runtime — Agent Conventions

`@tulipfarm/agent-runtime` — Context assembly, iterative model/tool loop, model profiles,
compaction, budgets, and delegation orchestration. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

## Layout

| Path | What |
| --- | --- |
| `src/ports/model.ts` | Provider-neutral model invocation boundary. |
| `src/models/` | ModelProfile routing, constraint-equivalent fallback chains, usage/cost evidence. `selectModelProfile` is the **only** model-selection path in the product; `deriveModelRequirements` turns one invocation into the requirements it is checked against, and must stay pure so replaying a Run routes identically. |
| `src/context/` | Instruction precedence, Context manifests, and system-prompt assembly (`assembleSystemPrompt` + the `<governance-knowledge>` block). |
| `src/guardrails/` | The 3 guard stages (input / tool-call / output), pattern guards, and the `DEFAULT_GUARDRAILS` fail-safe. |
| `src/skills/` | Skill resolution: exact versions, trust tiers, scanning, ability intersection. |
| `src/loop/` | Bounded durable Tool loop + checkpoints; the broker is the only effect path. |
| `src/delegation/` | Helper Agents as child Runs: read-only start, narrowing, detach, Artifacts. |
| `src/evals/` | Versioned eval suites and the publication activation gate. |
| `test/security/` | Adversarial injection / non-amplification corpus. |

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`,
`@tulipfarm/run-kernel`, `@tulipfarm/tool-broker`, `@tulipfarm/knowledge`, `@tulipfarm/memory`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This
package submits child-Run commands through the public `run-kernel` port; `run-kernel` never
imports this package.

## `auto` is inferred by a two-stage funnel, and only the cheap stage always runs

`effort-signals.ts` + `effort-router.ts` resolve the Effort Preset `auto` to an Effort Rung
(`fast` | `balanced` | `thorough`) from the participant's own words. Every other selector is passed
through untouched — a participant who picked a rung gets it.

- **Stage 1 is free and pure.** `EFFORT_SIGNALS` is an exported array of
  `{ name, weight, test(features) }`, so the scoring policy is config you can read, reweight, or
  delete a line from — not branches to unpick. `scoreEffortSignals` sums the weights of the signals
  that fired against a single precomputed `PromptFeatures`, so no signal re-scans the string.
- **Stage 2 costs one small call, and most prompts never reach it.** `routeByScore` answers
  `unsure` only inside a narrow `EFFORT_UNSURE_MARGIN` either side of each threshold. Ambiguity
  lives at the boundaries; a score dead-centre in `balanced` is the most confident `balanced` there
  is, and paying a model to confirm it would buy nothing.
- **Every unexpected classifier answer means `balanced`.** A wrong word, an empty string, prose, a
  refusal, a timeout, a thrown provider error — all resolve to `EFFORT_CLASSIFIER_FALLBACK`. Never
  `fast`, which answers a hard question weakly; never `thorough`, where one parser bug quietly bills
  every ambiguous turn at the top rung.
- **The classifier arrives as `EffortClassifierPort`.** This package may not import
  `@tulipfarm/llm`, and the decision does not need a provider — only an answer. The Worker supplies
  the hand that makes the call (`apps/worker/src/effort-classifier.ts`).
- **Determinism is bought back by pinning, not by pretending.** Stage 1 replays identically. Stage 2
  does not, so the Worker records the decision on `model.routed` and a replayed attempt passes it
  back as `pinned` — `route` short-circuits on it and never calls the classifier twice for one Run.
  This is what keeps the `deriveModelRequirements` invariant intact.
- **Hash, never the prompt.** `EffortRoutingDecision` carries `promptHash` (SHA-256), the score, the
  signals that fired, the band, and whether stage 2 ran. It lands in a durable, operator-visible
  event; the text does not. `EffortRoutingLogger` is a calibration hook — wired now, consumed later.

Known limit, recorded rather than papered over: only the latest user message is scored, so a terse
follow-up in a hard thread scores low. Scoring the transcript instead would make effort climb with
conversation age rather than with difficulty, which is worse. The recorded score and signals are
exactly the data needed to fix this properly.

## Prompt inputs are declared structurally

`src/context/assemble.ts` names only the fields it renders (`MemoryEntry`, `GovernancePage`,
`AvailableSkill`, `SoulCatalogue`, …) instead of importing a store's record type. Two reasons, both
binding: assembly runs in the Worker, which may not import an application; and a store record
carries ids, versions, and timestamps that must never reach a prompt. A richer record still assigns
to these shapes unchanged, so the caller converts nothing — it just cannot over-share.

Each block owns its own char budget and is dropped **whole** when over it, never half-rendered, so
the cacheable prefix cannot drift mid-block.

## Guardrails compile a policy; they never fetch one

`GuardrailsService.init` takes the raw config and builds the three stages; nothing in this package
reads the Soul. `revision` (the canonical hash) and `config` (the policy it hashed) are both public
so a second process can rebuild the *identical* guards and prove it did: the API resolves the
policy, ships it with the Context, and the Worker's `TurnGuardrails` refuses to execute a turn whose
`guardrailDigest` does not match the revision it just compiled. Keep `config` returning the
validated policy — an invalid or absent one falls back to `DEFAULT_GUARDRAILS`, so this getter never
answers "unguarded", and the digest check downstream depends on that.

## `ModelPort.stream` is optional

An adapter that cannot stream implements `invoke` alone and the loop falls back to it — losing the
live text, never a result. When `stream` is present the loop emits `text_delta` events during the
call, which is what lets a participant on any channel watch the answer form. A stream that ends
without its `completed` chunk is a broken adapter and fails the turn rather than being read as an
empty answer.

Model text is the **only** content `AgentLoopEvent` carries. Tool arguments and Tool output stay
out: the caller's `ToolDispatchPort` holds both already, so it decides there what a channel may
see. That is why a secret passed as a Tool argument cannot reach a reader through this stream —
keep it that way.
