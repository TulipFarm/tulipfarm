# TSP Telegram Renderer (`@tulipfarm/surface-telegram`)

Produces Telegram message payloads from validated Surface Artifacts.

## Read on / Skip

- **Read on if** you touch Telegram message rendering or its manifest.
- **Skip if** you change TSP contracts; use [`../surface/AGENTS.md`](../surface/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Telegram renderer implementation. |
| `src/manifest.ts` | Renderer manifest metadata. |

## Rules

- Keep payloads dependency-free; no Telegram SDK or network calls.
- Telegram is the fallback floor: every valid Artifact must remain readable.
