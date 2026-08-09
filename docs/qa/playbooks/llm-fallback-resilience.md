---
id: llm-fallback-resilience
area: LLM Fallback Chain
suites: [smoke, full]
routes: ["/settings/llm"]
preconditions: [LLM provider configured]
blast_radius: read-only inspection; validation checks only, never submits provider chain writes that break live LLM config
est_minutes: 10
smoke_scenarios: [S1]
---

# LLM Fallback Chains & ModelProfile Resilience

The LLM Resilience surface (`/settings/llm`, backed by `@tulipfarm/llm` and `@tulipfarm/agent-runtime`) manages ModelProfile resolution, tiered fallback chains (OpenAI, Anthropic, Gemini, Ollama), rate limit handling, effort preset mapping (`Auto`, `Fast`, `Balanced`, `Thorough`), and token cost receipts.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Provider connections and ModelProfile mapping

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/llm` | Page loads within 5s; heading `LLM` |
| 2 | `expect` configured providers list (e.g. Anthropic, OpenAI, Gemini, Ollama) | Providers rendered |
| 3 | `expect` for each provider row, API key ref displays short reference name (e.g. `anthropic-api-key`), **never a raw secret string** | Secret masking holds |
| 4 | `expect` Effort Presets section renders four ModelProfile targets (`Auto default`, `Fast`, `Balanced`, `Thorough`) | Effort presets rendered |
| 5 | `expect` spec badges (cost per 1k tokens, context window size, modalities supported) render per preset | Model specs present |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S2 — Tiered fallback chain ordering and validation

| # | Action | Expected |
| --- | --- | --- |
| 1 | Inspect **Provider Chains** section (Fast / Balanced / Thorough fieldsets) | Shows ordered list of primary and secondary fallback providers |
| 2 | `click` `+ Add provider to fallback chain` on one fieldset | New empty row appears with `provider` select and `model` text field |
| 3 | Leave `model` field empty and `click` `Save` | Inline validation error surfaces; no network write fired |
| 4 | `click` `Remove` on the temporary row to cancel out | Form returns to original state; no write committed |
| 5 | `expect` live provider chain configuration remains completely untouched | Live config preserved |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S3 — Model call receipts & effort escalation in Chat

| # | Action | Expected |
| --- | --- | --- |
| 1 | In Chat (`/`), send `qa-<run-id> test effort response` with preset `Fast` | Turn completes |
| 2 | Inspect assistant reply receipt metadata ("Answered by ...") | Receipt displays Model ID, effort preset applied (`Fast`), and latency duration |
| 3 | `expect` receipt does **not** expose raw provider API key references or internal system prompts | Receipt clean |
| 4 | `click` `Try harder` action beside receipt | Turn re-runs at higher effort preset (`Balanced` / `Thorough`); original turn preserved |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S4 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through provider list, effort selectors, and fallback chain controls | Focus rings visible on all elements |
| 2 | Toggle between Light and Dark themes | Provider badges, spec labels, and model receipt cards remain legible |
| 3 | Resize viewport to 375px mobile width | Provider cards stack; chain lists scroll cleanly without body overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- Do not submit modified provider chains on `/settings/llm` during QA runs to prevent breaking live LLM routing.
- Confirm raw secret values are masked on all provider rows.
