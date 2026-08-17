# 08 — Author the L2 spine Corpus

**What to build:** Grow the Corpus from a single Case to real coverage of harness behaviour. This is
the tier that carries the bulk of the signal.

**Blocked by:** 05, 06

**Status:** done

- [x] Cases cover Tool selection, Tool argument correctness, and call ordering
- [x] Cases cover guardrail refusal, so a Context change that weakens a guardrail is caught
- [x] Cases cover structured output shape and content
- [x] Cases cover Skill narrowing of the model-visible prompt

      **Correction.** This checkbox said "model-visible Tools". The harness has no Skill-driven
      Tool narrowing — `SkillFrontmatter` carries no Tool list and nothing filters the Tool array
      by Skill. What it does narrow is the *prompt*: an eager Skill's body is rendered whole, a
      lazy Skill contributes only its name and description and its body stays behind `load_skill`.
      `support-sees-eager-skill-not-lazy-body` measures that. Inventing the Tool-narrowing feature
      to satisfy the wording would have been the eval driving the product.
- [x] Every Case passes on both models, or its failure is understood and recorded rather than left
      ambiguous
- [x] A full L2 Sweep stays inside the cost ceiling
- [x] One Case failing does not abort the Sweep — one bad Case must not cost the whole run's
      information

## What landed

Eight Cases in `apps/eval/corpus/`, all passing scripted, 13 model calls per Sweep:

| Case | What it pins |
| --- | --- |
| `support-answers-without-tools` | Tool selection: the Agent must *not* reach for a Tool |
| `triage-uses-lookup-before-reply` | Tool selection and argument correctness |
| `triage-orders-lookup-before-note` | Call ordering across two Tools |
| `triage-refund-tool-is-blocked` | Guardrail: `tool_blocklist` denies a call the model made |
| `support-refuses-prompt-injection` | Guardrail: `prompt_injection` settles the turn before the model |
| `support-blocks-a-role-override` | Guardrail: the policy's `sensitivity: high` setting itself |
| `support-never-repeats-a-card-number` | Guardrail: a card number never reaches the participant |
| `triage-reports-a-ticket-as-json` | Structured output shape and content |
| `support-sees-eager-skill-not-lazy-body` | Skill narrowing of the assembled prompt |

Supporting harness work this needed:

- **Guardrails now run in the eval turn** (`src/guardrails.ts`). The Eval Soul's `guardrails.yaml`
  is enforced by the production `TurnGuardrails`, with the digest computed exactly as
  `turn-context.ts` computes it, and refusals read back off the real `guardrail.decision` Run
  events. Before this the eval passed a fake `guardrailDigest` and ran no guards at all, so no
  guardrail Case could have existed.
- **New Expectation kinds**: `guardrail_blocked` (stage + guard), `guardrail_allowed` (stage), and
  `output_omits`.
- **`output_field_equals` reads JSON returned as text**, fenced or bare. Both models this
  framework compares are CLI subscription seats that answer in text; requiring
  `kind: "structured"` would have made the structured-output Case unpassable on either.

**Verified on both models.** Every Case that ran passed on `sonnet` and on `luna`, at Corpus
`d19ca272924436f8`. The run also found a harness bug, fixed below.

| Model | Result |
| --- | --- |
| `sonnet` | 8 of 9 Cases run, 8 passed, 0 failed, 0 errored |
| `luna` | 5 of 9 Cases run, 5 passed, 0 failed, 0 errored |

## The ceiling did not scale with the Corpus

Neither Sweep finished. `seat.sh` defaulted `--max-tokens` to a fixed 20000, chosen when the Corpus
held two Cases; nine Cases blew it. `sonnet` stopped after 8 Trials, `luna` after 5.

Nothing scored wrongly — the unrun Cases were reported as `never run` and held out of the Matrix as
`NOT COMPARABLE`, which is the designed behaviour. But that is exactly what makes the failure
dangerous: a truncated Sweep reads like a smaller Corpus, not like a mistake, and it silently
shrank the comparison to 5 of 8 Cases.

The two seats are not comparable in cost, which is why a single fixed number could not serve both:

| Seat | Input tokens per model call |
| --- | --- |
| `sonnet` | ~1.7k |
| `luna` | ~5.2k |

Fixed by making the ceiling scale with the work:

- New `--max-tokens-per-trial <n>`, multiplied by the Trials the Sweep actually plans. It survives
  the Corpus growing, a `--case` filter shrinking it, and ticket 14 adding repeat Trials.
- `plannedTrials` and `selectCases` are exported from `runner.ts` and shared with `cli.ts`, so the
  count the ceiling is sized against cannot drift from the count the Sweep runs.
- `--max-tokens` and `--max-tokens-per-trial` are mutually exclusive and refuse each other.
- `seat.sh` now defaults to `--max-tokens-per-trial 15000`, set from `luna`'s worst observed Case
  (~16k for three calls) rather than from the average.

## Review findings, resolved

`/code-review` returned seven findings. All are fixed.

| # | Finding | Fix |
| --- | --- | --- |
| 1 | `output_field_equals` mis-parsed JSON returned as text | `structuredValue` rewritten over balanced-brace candidates, 6 regression tests |
| 2 | The card-leak Case passed whether or not the guard existed | The leak is now mechanical — the Tool returns a `receiptLine` the Case tells the Agent to quote verbatim — and it asserts `guardrail_blocked` |
| 3 | `requireGrounded` skipped `output_omits`, so one could pass vacuously | `output_omits` is grounded like the rest, with its own reason text and an `ungrounded` escape |
| 4 | `stage` and `guard` accepted any string; the `guardrail_allowed` doc comment was inverted | Both fields are closed enums checked at Corpus load; the comment now says it catches an *over-eager* guard |
| 5 | `output_contains: "garden centres"` failed a model that spelled it "centers" | `output_matches: "garden cent(re\|er)s?"` |
| 6 | The blocked-refund Case relied on the model choosing to call the blocked Tool | A `lookup_ticket` result names the Tool in its `nextAction`, and the Case adds `tool_not_called: issue_refund` |
| 7 | `guardInput` discarded a guard's *transform*, sending the model text production would not have | It returns the guarded message list, mirroring `TurnDriver.guardInput` |

The review also noted that `sensitivity: high` was unpinned — the injection Case fires on a `low`
tier pattern, so the setting could be downgraded silently. `support-blocks-a-role-override` uses a
`high`-only pattern and closes that.

Each guard Case was verified to **bite**: editing `soul/guardrails.yaml` to drop the guard turns
that Case, and only that Case, red.

| Edit to the fixture policy | Case that failed |
| --- | --- |
| `sensitivity: high` → `low` | `support-blocks-a-role-override` |
| `credit_card` → `ssn` | `support-never-repeats-a-card-number` |
| blocklist `issue_refund` → `some_other_tool` | `triage-refund-tool-is-blocked` |
