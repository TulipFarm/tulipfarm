# Agent Runtime — Agent Conventions

`@tulipfarm/agent-runtime` — Context assembly, iterative model/tool loop, model profiles,
compaction, budgets, and delegation orchestration. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

## Layout

| Path | What |
| --- | --- |
| `src/ports/model.ts` | Provider-neutral model invocation boundary. |
| `src/models/` | ModelProfile routing, constraint-equivalent fallback chains, usage/cost evidence. |
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

## Prompt inputs are declared structurally

`src/context/assemble.ts` names only the fields it renders (`MemoryEntry`, `GovernancePage`,
`AvailableSkill`, `SoulCatalogue`, …) instead of importing a store's record type. Two reasons, both
binding: assembly runs in the Worker, which may not import an application; and a store record
carries ids, versions, and timestamps that must never reach a prompt. A richer record still assigns
to these shapes unchanged, so the caller converts nothing — it just cannot over-share.

Each block owns its own char budget and is dropped **whole** when over it, never half-rendered, so
the cacheable prefix cannot drift mid-block (AC-V1-001).

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
