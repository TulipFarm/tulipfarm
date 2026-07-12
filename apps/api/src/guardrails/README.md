# Guardrails (GR-V1-001/002)

Three-stage safety framework wrapping the chat orchestrator: **input**, **tool-call**,
**output**. Pattern-only guards (no LLM call) → fits the hot path. Spec:
`docs/plans/2026-06-11-guardrails-framework-design.md` · requirements: `specs/GUARDRAILS.md`.

## Pieces
- `pipeline.ts` — `runStage(guards, input, ctx, log)`. Guards run in array order and return
  `pass | transform | block`. First `block` short-circuits. Each guard is bounded by a 5s
  timeout; a timeout **or** a thrown error is logged and treated as `pass` (a slow/buggy guard
  can never stall or crash a turn). `transform` feeds its value to the next guard.
- `service.ts` — `GuardrailsService`. `init(raw, log)` validates the config and rebuilds the
  guard arrays into locals before swapping (a bad reload can't corrupt running state). An
  absent **or** invalid config falls back to `DEFAULT_GUARDRAILS` — **fail-safe to the default
  policy, never unguarded, never crashing**. Exposes `runInput` / `runToolCall` / `runOutput`.
- `default-policy.ts` — `DEFAULT_GUARDRAILS` (used when `soul/guardrails.yaml` is absent).
- `guards/` — `prompt-injection` (input, sensitivity-tiered regex), `content-filter` (output,
  regex + Luhn for credit cards), `tool-blocklist` (tool-call, name/wildcard/tier-category).
- `reload.ts` — `registerGuardrailsReload`: re-inits on the `soul.synced` git event.

## Config (`soul/guardrails.yaml`, optional)
Validated by `@tulipfarm/schema` (`validateGuardrailsConfig`, TypeBox→JSON-Schema + AJV —
never Zod). Top-level keys are stages; each is an ordered array. Strict per-stage guard unions:
a guard in the wrong stage / an unknown guard / a bad enum fails validation.
```yaml
input:      [{ guard: prompt_injection, sensitivity: medium }]   # low|medium|high
tool-call:  [{ guard: tool_blocklist, block: [run_command, "fs_*"] }]
output:     [{ guard: content_filter, patterns: [credit_card, ssn, api_key, email] }]
```

## Wiring (live chat path)
- **input** — `chat/turn.ts`, before `streamText`. Block → `guardrail_block`(input) + `finish`,
  skip the model. Pass/transform → the transformed text is sent to the LLM (the persisted user
  turn keeps the original).
- **tool-call** — `tools/registry.ts` `buildToolSet` callback, before the approval gate. Block →
  a denial `ToolCallResult` the LLM sees (the turn continues); no `guardrail_block` SSE.
- **output** — `chat/producer.ts` buffers each assistant text segment and scans it before
  emitting. Block → drop the text, emit `guardrail_block`(output) + `finish`, suppress the rest.
- Boot: `index.ts` constructs the service, `init`s it after `buildApp`, and registers reload.
  When the service isn't wired, every hook is a no-op (unchanged behaviour).

## Known V1 limitations (deferred)
On an **output** block the text is suppressed from the SSE/UI, but `onStepFinish` persistence and
`onFinish` knowledge-indexing run independently — so the blocked text may still be stored/indexed
unscrubbed. A timed-out guard's promise is abandoned (fine for sync regex guards). No settings
UI / config route (hand-edit `soul/guardrails.yaml`). No `ai_disclosure`/`high_risk_domain`/LLM
moderation (AC-V1-005, post-V1).
