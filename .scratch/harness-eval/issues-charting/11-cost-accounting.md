# Cost accounting and the $5 ceiling

Type: task
Status: open
Blocked by: 08

## Question

Make the budget real: measure what a run costs, and stop it before it overruns.

Charting set ~$5 per full run — both tiers, both models, every run. A ceiling nobody measures is a
wish, and the first surprise bill is how a pre-release eval quietly stops being triggered.

`ModelUsage` (`packages/llm/src/ports/model.ts`) already carries token counts, cache reads and
`costUsd`, and `packages/llm/src/pricing.ts` holds pricing helpers — so the source exists. Note the
package rule that CLI usage reports are **running totals, not deltas**, and must never be summed;
confirm which shape the API path reports before adding anything up.

Deliver:

- Per-case and per-run cost in the report, split by model and by tier.
- A hard ceiling. When projected spend exceeds it, the run **aborts** and reports a partial result
  clearly marked partial. A partial run must never be comparable to a full baseline, and must never
  be silently written as one.
- A dry-run mode that estimates cost from the corpus without calling any model, so a maintainer can
  see the bill before authorising it — this is what the CI job shows a reviewer before they approve.
- Cache accounting kept honest: cached input tokens are a *breakdown*, not an addend
  (`packages/llm/AGENTS.md`). Getting this wrong makes cached runs look free and inflates apparent
  savings.
- Real measured numbers written back to the map, replacing charting's estimates of ~2 cents an L2
  case and 20-50 cents an L3 journey. Those were guesses and should not survive contact with data.

Then answer the question those numbers raise: at real prices, does $5 still buy a corpus big
enough to see a signal? If not, say so — that reopens the tier/budget trade rather than quietly
shrinking the corpus.
