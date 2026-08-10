---
id: llm-fallback-resilience
area: Models fallback chain
suites: [smoke, full]
routes: ["/business/models"]
preconditions: [model provider configured]
blast_radius: read-only inspection; validation checks only, never submits provider chain writes that break live model routing config
est_minutes: 10
smoke_scenarios: [S1]
---

# Models Fallback Chains & ModelProfile Resilience

The Models surface (`/business/models`, backed by `@tulipfarm/llm` and `@tulipfarm/agent-runtime`) manages ModelProfile resolution, fallback chains by effort preset, rate limit handling, effort preset mapping (`Auto`, `Fast`, `Balanced`, `Thorough`), and token cost receipts.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Provider connections and ModelProfile mapping

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/models` | Page loads within 5s; heading `Models` |
| 2 | `expect` configured fallback rows by provider (e.g. Anthropic, OpenAI, Gemini, Ollama) | Providers rendered |
| 3 | `expect` for each fallback row and its `Connection overrides`, API key references are short names (e.g. `anthropic-api-key`), **never a raw secret string** | Secret masking holds |
| 4 | `expect` "What each effort means" section renders four effort preset targets (`Auto resolves to`, `Fast`, `Balanced`, `Thorough`) | Effort presets rendered |
| 5 | `expect` pricing/limit facts (cost per Mtok, context window size, tool/vision capability) render per row when pinned | Model specs present |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S2 — Fallback chain ordering and validation

| # | Action | Expected |
| --- | --- | --- |
| 1 | Inspect fallback chain panels (Fast / Balanced / Thorough) | Shows ordered list of primary and secondary fallback providers |
| 2 | `click` `Add fallback` on one effort panel | A `Model` sheet opens with fields `Provider`, `Model ID`, `Pricing and limits`, and optional `Connection overrides` |
| 3 | Leave `Model ID` empty, close the sheet, and `click` `Save changes` | Inline validation error surfaces; no network write fired |
| 4 | `click` the temporary row's remove button to cancel out | Form returns to original state; no write committed |
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
| 1 | Tab through effort panels, `Add fallback`, the Model sheet fields, effort selectors, and fallback chain controls | Focus rings visible on all elements |
| 2 | Toggle between Light and Dark themes | Provider badges, spec labels, and model receipt cards remain legible |
| 3 | Resize viewport to 375px mobile width | Provider cards stack; chain lists scroll cleanly without body overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- Do not submit modified provider chains on `/business/models` during QA runs to prevent breaking live model routing.
- Confirm raw secret values are masked on all provider rows.
