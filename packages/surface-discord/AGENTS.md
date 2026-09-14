# TSP Discord Renderer (`@tulipfarm/surface-discord`)

Produces Discord message payloads from validated Surface Artifacts.

## Read on / Skip

- **Read on if** you touch Discord message rendering or its manifest.
- **Skip if** you change TSP contracts; use [`../surface/AGENTS.md`](../surface/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Discord renderer implementation. |
| `src/manifest.ts` | Renderer manifest metadata. |

## Rules

- Keep payloads dependency-free; no Discord SDK or network calls.
- Unsupported presentation must degrade to readable text.
