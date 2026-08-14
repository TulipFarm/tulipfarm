# TSP Telegram Renderer (`@tulipfarm/surface-telegram`)

Produces native Telegram message entities and inline keyboards from validated Surface Artifacts.

## Read on / Skip

- **Read on if** you touch Telegram message output, inline keyboards, or callback handling.
- **Skip if** you change TSP contracts; use [`../surface/AGENTS.md`](../surface/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Telegram renderer implementation. |
| `src/manifest.ts` | Renderer manifest metadata. |

## Rules

- Never accept or render agent-authored markup, styles, scripts, or component code.
- Callback data must use short server-stored handles.
