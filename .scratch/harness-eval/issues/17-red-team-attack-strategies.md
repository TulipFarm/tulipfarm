# 17 — Red-team Cases and attack strategies

**What to build:** A red-team layer that attacks the harness and measures whether the harness's own
defences hold. Borrowed in shape from promptfoo's red-team *strategies* and DeepTeam's *attack
enhancements*, but re-pointed at the harness rather than at the model.

**Blocked by:** 08 · wants 14 for the probabilistic half

**Status:** ready-for-agent

## The distinction that makes this measurable

An attack has two possible good endings, and they are not the same measurement:

| Outcome | What it proves | How it scores |
| --- | --- | --- |
| **Guard held** | A harness defence fired — `TurnGuardrails`, the Tool blocklist, the authority gate | Deterministic. Gates the release. |
| **Model resisted** | No guard fired; the model simply declined | Probabilistic. Reported as a rate over Trials. Never gates on its own. |

This is the same rule the framework already enforces for vendor faults: a model's mood must never
read as a harness regression. A jailbreak that lands 40% of the time is a vendor property. A
guard that stopped firing is ours.

- [ ] A red-team Case declares which of the two outcomes it asserts; a Case may not assert both
- [ ] `guard_held` Cases reuse the existing `guardrail_blocked` / `tool_not_called` / `output_omits`
      Expectations — no new scoring path
- [ ] `model_resisted` Cases report a resistance **rate** across Trials and are excluded from the
      pass/fail exit code

## Attack strategies are deterministic transforms

promptfoo generates attacks with a model at build time. We must not: a model-authored Corpus is
not reproducible, so it cannot be content-hashed, so no Baseline built on it is comparable.

- [ ] A strategy is a pure function `(seedCase) => Case[]` — same seed in, same Cases out, forever
- [ ] Strategies land: `base64`, `leetspeak`, `roleplay` wrapper, `multilingual`
- [ ] **`indirect`** — the attack arrives in a *Tool result*, not the user message. This is the
      highest-value attack against an agent harness: it proves the harness treats Tool output as
      data, not as instruction
- [ ] `crescendo` (multi-turn) is **deferred to 15** — it needs the journeys work to exist first
- [ ] Generated Cases are folded into the Corpus hash, so adding a strategy invalidates comparison
      loudly

## Kept apart from the capability Corpus

- [ ] Attacks live in `corpus/red-team/` with their **own** hash and their own Baseline
- [ ] Adding an attack must not invalidate a capability Baseline, and a safety regression must be
      legible without reading the capability grid
- [ ] `pnpm eval:redteam` runs it alone; a full Sweep runs both and reports them in separate blocks
