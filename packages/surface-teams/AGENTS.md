# TSP Teams Renderer (`@tulipfarm/surface-teams`)

Produces Microsoft Teams Adaptive Card message payloads from validated Surface Artifacts.

## Read on / Skip

- **Read on if** you touch Teams message rendering or its manifest.
- **Skip if** you change TSP contracts; use [`../surface/AGENTS.md`](../surface/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Teams renderer implementation. |
| `src/manifest.ts` | Renderer manifest metadata. |

## Rules

- Keep payloads dependency-free; no Teams SDK or network calls.
- Unsupported presentation must degrade to readable text.
