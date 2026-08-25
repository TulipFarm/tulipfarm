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
| `src/context/` | Instruction precedence, Context manifests, prompt assembly, and the Soul reminder — the one per-Turn message telling an Agent what its Soul holds, narrowed to what the subject may reach. |
| `src/guardrails/` | The four guard stages — `input`, `tool-call`, `tool-result`, `output` — and `DEFAULT_GUARDRAILS`. `tool-result` screens what a Tool brought back, which is attacker-controlled whenever the Tool talked to the network. |
| `src/skills/` | Exact-version Skill resolution, trust tiers, scanning, ability intersection. |
| `src/loop/` | Bounded durable Tool loop; the broker is the only effect path. `reread.ts` puts a File an Agent read mid-Turn back in front of the model. `diagnostics.ts` owns the barrier identities — a Tool named there ends the Turn on its *identity*, with no repair path, so a hand-off or a pause can never be narrated as done, and a write can never land behind a report the participant already keeps. `narrowing.ts` narrows the offer to a Skill's scope but never hides a mutating Tool. `distill.ts` declares `ToolResultDistillerPort` and decides when a large Tool result is summarised before the model reads it — the port is implemented in `apps/worker`, because this package may not import `@tulipfarm/llm`. |
| `src/delegation/` | Helper Agents as child Runs: depth, deadline and authority narrowing (`delegate.ts`), the composition that mints and awaits a Soul-defined helper (`composition.ts`), and ad-hoc helpers whose persona the caller writes inline (`subagent.ts`). |
| `test/security/` | Injection and non-amplification corpus. |

## Rules
- May import only schema, authz, audit, run-kernel, tool-broker, knowledge, memory, and
  observability packages; see [dependency rules](../../docs/architecture/dependency-rules.md).
- Submit child-Run commands through `run-kernel` public ports; `run-kernel` never imports this.
- `composition.delegate` must re-read the child's status *after* writing the link. The child is
  claimable the moment it is minted, so it can finish before the link exists; a helper that already
  terminated is answered directly rather than parked on a signal nothing can now raise.
- `createSubagentSpawning` always sends `tools` explicitly, empty list included. Omitting it makes
  `narrowChildAuthority` inherit the parent's whole read-only set, and a caller that named no Tools
  must get a helper that holds none — which is also what the API's Context resolver offers it.
- An ad-hoc persona is what a helper is *told*, never what it may *do*. Keep it out of the
  authority path, or a model widens its own reach by writing itself kinder instructions.
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
- After `load_skill`, every dispatch carries `activeSkillName`; the Tool Host consumes it as
  authorization context, while model-visible Tool narrowing remains presentation-only.
- A Turn sends a File once, on the Turn it was attached to. `file_read` is the only Tool the loop
  knows by name for bytes: its `attached` result names a File, and `LoopAttachmentPort` fetches it
  *every* iteration, because that fetch is the authorization check — a revoked share has to stop
  the File on the next step, which no cached copy could do. The set is capped and held as names,
  so a resumed Turn re-authorizes rather than replaying a stale copy.
