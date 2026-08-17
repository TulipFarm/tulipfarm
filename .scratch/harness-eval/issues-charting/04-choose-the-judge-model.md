# Choose and pin the judge model

Type: research
Status: resolved
Blocked by: —

## Question

Which third-vendor model judges prose output, how is it pinned, and what happens when it dies?

Settled at charting: deterministic assertions are the backbone; LLM-as-judge covers only cases
where the output is genuinely prose with no assertable fact. The judge must be a **third** vendor —
judging Claude's output with Claude means scoring with the thing under test.

The subjects are anthropic and openai. The repo's provider switch
(`packages/llm/src/provider.ts`) supports `anthropic`, `openai`, `azure` and
`openai-compatible`, plus subscription-CLI adapters `claude-code` and `codex`. A genuine third
vendor therefore arrives through `openai-compatible` (base_url + key) or needs a new provider case.

Answer:

1. **Which model.** Recommend a specific judge, with the reasoning. Constraints: a real third
   vendor; strong at structured rubric output; cheap, because it runs once per prose case per
   subject model; and available behind a stable, exact version string.
2. **What it costs to add.** If it needs `openai-compatible`, confirm that path works with an
   arbitrary provider and what `soul.yaml#llm` entry it needs. If it needs a new provider case,
   enumerate the full checklist from `packages/llm/AGENTS.md` (provider switch, secrets registry,
   dependency, Docker external) and be honest that this is a bigger change.
3. **Version pinning.** How is an exact, non-drifting version pinned? Aliases like `-latest` are
   disqualifying — a silent judge upgrade invalidates every historical score. Check
   `packages/llm/src/model-spec.ts` and the LiteLLM catalog it reads for whether exact versions
   are expressible.
4. **Judge determinism.** Temperature 0 and a forced structured output. What does the repo's JSON
   mode support look like (`packages/llm/src/cli/` mentions JSON mode) and is it reachable on the
   API path?
5. **Deprecation.** When the vendor retires the pinned judge, every baseline scored by it becomes
   incomparable. Propose the policy: does the judge version become part of the corpus version so a
   judge change forces a baseline reset? Say what breaks if it does not.
6. **Third key.** This adds a third API key to the protected Environment. Name the env var.

The answer is a named model with an exact version string, the config entry to reach it, the
determinism settings, and the deprecation policy.

## Answer

**Judge: `gemini-2.5-flash-lite` (Google), reached through the existing `openai-compatible`
provider. Zero new provider code — config only. Key: `GEMINI_API_KEY`. Cost is ~1% of the run
budget, i.e. effectively free.**

Verified against vendor documentation on 2026-08-17. Every claim below decays; re-verify before
relying on it.

### Why this model

Google is a genuine third vendor against anthropic + openai subjects. Flash-Lite is Google's
cost-efficient tier, aimed at high-volume structured tasks — which is exactly what a rubric judge
is. Runner-up is `gemini-2.5-flash`: same vendor, same integration path, ~3x the price
($0.75/$3.75 per M), stronger reasoning. Escalate to it only if Flash-Lite shows poor inter-rater
agreement in [Measure the noise floor](12-noise-floor.md).

### Integration: config only

Google ships a documented OpenAI-compatible endpoint
(https://ai.google.dev/gemini-api/docs/openai), and `packages/llm/src/provider.ts`'s
`case "openai-compatible"` already does exactly what is needed:

```yaml
provider: openai-compatible
base_url: https://generativelanguage.googleapis.com/v1beta/openai/
api_key_ref: env://GEMINI_API_KEY
model: gemini-2.5-flash-lite
```

No new provider case, no new dependency, no `packages/secrets/src/registry.ts` entry, no Docker
external. This is why Gemini beats vendors that would need real provider work.

### Determinism, and one code gap

`temperature: 0` is accepted through the compat layer, and thinking should be disabled
(`reasoning_effort: "none"`) for latency, cost and stability.

**Gap:** `provider.ts` calls `createOpenAICompatible({ baseURL, name, apiKey })` **without**
`supportsStructuredOutputs`, which therefore defaults to `false`. The AI SDK then never sends
`response_format: { type: "json_schema", ... }` — you get prose to parse instead of enforced
schema. The judge should therefore be instantiated **separately** from the shared `createModel`
path, with `supportsStructuredOutputs: true`. Prompt-embedded JSON schema is the zero-code
alternative and is meaningfully less robust; do not settle for it in a scorer.

Note also that temperature 0 is **not** true determinism — distributed inference and float
non-determinism mean the same output can score differently. Mitigate by treating +/-1 on a 0-5
rubric as equivalent, or re-judging borderline cases and taking the mode.

### Version pinning, and an unresolved risk

`gemini-2.5-flash-lite` is a stable GA model (released 2025-07-22, **no shutdown date announced**
on https://ai.google.dev/gemini-api/docs/deprecations). Google publishes explicitly-dated snapshots
for *preview* models but the research **could not confirm** a frozen dated alias like
`gemini-2.5-flash-lite-20250722` for this GA model, the way OpenAI publishes `gpt-4o-2024-08-06`.

That is a live risk to every historical baseline, and the mitigation must be built in:

- Record the judge model id **and the version the API reports** in every run artifact — query the
  models endpoint rather than trusting the configured string.
- Record the run timestamp, so a silent checkpoint swap is at least detectable after the fact.
- Watch https://ai.google.dev/gemini-api/docs/changelog.

Google publishes no minimum notice period for retirement. Historically GA models have had long
windows (`gemini-2.0-flash-001` ran Feb 2025 to Jun 2026) but that is precedent, not a commitment.

### Deprecation policy: judge id joins the corpus version

Adopt a composite version and make mismatch a hard failure:

```
corpus_version = <corpus-hash>:<judge-model-id>:<judge-vendor>
```

Rules for [Baseline storage and delta comparison](10-baseline-storage.md) to implement:

1. Any change to the judge id increments the corpus version and requires a full re-baseline.
2. Comparison against a baseline with a different corpus version **fails loudly**. Never silently
   re-score an old baseline with a new judge — that destroys the longitudinal record.
3. Old baselines are archived with their version, never deleted, so past releases stay auditable.
4. When a shutdown date is announced, schedule the re-baseline before it.

Without this, a judge recalibration reads as an agent regression and you act on false signal — or
worse, a judge that got stricter masks a real improvement and you do not.

### Cost

$0.25/M input, $1.50/M output, Standard tier
(https://ai.google.dev/gemini-api/docs/pricing, fetched 2026-08-17). At ~1.5K input + 200 output
tokens per judgement and 40-60 judgements per run, that is **~$0.04 per run — under 1% of the $5
budget**. Even a conservative 3K/400 estimate lands at ~$0.08. The judge is not a budget concern,
which means the runner-up upgrade stays affordable if quality demands it.
