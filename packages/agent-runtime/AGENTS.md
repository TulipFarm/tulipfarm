# Agent runtime (`@tulipfarm/agent-runtime`)
Context assembly, model routing, guarded model/tool loops, skill resolution, and helper Agent
orchestration. It owns prompt assembly and runtime control, not model providers.

## Read on / Skip
- **Read on if** you touch Context manifests, guardrails, model routing, skill lookup, Tool loop,
  delegation, streaming model events, or runtime eval activation.
- **Skip if** you touch provider clients (`../llm/AGENTS.md`), Run persistence
  (`../run-kernel/AGENTS.md`), Tool execution (`../tool-broker/AGENTS.md`), or app workers.

## Map
| Path | Owns |
| --- | --- |
| `src/ports/model.ts` | Provider-neutral `ModelPort`; `stream` is optional. |
| `src/models/` | ModelProfile selection, Effort routing, model requirements. |
| `src/context/` | Instruction precedence, Context manifests, prompt assembly. |
| `src/guardrails/` | Input/tool/output guard stages and `DEFAULT_GUARDRAILS`. |
| `src/skills/` | Exact-version Skill resolution, trust tiers, scanning, ability intersection. |
| `src/loop/` | Bounded durable Tool loop; the broker is the only effect path. `reread.ts` puts a File an Agent read mid-Turn back in front of the model. |
| `src/delegation/` | Helper Agents as child Runs: depth, deadline and authority narrowing (`delegate.ts`), and the composition that mints and awaits the child (`composition.ts`). |
| `test/security/` | Injection and non-amplification corpus. |

## Rules
- May import only schema, authz, audit, run-kernel, tool-broker, knowledge, memory, and
  observability packages; see [dependency rules](../../docs/architecture/dependency-rules.md).
- Submit child-Run commands through `run-kernel` public ports; `run-kernel` never imports this.
- `selectModelProfile` is the only product model-selection path; keep
  `deriveModelRequirements` pure so Run replay routes identically.
- Effort `auto` uses pure signal scoring first; classifier calls happen only near thresholds.
  Bad classifier output, refusal, timeout, or error falls back to `balanced`, never `fast`.
- `EffortClassifierPort` is injected by Worker; this package must not import `@tulipfarm/llm`.
  Persist classifier decisions and replay as pinned; log `promptHash`, never prompt text.
- Effort scoring currently reads only the latest user message; keep score/signals observable.
- Prompt assembly declares rendered shapes, not store records; do not leak ids, versions, or
  timestamps into prompts. Drop over-budget blocks whole, never partially.
- Guardrails compile supplied config only; never fetch Soul. Invalid or absent config becomes
  `DEFAULT_GUARDRAILS`, and digest checks depend on `config` returning the validated policy.
- If `ModelPort.stream` exists, a missing `completed` chunk fails the turn. `AgentLoopEvent`
  carries model text only; Tool args/output stay with `ToolDispatchPort`.
- A Turn sends a File once, on the Turn it was attached to. `file_read` is the only Tool the loop
  knows by name for bytes: its `attached` result names a File, and `LoopAttachmentPort` fetches it
  *every* iteration, because that fetch is the authorization check — a revoked share has to stop
  the File on the next step, which no cached copy could do. The set is capped and held as names,
  so a resumed Turn re-authorizes rather than replaying a stale copy.
