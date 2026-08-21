# @tulipfarm/platform-tools

The platform Tools that need nothing but their own input — no Soul, no renderer, no provider
credential — so both the control plane and the durable runtime can execute them.

## Read on / Skip

**Read on** if you are adding a platform Tool, changing artifact validation, or changing what a
Routine State reports on completion.

**Skip** if the Tool you are touching reads the Soul (`load_skill`, `delegate_to_agent`,
`trigger_routine`, …) — those stay in `apps/api/src/platform/tools.ts` and declare
`requiresAmbient: ["soul"]`.

## Map

| Path | Owns |
| --- | --- |
| `src/tools.ts` | `validate_artifact`, `complete_state`, `complete_task`, `get_current_time` and `PLATFORM_RUNTIME_TOOLS` |
| `src/tool-result.ts` | The `ok`/`err` result shape these Tools return |

## Rules

- A Tool belongs here only if its handler reads nothing beyond its input and
  `PlatformRuntimeContext`. Reaching for ambient state is what makes a Tool remote-only; if you
  need it, declare `requiresAmbient` and leave the Tool in `apps/api`.
- `apps/api/src/platform/tools.ts` composes `PLATFORM_RUNTIME_TOOLS` into `PLATFORM_TOOLS`, and
  `apps/worker/src/tools/local-host.ts` hosts it in process. One declaration, two hosts — never
  copy a Tool into either.

See [`packages/tool-host/src/eligibility.ts`](../tool-host/src/eligibility.ts) for the admission
rule that decides where a Tool may run.
